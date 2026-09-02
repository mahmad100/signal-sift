# Signal Sift — Architecture

How the code is organized, how data flows, and the non-obvious decisions. See
[ROADMAP.md](ROADMAP.md) for direction.

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
│   ├── app.py                 # Flask routes + JSON API + {{ asset() }} versioning helper
│   ├── universe.py            # S&P 500 constituents (GitHub CSV + offline fallback)
│   ├── prices.py              # yfinance batch download + trailing-return math
│   ├── screener.py            # run_screen (live or precompute), filter, sector_stats
│   ├── edgar.py               # ticker→CIK, recent SEC filings + links
│   ├── analysts.py            # price targets, ratings, estimates (yfinance)
│   ├── marketcaps.py          # implied share counts for index weights (30-day cache)
│   ├── news.py                # recent headlines + naive sentiment tag
│   ├── fundamentals.py        # income/cash-flow/balance-sheet (30-day cache)
│   ├── company.py             # full detail/pitchbook profile (assembles everything)
│   ├── ghactions.py           # fire the precompute Action (serverless manual Refresh)
│   └── cache.py               # TTL + schema-versioned JSON file cache
├── templates/{index.html, company.html}   # index opens with the #ss-intro splash (once per tab)
├── static/
│   ├── styles.css             # themes (CSS vars) + all component styles
│   ├── company.js             # buildProfileHTML() + all SVG chart helpers (SHARED)
│   └── app.js                 # the SPA: state, tabs, the spreadsheet table + popover, detail
└── data/
    ├── precomputed_screen.json   # committed; served on serverless
    └── *.json                    # runtime caches (gitignored)
```

## Request / data flow
- **Screen:** `GET /api/screen` → `screener.run_screen()` → returns the full universe
  payload (all rows with returns for every window, benchmark returns, sector list). The
  frontend fetches this **once** and does all sorting, filtering, and sector aggregation
  **client-side** (`app.js`). Changing a filter never hits the network. (The fetch still
  sends legacy `status=all&over=1Y&…` query params; the backend honours them but the SPA
  ignores the server-side filtering and slices the full `rows` itself.)
- **Detail:** `GET /api/company/<ticker>` → `company.profile()` assembles price history
  (5y), returns/excess over all windows, fundamentals, P/E history, analysts, news,
  filings, and a heuristic "why" thesis. `app.js` injects peer stats (`_peers`) computed
  from the cached universe, then renders with `buildProfileHTML()` from `company.js`.
- **Individual stocks + Watchlist table:** one spreadsheet-style table, driven by two
  context objects — `STX` (whole universe) and `WL` (watched rows). `tableCols()` returns
  data-driven column defs (`{key,label,kind,get,cell,num}`, `kind` ∈ text/enum/money/pct);
  `paint(ctx)` = `paintHead` + `paintBody`; `rowPasses` / `sortRows` do the work. Each
  header opens `#colpop` (one shared popover) via `openColPop` → `colPopHTML` → `wireColPop`
  for sort + a per-column filter. Sort + filters live in `ctx.sort` / `ctx.filters` and
  persist to `localStorage["ss-table"]` (`{stx:{sort,filters}, wl:{sort,filters}}`).
- **Sectors:** computed client-side from the base rows (`computeSectors` in `app.js`); its
  up/down mix uses `judge(row,w)` against a fixed `GROWTH_LINE` (+5%). `/api/sectors` exists
  too but the SPA doesn't need it. Clicking a sector sets `STX.filters = {sector:[name]}`
  and switches to the stocks tab.
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
watchlist (`ss-watchlist`), basket (`ss-basket`), table sort+filters (`ss-table`), the
Sectors/Weights window selects (`ss-secover` etc.), theme (`ss-theme`). `APP_SCHEMA`
(currently `"6"`) purges stale data caches — and the retired `ss-filters` / `ss-wlover`
keys — on a shape change, keeping `ss-table` + theme.

**Deploy-versioned assets:** templates reference JS/CSS via `{{ asset('app.js') }}` →
`/static/app.js?v=<token>` from `_asset_version()` in `app.py`. Token is
`VERCEL_GIT_COMMIT_SHA[:8]` in prod (new URL every deploy → no stale cache) and the newest
`static/*.{js,css}` mtime locally.

## Serverless / precompute (why cold starts are fast)
Building the screen is a ~25s pull of ~5y prices for 500 names — too slow for a serverless
cold start. So:
- `config.SERVERLESS` (Vercel/Lambda) ⇒ `DATA_DIR=/tmp/...` and `LIVE_SCREEN=False`.
- With `LIVE_SCREEN` off, **every** request serves the committed
  `data/precomputed_screen.json` — `run_screen(force=True)` only bypasses the 6h `/tmp`
  cache and re-reads the file. `_live_screen` is never called in a serverless request.
- The **precompute Action** (schedule + `workflow_dispatch`) runs the full pull on a
  GitHub runner and commits the JSON; that push redeploys Vercel.
- Locally `LIVE_SCREEN=True`, so dev pulls fully live (and fetches share counts) as normal.

### Routing: use `routes`/`dest`, never `rewrites` (outage 2026-08-04)
`vercel.json` **must** send traffic to the function with the legacy form:
```json
"routes": [{ "src": "/(.*)", "dest": "/api/index" }]
```
It previously used `"rewrites": [{ "source": "/(.*)", "destination": "/api/index" }]`, which
worked until Vercel changed its behavior: the rewrite began replacing the request path, so
the Flask app received `PATH_INFO=/api/index` for **every** URL and returned Werkzeug's 404
site-wide — while builds all reported success and nothing in the repo had changed.
`routes`/`dest` preserves the original path (verified live: a request to `/__probe` arrived
with `PATH_INFO=/__probe`).

