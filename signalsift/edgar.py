"""SEC EDGAR: map tickers to filings and build human-clickable links."""
import requests

import config
from . import cache

_HEADERS = {"User-Agent": config.SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate"}
_TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json"
_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik10}.json"
_MAP_KEY = "edgar_ticker_map"
_MAP_TTL = 60 * 60 * 24 * 7

# Forms most useful for understanding a stalled stock.
_INTERESTING = {"10-K", "10-Q", "8-K", "DEF 14A", "SC 13D", "SC 13G", "4"}


def _load_map():
    cached = cache.get(_MAP_KEY, _MAP_TTL)
    if cached:
        return cached
    resp = requests.get(_TICKER_MAP_URL, headers=_HEADERS, timeout=20)
    resp.raise_for_status()
    raw = resp.json()
    # raw is {"0": {"cik_str":320193,"ticker":"AAPL","title":"Apple Inc."}, ...}
    mapping = {}
    for row in raw.values():
        mapping[row["ticker"].upper()] = {
            "cik": int(row["cik_str"]),
            "title": row["title"],
        }
    cache.set(_MAP_KEY, mapping)
    return mapping


def cik_for(ticker: str):
    mapping = _load_map()
    return mapping.get(ticker.replace(".", "-").upper()) or mapping.get(ticker.upper())


def recent_filings(ticker: str, limit: int = 12):
    """Return recent notable filings with direct links, newest first."""
    key = f"edgar_{ticker.upper()}"
    cached = cache.get(key, config.DETAIL_TTL)
    if cached is not None:
        return cached

    entry = cik_for(ticker)
    if not entry:
        result = {"error": "No CIK found for ticker on EDGAR.", "filings": []}
        cache.set(key, result)
        return result

    cik = entry["cik"]
    cik10 = str(cik).zfill(10)
    try:
        resp = requests.get(_SUBMISSIONS_URL.format(cik10=cik10),
                            headers=_HEADERS, timeout=20)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as exc:
        return {"error": f"EDGAR fetch failed: {exc}", "filings": []}

    recent = data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    accns = recent.get("accessionNumber", [])
    docs = recent.get("primaryDocument", [])
    descs = recent.get("primaryDocDescription", [])

    filings = []
    for i in range(len(forms)):
        form = forms[i]
        if form not in _INTERESTING:
            continue
        accn = accns[i].replace("-", "")
        doc = docs[i] if i < len(docs) else ""
        url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accn}/{doc}" if doc else \
              f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik10}"
        filings.append({
            "form": form,
            "date": dates[i] if i < len(dates) else "",
            "description": descs[i] if i < len(descs) else "",
            "url": url,
        })
        if len(filings) >= limit:
            break

    result = {
        "cik": cik,
        "company": entry["title"],
        "edgar_url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik10}&type=&dateb=&owner=include&count=40",
        "filings": filings,
    }
    cache.set(key, result)
    return result
