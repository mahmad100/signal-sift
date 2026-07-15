"""S&P 500 constituent list (ticker, name, sector)."""
import csv
import io

import requests

from . import cache

# Maintained community dataset — no API key required.
_CONSTITUENTS_URL = (
    "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/"
    "main/data/constituents.csv"
)
_CACHE_KEY = "sp500_constituents"
_CACHE_TTL = 60 * 60 * 24 * 7  # refresh weekly

# Minimal fallback so the app still runs fully offline / if the fetch fails.
_FALLBACK = [
    {"ticker": "AAPL", "name": "Apple", "sector": "Information Technology"},
    {"ticker": "MSFT", "name": "Microsoft", "sector": "Information Technology"},
    {"ticker": "NVDA", "name": "NVIDIA", "sector": "Information Technology"},
    {"ticker": "AMZN", "name": "Amazon", "sector": "Consumer Discretionary"},
    {"ticker": "GOOGL", "name": "Alphabet", "sector": "Communication Services"},
    {"ticker": "META", "name": "Meta Platforms", "sector": "Communication Services"},
    {"ticker": "BRK.B", "name": "Berkshire Hathaway", "sector": "Financials"},
    {"ticker": "JPM", "name": "JPMorgan Chase", "sector": "Financials"},
    {"ticker": "JNJ", "name": "Johnson & Johnson", "sector": "Health Care"},
    {"ticker": "XOM", "name": "Exxon Mobil", "sector": "Energy"},
    {"ticker": "PG", "name": "Procter & Gamble", "sector": "Consumer Staples"},
    {"ticker": "KO", "name": "Coca-Cola", "sector": "Consumer Staples"},
    {"ticker": "PFE", "name": "Pfizer", "sector": "Health Care"},
    {"ticker": "INTC", "name": "Intel", "sector": "Information Technology"},
    {"ticker": "NKE", "name": "Nike", "sector": "Consumer Discretionary"},
]


def get_constituents(force: bool = False):
    """Return list of {ticker, name, sector}. Cached weekly, falls back offline."""
    if not force:
        cached = cache.get(_CACHE_KEY, _CACHE_TTL)
        if cached:
            return cached

    try:
        resp = requests.get(_CONSTITUENTS_URL, timeout=20)
        resp.raise_for_status()
        rows = []
        reader = csv.DictReader(io.StringIO(resp.text))
        for r in reader:
            rows.append({
                "ticker": r["Symbol"].strip(),
                "name": r["Security"].strip() if "Security" in r else r.get("Name", "").strip(),
                "sector": r.get("GICS Sector", r.get("Sector", "")).strip(),
            })
        if rows:
            cache.set(_CACHE_KEY, rows)
            return rows
    except (requests.RequestException, KeyError, csv.Error):
        pass

    return _FALLBACK
