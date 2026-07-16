# ◑ Signal Sift

A trend radar for the **S&P 500**: it screens every name across 11 trailing windows
(1D / 1W / 1M / 3M / 6M / 9M / 1Y / 2Y / 3Y / 4Y / 5Y), flags each as growing or stalled,
and hands you the threads to pull on *why* — fundamentals, news, analyst targets, and
direct links to **SEC filings**.

The thesis: a large-cap that goes sideways while the index runs is a *signal*.
Sometimes it's a value trap; sometimes it's a coiled spring the market hasn't
re-rated yet. Signal Sift finds them and points you at the primary sources.

> **Working on this project?** Start with **[docs/HANDOFF.md](docs/HANDOFF.md)** —
> current state, how to run/test/deploy, and next steps. See also
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## What it does

- **Screens the whole S&P 500** for trailing returns across eleven windows:
  **1D, 1W, 1M, 3M, 6M, 9M, 1Y, 2Y, 3Y, 4Y, 5Y** — short windows catch recent
  moves, the multi-year windows reveal the long-term trend. Every name, growers
  *and* laggards.
- **Explore the full universe**: toggle **All / Growing / Stalled**, pick the
  reference window growth is judged over, sort by any window or stall score, and
  filter by sector. Each row shows a ▲ Growing / ▼ Stalled status.
- **Sector overview**: median return per GICS sector with a diverging bar chart
  and growing-vs-stalled counts. Click a sector to filter the table to it.
- **Index-weight visualizer** (Weights tab): see each stock's and sector's
  approximate share of the S&P 500, then **build a basket** — toggle whole
  sectors, set "top N by weight", or hand-pick names — and compare its return to
  SPY across every window, cap- or equal-weighted, with coverage (% of the index
  by count and by market cap). Answers "how few names replicate the S&P 500's
  return?" Weights are a full-market-cap approximation (not float-adjusted).
- **Jump anywhere**: Ctrl-K / `/` command palette to any ticker, keyboard row
  navigation, and deep links (`#/company/NVDA`, `#/weights`) that survive refresh.