**Diagnosing this class of bug:** the 404 body is Werkzeug's, not Vercel's, which proves the
function is running and Flask is answering. The sharpest discriminator is `GET /api/refresh`
— it's POST-only, so Flask returns **405** when it sees the real path and **404** when it
doesn't. Compare live against `app.test_client()` locally. Preview deployments sit behind
Vercel's SSO wall (302), so they can't be curled; diagnose against production.

### Refresh (why it works this way)
An earlier design had a serverless Refresh do an on-demand live *price* pull, reusing the
precompute's share counts to skip the market-cap fetch. **It didn't work** — even the
price-only pull for 500 names blew the function budget, so `?refresh=1` hung ~40s and
died, and since Refresh was the *only* thing that replaced the browser's `localStorage`
copy, the app could sit on day-old data indefinitely. Don't reintroduce it. Instead:
- **Automatic:** the Action publishes twice a day, and `freshenIfStale()` (`app.js`) makes
  clients adopt it — a cached screen older than `BASE_STALE_MS` (1h) triggers a background
  re-check on load, un-awaited so the cached copy still paints instantly.
- **Manual:** `POST /api/refresh` → `ghactions.dispatch()` fires the same Action via the
  GitHub API (needs `SIGNALSIFT_GH_TOKEN`, `actions: write`; degrades to a plain message
  without one). `pullFresh()` in `app.js` then polls `fetchBase(true)` every 15s for up to
  6 min, swapping in the data when `generated_at` changes. `/api/screen` advertises
  `live_screen` + `can_trigger_refresh` so the client knows which mode it's in.

## Frontend gotchas (the ones that bite)
- **Global-scope sharing:** `company.js` and `app.js` are plain `<script>`s sharing the
  global lexical env. `company.js` declares `esc num fmtPct cls money C palette
  buildProfileHTML newsCard kvRows lineChart returnBars targetGauge ratingBar barChart
  groupedBars multiLine barsWithLine peHistoryChart multiLineRaw peerSection`. `app.js`
  must NOT redeclare any of them (`const` redeclaration across scripts = SyntaxError that
  kills both). `app.js` owns `$ WINDOWS pct fmtAge median State STX WL` + SPA logic.
  `company.js` must not use `app.js`-only names (`pct` etc.) — it self-boots only on `body.pb`.
- **Column filter popover (`wireColPop`):** Clear and Done are wired **first**, each in its
  own `try`, so a hiccup building another control can't leave the escape hatches dead. The
  min/max live-apply is debounced; Clear/Done/sort all `cancel()` the pending timer and
  Done commits the inputs synchronously — otherwise a value typed then cleared within the
  debounce window reappears. Don't reintroduce apply-on-a-bare-debounce.
- **`judge(row,w)` is tri-state** (`true`/`false`/`null`) but trivial now —
  `v == null ? null : v > GROWTH_LINE`, `GROWTH_LINE = 0.05`, used only by the Sectors tab.
  The old per-window benchmark line (`lineFor` / `isSpyLine` / `ceilNum`) is gone.
- **Load order:** `company.js` before `app.js` in both HTML files.
- **Charts are theme-aware:** `palette()` reads CSS vars into `C` at render time; a theme
  switch re-renders so SVG colors follow.
- **yfinance sector label** differs from the GICS label used in the screen — peers match on
  the screen's sector, not `profile.identity.sector`.
- **The intro splash spans two files.** Its markup + inline IIFE live in `index.html`; its
  animation lives in `styles.css` (`.ss-*`). The two are one sequence — the script adds
  `.load` exactly as the CSS `ss-appear` ends, and starts typing just after `ss-spin`/
  `ss-fill` settle — so a timing change in one needs the matching change in the other, and
  `.ss-sub` / `.ss-caret.done` / `.ss-intro`'s fade must fit inside the total or they
  outlive the overlay. It's gated once-per-tab on `sessionStorage["ss-intro-seen"]`, checked
  before first paint so a skipped intro never flashes.

## Testing the frontend
No Chrome extension, but two working paths (see HANDOFF.md for the mechanics + gotchas):
1. **Pure-vm DOM harness** — load `company.js` then `app.js` in a Node `vm` with stubbed
   `document`/`localStorage`/`fetch`/`Option`/`getComputedStyle`, seed `ss-base` (+ `ss-schema`
   = `"6"`), let `boot()` run, assert on produced HTML. Fast, no browser, no server.
2. **Real headless Chrome over CDP** — start Flask in serverless mode
   (`VERCEL=1 SIGNALSIFT_DATA_DIR=…`), launch `chrome --headless=new --remote-debugging-port=9222`,
   drive it from Node (`WebSocket` is global): `Page.navigate`, `Runtime.evaluate`,
   `Input.dispatchMouseEvent`, `Page.captureScreenshot`. This renders the real page with real
   data and catches layout/wiring the vm harness can't — it's how the popover Clear/Done race
   and the input-overflow CSS bug were both found and fixed.

Always `node --check` both files first. Harness quirks to emulate: `innerHTML=''` clears
child arrays; relative `fetch` URLs need an origin prefix; `new Option()` needs a stub;
`State`/`STX`/`WL` are `const` so read them via `vm.runInContext("STX", ctx)`.
