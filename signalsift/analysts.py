"""Analyst expectations via yfinance (price targets, ratings, estimates)."""
import yfinance as yf

import config
from . import cache, prices


def _safe(d, *keys):
    for k in keys:
        v = d.get(k)
        if v is not None:
            return v
    return None


def expectations(ticker: str):
    """Return analyst price targets, rating mix, and earnings estimates."""
    key = f"analyst_{ticker.upper()}"
    cached = cache.get(key, config.DETAIL_TTL)
    if cached is not None:
        return cached

    ysym = prices.to_yahoo(ticker)
    result = {"ticker": ticker, "targets": {}, "rating": {}, "recommendations": [],
              "estimates": {}, "error": None}
    try:
        tk = yf.Ticker(ysym)
        info = {}
        try:
            info = tk.info or {}
        except Exception:
            info = {}

        current = _safe(info, "currentPrice", "regularMarketPrice")
        mean_t = _safe(info, "targetMeanPrice")
        result["targets"] = {
            "current": current,
            "mean": mean_t,
            "high": _safe(info, "targetHighPrice"),
            "low": _safe(info, "targetLowPrice"),
            "median": _safe(info, "targetMedianPrice"),
            "upside_pct": ((mean_t / current - 1.0) if (mean_t and current) else None),
        }
        result["rating"] = {
            "key": _safe(info, "recommendationKey"),
            "mean": _safe(info, "recommendationMean"),
            "num_analysts": _safe(info, "numberOfAnalystOpinions"),
        }

        # Recommendation trend (strongBuy/buy/hold/sell/strongSell by period).
        try:
            recs = tk.recommendations
            if recs is not None and not recs.empty:
                result["recommendations"] = recs.head(4).to_dict("records")
        except Exception:
            pass

        # Forward earnings estimates, if the yfinance build exposes them.
        try:
            est = tk.earnings_estimate
            if est is not None and not est.empty:
                result["estimates"] = est.round(3).to_dict("index")
        except Exception:
            pass

    except Exception as exc:  # noqa: BLE001 - surface any yfinance hiccup
        result["error"] = str(exc)

    cache.set(key, result)
    return result
