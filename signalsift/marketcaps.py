"""Approximate market caps for the whole universe, for the index-weight views.

SPY is market-cap weighted, but the constituents CSV carries no cap. We store an
*implied share count* (marketCap / price at fetch) per ticker, cached ~30 days —
shares change only ~quarterly — and let the screen multiply it by the *current*
price so weights stay fresh with each price refresh without re-pulling this slow,
per-ticker data. Best-effort: a ticker we can't fetch simply gets no weight.

These are an approximation of true SPY weights, which use S&P's float-adjusted
share counts and proprietary methodology (imperfect for dual-class names).
"""
import concurrent.futures as cf

import yfinance as yf

import config
from . import cache, prices

_CACHE_KEY = "implied_shares"
_SCHEMA = "1"
_MAX_WORKERS = 8


def _fast(fi, key):
    """Read a key from yfinance FastInfo, tolerating dict- or attr-style access."""
    try:
        return fi[key]
    except Exception:  # noqa: BLE001 - FastInfo raises broadly on missing keys
        return getattr(fi, key, None)


def _implied_shares(ticker):
    """Implied total shares (marketCap / price) for one ticker, or None."""
    ysym = prices.to_yahoo(ticker)
    try:
        fi = yf.Ticker(ysym).fast_info
        mc, px, sh = _fast(fi, "market_cap"), _fast(fi, "last_price"), _fast(fi, "shares")
    except Exception:  # noqa: BLE001 - network / parsing failures are non-fatal
        return None
    try:
        if mc and px and float(px) > 0:
            return float(mc) / float(px)
        if sh:
            return float(sh)
    except (TypeError, ValueError):
        return None
    return None


def get_shares(tickers, force: bool = False) -> dict:
    """Return {ticker: implied_shares}. Cached ~30 days, fetched best-effort.

    Missing tickers are simply absent from the map (they get no weight downstream).
    """
    if not force:
        cached = cache.get(_CACHE_KEY, config.SHARES_TTL, version=_SCHEMA)
        # Reuse the cache only if it covers most of the requested universe — a
        # cache built from a smaller run (or one that mostly failed) shouldn't
        # starve a full 500-name screen of weights.
        if cached and len(cached) >= 0.8 * len(tickers):
            return cached

    out = {}
    with cf.ThreadPoolExecutor(max_workers=_MAX_WORKERS) as ex:
        futures = {ex.submit(_implied_shares, t): t for t in tickers}
        for fut in cf.as_completed(futures):
            try:
                s = fut.result()
            except Exception:  # noqa: BLE001
                s = None
            if s:
                out[futures[fut]] = s

    if out:
        cache.set(_CACHE_KEY, out, version=_SCHEMA)
    return out
