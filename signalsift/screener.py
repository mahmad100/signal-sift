"""Core screen: compute trailing returns for the universe and flag stalled names."""
import datetime as dt
import json
import os

import config
from . import cache, marketcaps, prices, universe

_CACHE_KEY = "screen_latest"


def _benchmark_returns(closes):
    ysym = prices.to_yahoo(config.BENCHMARK)
    if ysym in closes.columns:
        return prices.trailing_returns(closes[ysym])
    return {k: None for k in config.WINDOWS}


def _load_precomputed():
    """Load the committed precomputed screen (refreshed by the GitHub Action)."""
    path = config.PRECOMPUTED_SCREEN
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return None


def run_screen(force: bool = False) -> dict:
    """Return the screen payload.

    Precedence: fresh short-lived cache → (on serverless) committed precompute →
    live pull. On serverless we never run the slow 500-ticker pull, so cold starts
    and Refresh both serve the precomputed file the GitHub Action keeps fresh.
    """
    if not force:
        cached = cache.get(_CACHE_KEY, config.SCREEN_TTL)
        if cached:
            return cached

    if not config.LIVE_SCREEN:
        pre = _load_precomputed()
        if pre:
            cache.set(_CACHE_KEY, pre)
            return pre
        # No precompute yet — fall through and try a live pull as a last resort.

    consts = universe.get_constituents()
    tickers = [c["ticker"] for c in consts]
    meta = {c["ticker"]: c for c in consts}

    # Include the benchmark in the same batch download. Pull ~5y so the long
    # trend windows (1Y-5Y) all have a lookback price.
    closes = prices.download_closes(tickers + [config.BENCHMARK],
                                    lookback_days=config.HISTORY_LOOKBACK_DAYS)
    bench = _benchmark_returns(closes)

    rows = []
    for t in tickers:
        ysym = prices.to_yahoo(t)
        if ysym not in closes.columns:
            continue
        series = closes[ysym]
        rets = prices.trailing_returns(series)
        price = prices.latest_price(series)
        if price is None or all(v is None for v in rets.values()):
            continue

        excess = {
            k: (rets[k] - bench[k]) if (rets[k] is not None and bench[k] is not None) else None
            for k in config.WINDOWS
        }
        stalled = [k for k, v in rets.items()
                   if v is not None and v <= config.DEFAULT_STALL_CEILING]

        rows.append({
            "ticker": t,
            "name": meta[t]["name"],
            "sector": meta[t]["sector"],
            "price": round(price, 2),
            "returns": {k: rets[k] for k in config.WINDOWS},
            "excess": excess,
            "stalled_windows": stalled,
            "stall_score": len(stalled),
        })

    # Approximate index weights: implied shares (cached ~30d) × current price, so
    # market cap tracks the latest price without re-pulling the slow per-name data.
    shares = marketcaps.get_shares([r["ticker"] for r in rows])
    for r in rows:
        s = shares.get(r["ticker"])
        r["market_cap"] = int(round(s * r["price"])) if s and r["price"] else None

    payload = {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "windows": list(config.WINDOWS.keys()),
        "stall_ceiling": config.DEFAULT_STALL_CEILING,
        "benchmark": config.BENCHMARK,
        "benchmark_returns": bench,
        "universe_size": len(tickers),
        "evaluated": len(rows),
        "rows": rows,
    }
    cache.set(_CACHE_KEY, payload)
    return payload


def _resolve_ceiling(payload, ceiling):
    return payload["stall_ceiling"] if ceiling is None else ceiling


def filter_rows(payload: dict, sector: str = None, ceiling: float = None,
                status: str = "all", over: str = "1Y", sort: str = None,
                direction: str = "desc"):
    """Filter/sort the full universe for the explorer view.

    sector    : restrict to one GICS sector.
    ceiling   : stall ceiling used to classify growing vs. stalled.
    status    : 'all' | 'growing' | 'stalled' (judged over the reference window).
    over      : reference window for growth classification (e.g. '1Y').
    sort      : window label or 'stall'. Defaults to the reference window.
    direction : 'asc' | 'desc'.
    """
    windows = payload["windows"]
    if over not in windows:
        over = windows[-1]
    if sort is None:
        sort = over
    if sort != "stall" and sort not in windows:
        sort = over
    ceil = _resolve_ceiling(payload, ceiling)

    out = []
    for r in payload["rows"]:
        if ceiling is not None:
            stalled = [k for k, v in r["returns"].items()
                       if v is not None and v <= ceiling]
            score = len(stalled)
        else:
            stalled, score = r["stalled_windows"], r["stall_score"]

        ref = r["returns"].get(over)
        growing = ref is not None and ref > ceil

        if status == "growing" and not growing:
            continue
        if status == "stalled" and (ref is None or growing):
            continue
        if sector and r["sector"] != sector:
            continue

        out.append(dict(r, stalled_windows=stalled, stall_score=score,
                        growing=growing, ref_return=ref))

    def key(row):
        if sort == "stall":
            return row["stall_score"]
        v = row["returns"].get(sort)
        return v if v is not None else float("-inf")

    out.sort(key=key, reverse=(direction != "asc"))
    return out


def sector_stats(payload: dict, over: str = "1Y", ceiling: float = None):
    """Aggregate per-GICS-sector: median returns, growing vs. stalled counts."""
    import statistics

    windows = payload["windows"]
    if over not in windows:
        over = windows[-1]
    ceil = _resolve_ceiling(payload, ceiling)

    groups = {}
    for r in payload["rows"]:
        groups.setdefault(r["sector"] or "Unknown", []).append(r)

    def med(vals):
        return statistics.median(vals) if vals else None

    stats = []
    for sec, rows in groups.items():
        median_by_window = {}
        for w in windows:
            vals = [x["returns"][w] for x in rows if x["returns"].get(w) is not None]
            median_by_window[w] = med(vals)
        refs = [x["returns"][over] for x in rows if x["returns"].get(over) is not None]
        growing = sum(1 for v in refs if v > ceil)
        stalled = len(refs) - growing
        ranked = sorted(rows, key=lambda x: (x["returns"].get(over)
                        if x["returns"].get(over) is not None else float("-inf")))
        stats.append({
            "sector": sec,
            "count": len(rows),
            "median_by_window": median_by_window,
            "median_over": med(refs),
            "growing": growing,
            "stalled": stalled,
            "pct_growing": (growing / len(refs)) if refs else None,
            "best": {"ticker": ranked[-1]["ticker"],
                     "ret": ranked[-1]["returns"].get(over)} if ranked else None,
            "worst": {"ticker": ranked[0]["ticker"],
                      "ret": ranked[0]["returns"].get(over)} if ranked else None,
        })

    stats.sort(key=lambda s: (s["median_over"] if s["median_over"] is not None
                              else float("-inf")), reverse=True)
    return {
        "over": over,
        "ceiling": ceil,
        "benchmark_over": payload["benchmark_returns"].get(over),
        "windows": windows,
        "sectors": stats,
    }
