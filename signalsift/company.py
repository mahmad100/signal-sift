"""Full company profile for the pitchbook page: fundamentals, history, valuation."""
import pandas as pd
import yfinance as yf

import config
from . import analysts, cache, edgar, fundamentals, news, prices

# Bump when the profile payload shape changes (e.g. long windows in returns).
_SCHEMA = 5


def _g(info, *keys):
    for k in keys:
        v = info.get(k)
        if v is not None:
            return v
    return None


def _history_from(stock_s, bench_s, downsample=4):
    """Normalize the two 5-year Series to 100 at a shared start, for the chart.

    Downsamples (every Nth point) so ~5y of daily data stays chart-friendly.
    """
    if stock_s.empty:
        return {"series": [], "benchmark": []}
    # ~5 years ending at the latest point, and a shared start for both series.
    start = max(stock_s.index[0], stock_s.index[-1] - pd.Timedelta(days=1826))
    if not bench_s.empty:
        start = max(start, bench_s.index[0])

    def norm(s):
        s = s[s.index >= start].dropna()
        if s.empty:
            return []
        base = float(s.iloc[0])
        pts = []
        items = list(s.items())
        for i, (ts, v) in enumerate(items):
            if i % downsample and i != len(items) - 1:
                continue
            d = ts.strftime("%Y-%m-%d") if hasattr(ts, "strftime") else str(ts)
            pts.append({"t": d, "c": round(float(v), 2),
                        "n": round(float(v) / base * 100.0, 2)})
        return pts

    return {"series": norm(stock_s), "benchmark": norm(bench_s)}


def _five_year_series(ysym):
    """Cached 5-year daily close Series (or empty Series)."""
    key = f"hist5y_{ysym}"
    cached = cache.get(key, config.LONG_HISTORY_TTL)
    if cached is not None:
        return pd.Series({pd.Timestamp(k): v for k, v in cached.items()}).sort_index()
    df = prices.download_closes([ysym], lookback_days=1825)
    if df.empty or ysym not in df.columns:
        return pd.Series(dtype=float)
    s = df[ysym].dropna()
    cache.set(key, {d.strftime("%Y-%m-%d"): float(v) for d, v in s.items()})
    return s


def _pe_history(series, fund):
    """Annual P/E: fiscal year-end price ÷ that year's diluted EPS."""
    dates = (fund or {}).get("year_dates") or []
    eps = (fund or {}).get("eps") or []
    years = (fund or {}).get("years") or []
    out = {"years": [], "pe": []}
    if series.empty or not dates:
        return out
    for i, d in enumerate(dates):
        e = eps[i] if i < len(eps) else None
        px = prices._asof_price(series, pd.Timestamp(d))
        out["years"].append(years[i] if i < len(years) else d[:4])
        out["pe"].append((px / e) if (px and e and e > 0) else None)
    return out


