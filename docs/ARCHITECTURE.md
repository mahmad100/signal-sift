# Signal Sift — Architecture

How the code is organized, how data flows, and the non-obvious decisions. See
[HANDOFF.md](HANDOFF.md) for status and [ROADMAP.md](ROADMAP.md) for direction.

## Layout
```
Signal Sift/
├── run.py                     # local dev entrypoint → Flask on :5000
├── config.py                  # windows, TTLs, paths, SERVERLESS/LIVE_SCREEN flags
├── requirements.txt           # flask, yfinance, pandas, requests
├── vercel.json                # routes all traffic to api/index.py; maxDuration 60s
├── api/index.py               # Vercel serverless WSGI entrypoint (exposes `app`)
├── scripts/precompute.py      # builds + writes data/precomputed_screen.json
├── .github/workflows/precompute.yml   # scheduled screen build → commit → push
├── signalsift/
│   ├── app.py                 # Flask routes + JSON API
│   ├── universe.py            # S&P 500 constituents (GitHub CSV + offline fallback)
│   ├── prices.py              # yfinance batch download + trailing-return math
│   ├── screener.py            # run_screen (live or precompute), filter, sector_stats
│   ├── edgar.py               # ticker→CIK, recent SEC filings + links
│   ├── analysts.py            # price targets, ratings, estimates (yfinance)
│   ├── marketcaps.py          # implied share counts for index weights (30-day cache)
│   ├── news.py                # recent headlines + naive sentiment tag
│   ├── fundamentals.py        # income/cash-flow/balance-sheet (30-day cache)
│   ├── company.py             # full detail/pitchbook profile (assembles everything)
│   └── cache.py               # TTL + schema-versioned JSON file cache
├── templates/{index.html, company.html}
├── static/
│   ├── styles.css             # themes (CSS vars) + all component styles
│   ├── company.js             # buildProfileHTML() + all SVG chart helpers (SHARED)
│   └── app.js                 # the SPA: state, tabs, filtering, watchlist, detail
└── data/
    ├── precomputed_screen.json   # committed; served on serverless
    └── *.json                    # runtime caches (gitignored)
```

## Request / data flow
- **Screen:** `GET /api/screen` → `screener.run_screen()` → returns the full universe
  payload (all rows with returns for every window, benchmark returns, sector list). The
  frontend fetches this **once** (`status=all&over=1Y`) and does all filtering, sorting,
  search, and sector aggregation **client-side** (`app.js`). Changing a filter never hits
  the network.
- **Detail:** `GET /api/company/<ticker>` → `company.profile()` assembles price history
  (5y), returns/excess over all windows, fundamentals, P/E history, analysts, news,
  filings, and a heuristic "why" thesis. `app.js` injects peer stats (`_peers`) computed
  from the cached universe, then renders with `buildProfileHTML()` from `company.js`.
- **Sectors:** computed client-side from the base rows (`computeSectors` in `app.js`);
  `/api/sectors` exists too but the SPA doesn't need it.
- **Weights:** each screen row carries an approximate `market_cap` = implied shares
  (`marketcaps.get_shares`, cached ~30d as `marketCap ÷ price`) × the current screen price,
  so caps track price without re-pulling the slow per-name data. The **Weights** tab
  (`renderWeights` in `app.js`) computes sector/stock index weights and the basket-vs-SPY
  "replicate the index" math **client-side** from `market_cap`. Weights are a full-market-cap
  approximation of SPY's float-adjusted methodology (imperfect for dual-class names).
- **Routing:** the active view is mirrored into `location.hash` (`#/stocks`,
  `#/watchlist`, `#/sectors`, `#/company/<TICKER>`) by `syncHash()` — called from
  `switchTab()` — so refresh/bookmark/back-forward all work. `applyHash()` routes the
  initial hash and `hashchange`; a `programmaticHash` guard stops our own writes from
  re-triggering a route. Jump anywhere fast via the **command palette** (Ctrl-K / `/`).

## The 11 windows
Defined once in `config.WINDOWS` (calendar-day lookbacks). Everything is data-driven from
there — the backend reports `windows`, and the table/heatmap/dropdowns follow. Returns use
an as-of lookback: `close_today / close_asof(today − D) − 1`. The screener pulls
`HISTORY_LOOKBACK_DAYS` (~1900) so even 5Y has a lookback price.

## Caching (two layers, both "database-like")
**Server** (`cache.py`, JSON files under `DATA_DIR`): per-key TTL, optional `version`
stamp. TTLs in `config.py`: screen 6h · profile/news/analysts 24h · 5y history 3d ·
fundamentals **30d** · implied shares **30d** (reused only if the cache covers ≥80% of the
requested universe, so a partial run can't starve a full screen of weights). Bumping a module's `_SCHEMA` invalidates its old caches on read.
**Client** (`localStorage`): base screen (`ss-base`), per-company profiles (`ss-co-*`),
watchlist (`ss-watchlist`), filters, theme. `APP_SCHEMA` in `app.js` purges stale data
caches on a shape change (keeps filters + theme).

## Serverless / precompute (why cold starts are fast)
Building the screen is a ~25s pull of ~5y prices for 500 names — too slow for a serverless
cold start. So:
- `config.SERVERLESS` (Vercel/Lambda) ⇒ `DATA_DIR=/tmp/...` and `LIVE_SCREEN=False`.
- With `LIVE_SCREEN` off, `run_screen()` serves the committed
  `data/precomputed_screen.json` (even on `force`/Refresh) — never the live pull.
- The **precompute Action** (schedule + manual) runs the live pull on a GitHub runner,
  commits the JSON; that push redeploys Vercel with fresh data.
- Locally `LIVE_SCREEN=True`, so dev pulls live as normal.

## Frontend gotchas (the ones that bite)
- **Global-scope sharing:** `company.js` and `app.js` are plain `<script>`s sharing the
  global lexical env. `company.js` declares `esc num fmtPct cls money C palette
  buildProfileHTML newsCard kvRows lineChart returnBars targetGauge ratingBar barChart
  groupedBars multiLine barsWithLine peHistoryChart multiLineRaw peerSection`. `app.js`
  must NOT redeclare any of them (`const` redeclaration across scripts = SyntaxError that
  kills both). `app.js` owns `$ WINDOWS pct fmtAge median State` + SPA logic. `company.js`
  must not use `app.js`-only names (`pct` etc.) — it self-boots only on `body.pb`.
- **Load order:** `company.js` before `app.js` in both HTML files.
- **Charts are theme-aware:** `palette()` reads CSS vars into `C` at render time; a theme
  switch re-renders so SVG colors follow.
- **yfinance sector label** differs from the GICS label used in the screen — peers match on
  the screen's sector, not `profile.identity.sector`.

## Testing without a browser
Chrome extension has been disconnected all project — no screenshots. Verify frontend by
loading both JS files in a Node `vm` with stubbed `document`/`localStorage`/`fetch`/
`Option`/`getComputedStyle`, driving `boot()`/`openDetail()`/`switchTab()` against the live
server, and asserting on produced HTML (chart counts, section presence, row counts). Always
`node --check` both files first. Known harness quirks to emulate: `innerHTML=''` should
clear child arrays; relative `fetch` URLs need an origin prefix; `new Option()` needs a stub.
