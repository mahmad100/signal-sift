# ◑ Signal Sift

A trend radar for the **S&P 500**: it screens every name across 11 trailing windows
(1D / 1W / 1M / 3M / 6M / 9M / 1Y / 2Y / 3Y / 4Y / 5Y), lets you slice the whole universe
like a spreadsheet (sort and filter any column), and hands you the threads to pull on *why*
— fundamentals, news, analyst targets, and direct links to **SEC filings**.

The thesis: a large-cap that goes sideways while the index runs is a *signal*.
Sometimes it's a value trap; sometimes it's a coiled spring the market hasn't
re-rated yet. Signal Sift finds them and points you at the primary sources.

> **Working on this project?** See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the
> code is organized and [docs/ROADMAP.md](docs/ROADMAP.md) for direction. Setup and how to
> run/test/deploy are below.

## What it does

- **Screens the whole S&P 500** for trailing returns across eleven windows:
  **1D, 1W, 1M, 3M, 6M, 9M, 1Y, 2Y, 3Y, 4Y, 5Y** — short windows catch recent
  moves, the multi-year windows reveal the long-term trend. Every name, growers
  *and* laggards.
- **Slice it like a spreadsheet**: click any column header for a popover that
  **sorts** (ascending / descending) and **filters** that column — "contains" for
  ticker and company, a sector checklist, and min/max for price and every return
  window (e.g. "1Y above +30%", "5Y below −20%"). Active filters are marked; the
  whole set persists across refreshes and is the basis for saved screens.
- **Sector overview**: median return per GICS sector with a diverging bar chart
  and an up/down count per sector. Click a sector to filter the table to it.
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
- **Finds dead money**: filter, say, `1Y` below `+5%` while `5Y` is above `+80%`
  — a large-cap that went sideways while the index (and its own history) ran.
- **Explains where to look**: click any row for the full pitchbook — recent **SEC
  EDGAR** filings (10-K, 10-Q, 8-K, proxies, insider Form 4s), **analyst** price
  targets, consensus rating, and upside-to-target.
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
    tag**, SEC filings, and an auto-written "why it may be down" thesis.
  - All charts are inline SVG (no external libraries) and recolor with the theme.

## Feels like an app

- **Tabs** — *Individual stocks*, *Watchlist*, *Sectors*, *Weights*, and a *detail*
  tab that opens when you click a name. Clicking a stock never loses your place or filters.
- **Watchlist** — ★ any stock (from the list or its detail page) to track it in
  its own tab, in the same sort/filter-any-column table. The count shows in the
  tab, and it persists across refreshes.
- **Instant filtering** — the full universe is fetched **once**; all sorting,
  filtering, and sector math happen in the browser, so nothing re-pulls when you
  change a column filter.
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
  which purges stale `localStorage` data (keeping your column filters and theme).
- **Deploy-versioned assets** — the page loads `app.js` / `styles.css` with a
  `?v=<deploy>` token, so a new deploy is never masked by a stale browser cache.
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

Every column of the *Individual stocks* and *Watchlist* tables is a button. Click a
header for a popover that lets you:

- **Sort** — ascending or descending on that column (A→Z for text, low→high for numbers).
- **Filter** —
  - *Ticker / Company* → "contains" text
  - *Sector* → a checklist (pick one or several; all-checked or none = no filter)
  - *Price* → min / max in dollars
  - *1D … 5Y* → min / max as a **percentage** (`10` means +10%; negatives filter losers)

Filtered columns are highlighted; the sorted column shows ▲ / ▼. A **Clear all filters**
link appears in the status line, and each popover has its own **Clear**. Your sort and
filters are saved and restored on the next visit.

Other bits:

- Click a **sector** in the Sectors tab → opens *Individual stocks* filtered to it.
- **↻ Refresh data** — newest prices. Locally a live Yahoo pull; on the deployed app it
  loads the latest published screen instantly, then runs an off-schedule precompute in the
  background (a few minutes).
- Click a **row** → the full pitchbook (fundamentals, analyst targets, news, filings, and a
  "why it may be down" thesis).

## How the returns are measured

For each window of *D* calendar days, the trailing return is
`close_today / close_asof(today − D) − 1`, using the last close on or before the
lookback date — so `1Y` means "bought a year ago, held to now". A dash (—) means there's
no price history that far back (a recent listing). Sector medians aggregate these returns
across each GICS sector's constituents; the Sectors tab's up/down split counts names above
vs. at-or-below a fixed +5% line over the chosen window.

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