- **Animated intro** when you arrive: a ~1.5s full-screen splash — the ◑ mark spins
  in and fills to half like a loader, then "Signal Sift" types out — which clears
  itself and reveals the dashboard. No button to press. It greets a *fresh arrival*
  in a tab (a link, a search result, a new tab) and stays out of the way after that:
  no replay on refresh, or when you come back to the main page from a company page.
  Themed to your palette. (It's an overlay in `index.html`, not a separate page.)
- **Flags "stalled" names** — return at or below a growth line you choose (default +5%).
- **Ranks by stall score** (how many of the 7 windows are stalled) and relative
  under-performance vs. SPY.
- **Explains where to look**: click any row for a quick drawer of recent **SEC
  EDGAR** filings (10-K, 10-Q, 8-K, proxies, insider Form 4s) and **analyst**
  price targets, consensus rating, and upside-to-target.
- **Pitchbook profile** — click any stock for a full visual detail view:
  - A **5-year** price-vs-SPY trend chart, trailing returns across all eleven
    windows (**1D → 5Y**), and relative performance.
  - **Fundamentals, charted**: revenue with a **YoY-growth overlay line**,
    margins (gross/operating/net lines), net income, free cash flow, diluted
    EPS, a **year-end P/E valuation-history** line, quarterly revenue & income,
    and a full statement-detail table.
  - **Peer comparison** — this stock's 1M/3M/6M/12M returns vs. its **sector
    median** and SPY, plus its rank within the sector (e.g. "#4 of 74").
  - Valuation & profitability metrics, an analyst price-target gauge +
    **number of analysts following**, and rating distribution.
  - Business description, **recent news headlines with a bull/bear sentiment
    tag**, SEC filings, and an auto-written "why it's stalled" thesis.
  - All charts are inline SVG (no external libraries) and recolor with the theme.

## Feels like an app

- **Tabs** — *Individual stocks*, *Watchlist*, *Sectors*, and a *detail* tab that
  opens when you click a name. Clicking a stock never loses your place or filters.
- **Watchlist** — ★ any stock (from the list or its detail page) to track it in
  its own tab through the full Signal Sift lens (returns, growing/stalled status,
  stall score). The count shows in the tab, and it persists across refreshes.
- **Instant filtering** — the full universe is fetched **once**; all filtering,
  sorting, search, and sector math happen in the browser, so nothing re-pulls
  when you change a control.
- **Local caching** — the screen and each company profile are cached in
  `localStorage`; reopening the app or a stock is instant. Once the cached screen
  is over an hour old the app re-checks in the background on load and adopts any
  newer data, so scheduled refreshes reach you without a click. **↻ Refresh data**
  forces the issue and clears the caches.
- **Database-style server caches** — each data type is stored on disk with its
  own lifetime, so fast-moving data expires quickly while slow-moving data
  persists and is never needlessly re-pulled:

  | Layer | Refreshes every |
  |-------|-----------------|
  | Prices / screen | 6 hours |
  | Profile, news, analysts | 24 hours |
  | 5-year price history | 3 days |
  | **Financial statements** | **30 days** |
  | Implied shares (index weights) | 30 days |

  A price refresh reuses financial statements straight from disk — pulling
  income/cash-flow/balance-sheet data (which only changes quarterly) is avoided.
- **Self-invalidating caches** — each versioned payload carries a `_schema`
  stamp. Bump the `_SCHEMA` constant in a module (`company.py`, `fundamentals.py`,
  `news.py`) and its old caches are ignored and re-pulled automatically — no
  manual cache-clearing. The browser mirrors this with `APP_SCHEMA` in `app.js`,
  which purges stale `localStorage` data (keeping your filters and theme).
- **Themes** — Midnight, Carbon, Daylight, Amber terminal, and Ocean. Charts
  recolor to match. Your choice is remembered.
- **Sector heatmap** — sectors × windows, color-graded by median return.

## Data sources (both free, no paid keys)

| Need                | Source                                   |
|---------------------|------------------------------------------|
| Prices / history    | Yahoo Finance via `yfinance`             |
| Market caps / weights | Yahoo Finance via `yfinance` (approx.) |
| Analyst estimates   | Yahoo Finance via `yfinance`             |
| Filings             | SEC EDGAR (`data.sec.gov`, public JSON)  |
| S&P 500 membership  | `datasets/s-and-p-500-companies` (GitHub)|

## Setup

```powershell
cd "Signal Sift"
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py
```

Then open **http://127.0.0.1:5000**.

> SEC asks API users to identify themselves. Set a contact string:
> `setx SIGNALSIFT_SEC_UA "Your Name your@email.com"` (defaults are fine for light use).

## Deploy (Vercel)

The repo ships Vercel config: `api/index.py` exposes the Flask app as a Python
serverless function, `vercel.json` routes all traffic to it, and the on-disk
cache automatically moves to `/tmp` on serverless (see `config.py`). Import the
repo in Vercel and it builds from `requirements.txt` — no extra setup.

**Precomputed screen (no cold-start timeout).** Building the screen means pulling
~5 years of prices for all 500 names (~25s) — too slow for a serverless cold
start. So the slow work runs in CI instead: the **`Precompute screen` GitHub
Action** (`.github/workflows/precompute.yml`) runs the screen on a schedule and
commits `data/precomputed_screen.json`. On serverless (`config.LIVE_SCREEN` is
False) the app **serves that committed file**, so `/api/screen` returns in well
under a second and never runs the live pull. Each Action commit redeploys Vercel
with fresh data. Per-stock detail pages stay on-demand (a single ticker is fast).
Locally, `LIVE_SCREEN` is True so the screener pulls live as usual.

**Refresh: automatic twice a day, plus on demand.** The Action runs on a schedule
(12:00 and 22:00 UTC on weekdays — pre-open and after the US close), and the app
picks up each new publish on its own: a browser whose cached screen has aged past
an hour quietly re-checks on load and adopts anything newer.

**↻ Refresh data** works on top of that. Locally it just pulls live. On Vercel it
can't (that's the 25s pull the precompute exists to avoid), so it does two things:
serves the newest published screen immediately, then asks the same Action for an
off-schedule pull and polls until that commit redeploys — a few minutes, with the
current data on screen the whole time (measured end-to-end: **4m46s** from click to
fresh data). Triggering the Action needs a GitHub token — already configured on the
live deployment; for a new one:

```powershell
# Fine-grained PAT: repo access = signal-sift, Repository permissions -> Actions: read & write
vercel env add SIGNALSIFT_GH_TOKEN     # or add it in the Vercel dashboard, then redeploy
```

Two things that will bite: the token must be scoped to **the repo itself** (a
"Public repositories" token can't see a private repo — the API 404s), and it needs
an explicit **Actions: read & write** permission (a token with no permissions also
404s). `GET /api/screen` reports `can_trigger_refresh` so you can check from outside
whether the server actually has a working token. Env vars only take effect on a new
deployment.

Without the token nothing breaks — Refresh still serves the latest published
screen and says so; it just can't pull off-schedule. You can always run one by
hand: **Actions tab → Precompute screen → Run workflow**.

## Using the dashboard

- **Stall ceiling** — what counts as "not grown" (≤ 0% / 5% / 10%).
- **Show** — All names / Growing only / Stalled only.
- **Growth over** — reference window used to judge growing vs. stalled.
- **Sort by** — any window's return or the stall score; **Order** flips best/worst first.
- **Sector** — narrow to one GICS sector (or click a bar in the Sector overview).
- **Growth line** — the return threshold that separates growing from stalled.
- **↻ Refresh data** — get the newest prices. Locally that's a live Yahoo pull; on
  the deployed app it loads the latest published screen instantly, then runs an
  off-schedule precompute in the background (a few minutes).
- Click a row → side drawer with the "why" bullets, analyst targets, and filings,
  and an **Open full pitchbook ↗** button.

## How growth / "not grown" is measured

For each window of *D* calendar days, the trailing return is
`close_today / close_asof(today − D) − 1`, using the last close on or before the
lookback date. A name is **growing** over the reference window when that return is
above the growth line, otherwise **stalled**. The **Stall** column counts stalled
windows (0–11); 11 means flat-or-down over every horizon. Sector medians aggregate
these returns across each GICS sector's constituents.

## Layout

```
Signal Sift/
├── run.py                  # start the server
├── config.py               # windows, thresholds, SEC user-agent
├── signalsift/
│   ├── universe.py         # S&P 500 constituents (+ offline fallback)
│   ├── prices.py           # yfinance download + trailing-return math
│   ├── screener.py         # compute & filter the screen
│   ├── edgar.py            # ticker→CIK, recent filings + links
│   ├── analysts.py         # price targets, ratings, estimates
│   ├── marketcaps.py       # implied share counts → index weights (30-day cache)
│   ├── news.py             # recent headlines + sentiment tag
│   ├── fundamentals.py     # income / cash-flow / balance-sheet (30-day cache)
│   ├── company.py          # full pitchbook profile (fundamentals + history + news)
│   ├── cache.py            # TTL JSON cache under data/
│   └── app.py              # Flask routes + API
├── templates/{index.html, company.html}   # index.html opens with the intro splash overlay
└── static/{styles.css, app.js, company.js}   # app.js = SPA, company.js = shared profile renderer
```

## Caveats

- yfinance scrapes Yahoo; occasional gaps/rate-limits are normal — hit Refresh.
- Not investment advice. This is a research-idea generator, not a signal to trade.