def profile(ticker: str) -> dict:
    key = f"company_{ticker.upper()}"
    cached = cache.get(key, config.DETAIL_TTL, version=_SCHEMA)
    if cached is not None:
        return cached

    ysym = prices.to_yahoo(ticker)
    bench = prices.to_yahoo(config.BENCHMARK)
    info = {}
    try:
        info = yf.Ticker(ysym).info or {}
    except Exception:
        info = {}

    five_year = _five_year_series(ysym)
    spy_five = _five_year_series(bench)
    hist = _history_from(five_year, spy_five)
    fund = fundamentals.get(ticker)

    # Trailing returns over every window (incl. 1Y-5Y) from the 5-year series.
    rets = prices.trailing_returns(five_year) if not five_year.empty \
        else {k: None for k in config.WINDOWS}
    brets = prices.trailing_returns(spy_five) if not spy_five.empty else {}
    excess = {k: (rets[k] - brets[k]) if (rets.get(k) is not None
              and brets.get(k) is not None) else None for k in config.WINDOWS}

    price = _g(info, "currentPrice", "regularMarketPrice")
    prev = _g(info, "previousClose", "regularMarketPreviousClose")
    day_chg = (price / prev - 1.0) if (price and prev) else None

    result = {
        "ticker": ticker.upper(),
        "identity": {
            "name": _g(info, "longName", "shortName") or ticker.upper(),
            "sector": _g(info, "sector"),
            "industry": _g(info, "industry"),
            "website": _g(info, "website"),
            "employees": _g(info, "fullTimeEmployees"),
            "country": _g(info, "country"),
            "city": _g(info, "city"),
            "summary": _g(info, "longBusinessSummary"),
        },
        "market": {
            "price": price,
            "day_change": day_chg,
            "market_cap": _g(info, "marketCap"),
            "shares_out": _g(info, "sharesOutstanding"),
            "week52_high": _g(info, "fiftyTwoWeekHigh"),
            "week52_low": _g(info, "fiftyTwoWeekLow"),
            "beta": _g(info, "beta"),
            "avg_volume": _g(info, "averageVolume", "averageDailyVolume10Day"),
            "dividend_yield": _g(info, "dividendYield"),
        },
        "valuation": {
            "trailing_pe": _g(info, "trailingPE"),
            "forward_pe": _g(info, "forwardPE"),
            "peg": _g(info, "trailingPegRatio", "pegRatio"),
            "price_to_book": _g(info, "priceToBook"),
            "price_to_sales": _g(info, "priceToSalesTrailing12Months"),
            "ev_ebitda": _g(info, "enterpriseToEbitda"),
            "ev_revenue": _g(info, "enterpriseToRevenue"),
        },
        "profitability": {
            "gross_margin": _g(info, "grossMargins"),
            "operating_margin": _g(info, "operatingMargins"),
            "profit_margin": _g(info, "profitMargins"),
            "roe": _g(info, "returnOnEquity"),
            "revenue_growth": _g(info, "revenueGrowth"),
            "earnings_growth": _g(info, "earningsGrowth", "earningsQuarterlyGrowth"),
            "total_revenue": _g(info, "totalRevenue"),
            "free_cashflow": _g(info, "freeCashflow"),
        },
        "returns": rets,
        "excess": excess,
        "history": hist,
        "fundamentals": fund,
        "pe_history": _pe_history(five_year, fund),
        "analysts": analysts.expectations(ticker),
        "filings": edgar.recent_filings(ticker),
        "news": news.recent(ticker),
    }
    result["analyst_count"] = result["analysts"].get("rating", {}).get("num_analysts")
    result["why"] = _narrative(result)
    cache.set(key, result, version=_SCHEMA)
    return result


def _narrative(p):
    """A few pitchbook-style bullets framing why the stock may be stalled."""
    out = []
    r = p["returns"]
    ex = p["excess"]
    if r.get("1Y") is not None and ex.get("1Y") is not None:
        out.append(
            f"Shares are {_pct(r['1Y'])} over 12 months versus the S&P 500 — "
            f"{_pct(ex['1Y'])} on a relative basis. "
            + ("Deep relative underperformance." if ex["1Y"] < -0.15
               else "Trailing the index." if ex["1Y"] < 0 else "Roughly in line.")
        )
    tg = p["analysts"].get("targets", {})
    up = tg.get("upside_pct")
    if up is not None:
        out.append(
            f"Sell-side mean target implies {_pct(up)} from here"
            + (" — the Street sees a re-rating the tape hasn't delivered."
               if up > 0.15 else " — limited analyst headroom." if up < 0.05 else ".")
        )
    val = p["valuation"]
    if val.get("forward_pe") and val.get("trailing_pe"):
        if val["forward_pe"] < val["trailing_pe"]:
            out.append(
                f"Forward P/E ({val['forward_pe']:.1f}x) below trailing "
                f"({val['trailing_pe']:.1f}x) — earnings expected to grow into the multiple."
            )
    prof = p["profitability"]
    if prof.get("revenue_growth") is not None:
        rg = prof["revenue_growth"]
        out.append(
            f"Revenue growth of {_pct(rg)} "
            + ("may explain investor caution." if rg is not None and rg < 0.03
               else "against a flat stock hints at a valuation/sentiment gap.")
        )
    out.append("Cross-check the filings below for guidance changes, buybacks, "
               "insider activity, or litigation driving the stall.")
    return out


def _pct(v):
    return "—" if v is None else f"{'+' if v >= 0 else ''}{v * 100:.1f}%"
