"""Fundamental financial statements via yfinance — the slow-moving 'database'.

These figures change at most quarterly, so they're cached for weeks
(config.FUNDAMENTALS_TTL). A price refresh never re-pulls them.
"""
import pandas as pd
import yfinance as yf

import config
from . import cache, prices

# Bump when the shape of the returned dict changes → old caches auto-invalidate.
_SCHEMA = 2


def _row(df, *names):
    """Return the first matching statement row as a {Timestamp: value} dict."""
    if df is None or df.empty:
        return {}
    for n in names:
        if n in df.index:
            s = df.loc[n]
            return {c: (float(v) if pd.notna(v) else None) for c, v in s.items()}
    return {}


def _series(row, cols):
    return [row.get(c) for c in cols]


def _pct(a, b):
    if a is None or b in (None, 0):
        return None
    return a / b - 1.0


def _margins(num, den):
    out = []
    for n, d in zip(num, den):
        out.append((n / d) if (n is not None and d not in (None, 0)) else None)
    return out


def _yoy(vals):
    out = [None]
    for i in range(1, len(vals)):
        out.append(_pct(vals[i], vals[i - 1]))
    return out


def get(ticker: str) -> dict:
    key = f"fund_{ticker.upper()}"
    cached = cache.get(key, config.FUNDAMENTALS_TTL, version=_SCHEMA)
    if cached is not None:
        return cached

    ysym = prices.to_yahoo(ticker)
    result = {"error": None, "years": []}
    try:
        tk = yf.Ticker(ysym)
        inc, cf, bs = tk.income_stmt, tk.cashflow, tk.balance_sheet

        if inc is None or inc.empty:
            result["error"] = "No financial statements available."
            cache.set(key, result, version=_SCHEMA)
            return result

        # Fiscal columns newest→oldest; reverse to oldest→newest for charts.
        cols = list(inc.columns)[:5][::-1]
        years = [c.strftime("%Y") if hasattr(c, "strftime") else str(c)[:4] for c in cols]
        year_dates = [c.strftime("%Y-%m-%d") if hasattr(c, "strftime") else str(c)[:10] for c in cols]

        revenue = _series(_row(inc, "Total Revenue", "Operating Revenue"), cols)
        gross = _series(_row(inc, "Gross Profit"), cols)
        op_income = _series(_row(inc, "Operating Income", "Total Operating Income As Reported"), cols)
        net_income = _series(_row(inc, "Net Income", "Net Income Common Stockholders"), cols)
        ebitda = _series(_row(inc, "EBITDA", "Normalized EBITDA"), cols)
        eps = _series(_row(inc, "Diluted EPS", "Basic EPS"), cols)
        rnd = _series(_row(inc, "Research And Development"), cols)

        fcf = _series(_row(cf, "Free Cash Flow"), cols)
        op_cash = _series(_row(cf, "Operating Cash Flow", "Cash Flow From Continuing Operating Activities"), cols)
        capex = _series(_row(cf, "Capital Expenditure"), cols)
        dividends = _series(_row(cf, "Cash Dividends Paid", "Common Stock Dividend Paid"), cols)

        debt = _series(_row(bs, "Total Debt"), cols)
        equity = _series(_row(bs, "Stockholders Equity", "Common Stock Equity"), cols)

        # yfinance often pads an empty oldest column; keep only years with revenue.
        keep = [i for i, v in enumerate(revenue) if v is not None]
        f = lambda lst: [lst[i] for i in keep]
        years = f(years)
        year_dates = f(year_dates)
        revenue, gross, op_income, net_income, ebitda, eps, rnd = (
            f(revenue), f(gross), f(op_income), f(net_income), f(ebitda), f(eps), f(rnd))
        fcf, op_cash, capex, dividends = f(fcf), f(op_cash), f(capex), f(dividends)
        debt, equity = f(debt), f(equity)

        # Quarterly revenue / earnings for a recent trend (last 8, oldest→newest).
        q = {"labels": [], "revenue": [], "net_income": []}
        try:
            qi = tk.quarterly_income_stmt
            if qi is not None and not qi.empty:
                qcols = list(qi.columns)[:8][::-1]
                q["labels"] = [c.strftime("%b %y") if hasattr(c, "strftime") else str(c)[:7] for c in qcols]
                q["revenue"] = _series(_row(qi, "Total Revenue", "Operating Revenue"), qcols)
                q["net_income"] = _series(_row(qi, "Net Income", "Net Income Common Stockholders"), qcols)
        except Exception:
            pass

        result.update({
            "years": years,
            "year_dates": year_dates,
            "revenue": revenue,
            "gross_profit": gross,
            "operating_income": op_income,
            "net_income": net_income,
            "ebitda": ebitda,
            "eps": eps,
            "rnd": rnd,
            "free_cash_flow": fcf,
            "operating_cash_flow": op_cash,
            "capex": capex,
            "dividends": [(-v if v is not None else None) for v in dividends],
            "total_debt": debt,
            "equity": equity,
            "gross_margin": _margins(gross, revenue),
            "operating_margin": _margins(op_income, revenue),
            "net_margin": _margins(net_income, revenue),
            "fcf_margin": _margins(fcf, revenue),
            "revenue_yoy": _yoy(revenue),
            "eps_yoy": _yoy(eps),
            "net_income_yoy": _yoy(net_income),
            "quarterly": q,
        })
    except Exception as exc:  # noqa: BLE001
        result["error"] = str(exc)

    cache.set(key, result, version=_SCHEMA)
    return result
