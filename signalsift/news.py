"""Recent news headlines via yfinance, with a light sentiment tag."""
import yfinance as yf

import config
from . import cache, prices

_SCHEMA = 1  # bump when the news payload shape changes

_POS = {"beat", "beats", "surge", "surges", "soar", "soars", "jump", "jumps", "rally",
        "rallies", "record", "growth", "grows", "upgrade", "upgrades", "raises",
        "raised", "strong", "gain", "gains", "profit", "wins", "win", "boost",
        "outperform", "buy", "bullish", "expands", "expansion", "top", "tops"}
_NEG = {"miss", "misses", "plunge", "plunges", "fall", "falls", "drop", "drops",
        "slump", "sinks", "cut", "cuts", "downgrade", "downgrades", "lawsuit",
        "probe", "warn", "warns", "warning", "weak", "loss", "losses", "slows",
        "slowing", "decline", "declines", "layoff", "layoffs", "recall", "sell",
        "bearish", "fraud", "investigation", "concern", "concerns", "slashes"}


def _sentiment(title: str) -> str:
    words = {w.strip(".,:;!?'\"()").lower() for w in (title or "").split()}
    pos, neg = len(words & _POS), len(words & _NEG)
    if pos > neg:
        return "positive"
    if neg > pos:
        return "negative"
    return "neutral"


def recent(ticker: str, limit: int = 12):
    key = f"news_{ticker.upper()}"
    cached = cache.get(key, config.DETAIL_TTL, version=_SCHEMA)
    if cached is not None:
        return cached

    ysym = prices.to_yahoo(ticker)
    items = []
    try:
        raw = yf.Ticker(ysym).news or []
    except Exception:
        raw = []

    for it in raw:
        c = it.get("content", it) if isinstance(it, dict) else {}
        title = c.get("title") or it.get("title")
        if not title:
            continue
        url = ((c.get("canonicalUrl") or {}).get("url")
               or (c.get("clickThroughUrl") or {}).get("url")
               or it.get("link"))
        provider = ((c.get("provider") or {}).get("displayName")
                    or it.get("publisher") or "")
        published = c.get("pubDate") or c.get("displayTime") or ""
        items.append({
            "title": title,
            "url": url,
            "publisher": provider,
            "published": (published or "")[:10],
            "type": c.get("contentType", ""),
            "sentiment": _sentiment(title),
        })
        if len(items) >= limit:
            break

    tally = {"positive": 0, "negative": 0, "neutral": 0}
    for i in items:
        tally[i["sentiment"]] += 1

    result = {"count": len(items), "tally": tally, "items": items}
    cache.set(key, result, version=_SCHEMA)
    return result
