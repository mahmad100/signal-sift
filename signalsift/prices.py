"""Price history + trailing-return math via yfinance."""
from datetime import timedelta

import pandas as pd
import yfinance as yf

import config


def to_yahoo(ticker: str) -> str:
    """Yahoo uses dashes where S&P lists use dots (BRK.B -> BRK-B)."""
    return ticker.replace(".", "-").strip().upper()


def download_closes(tickers, lookback_days: int = 400) -> pd.DataFrame:
    """Return a DataFrame of daily closes: index=date, columns=yahoo tickers.

    Downloads in chunks to stay friendly to Yahoo's endpoints.
    """
    ymap = {to_yahoo(t): t for t in tickers}
    symbols = list(ymap.keys())
    period = f"{max(lookback_days + 40, 400)}d"

    frames = []
    for i in range(0, len(symbols), 100):
        chunk = symbols[i:i + 100]
        data = yf.download(
            chunk,
            period=period,
            interval="1d",
            auto_adjust=True,
            progress=False,
            threads=True,
            group_by="column",
        )
        if data is None or data.empty:
            continue
        # Single ticker -> flat columns; multi -> MultiIndex with 'Close'.
        if isinstance(data.columns, pd.MultiIndex):
            close = data["Close"] if "Close" in data.columns.levels[0] else data
        else:
            close = data[["Close"]].rename(columns={"Close": chunk[0]})
        frames.append(close)

    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, axis=1)
    out = out.loc[:, ~out.columns.duplicated()]
    return out


def _asof_price(series: pd.Series, target_date) -> float:
    """Most recent close on or before target_date, or None."""
    s = series.dropna()
    s = s[s.index <= target_date]
    if s.empty:
        return None
    return float(s.iloc[-1])


def trailing_returns(series: pd.Series, windows=None) -> dict:
    """For one ticker's close series, return {window_label: pct_return or None}."""
    windows = windows or config.WINDOWS
    s = series.dropna()
    if s.empty:
        return {k: None for k in windows}
    latest_date = s.index[-1]
    latest = float(s.iloc[-1])
    out = {}
    for label, days in windows.items():
        base = _asof_price(s, latest_date - timedelta(days=days))
        out[label] = (latest / base - 1.0) if base else None
    return out


def latest_price(series: pd.Series):
    s = series.dropna()
    return float(s.iloc[-1]) if not s.empty else None
