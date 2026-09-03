# Signal Sift — Direction & Notes

Where this is going and why it's built the way it is. See [ARCHITECTURE.md](ARCHITECTURE.md)
for the code and [../README.md](../README.md) for what the app does.

## Why it exists
Signal Sift is the tooling side of [Ahmadi Research](https://ahmadiresearch.com). The written
work there kept needing the same thing before it could start — trailing returns for a few
hundred names, lined up against the index, with the ones whose price and story had drifted
apart pulled out — so the chore became an app.

It's a **learning project** and it stays one. No accounts, nothing gated, nothing for sale.
The repo is public so the method is inspectable, the same way the spreadsheets behind the
papers are. It's also **vibe coded** — built conversationally with an AI coding agent. The
product judgment is mine; the line-by-line authorship mostly isn't. See the README.

## What I was trying to learn
- **Turning a research question into something that stays live.** A paper ends at a PDF. An
  app has to keep being right tomorrow, which is a different discipline entirely.
- **Cache design.** Data that moves at five different speeds — prices hourly, filings
  quarterly — shouldn't be refetched at one speed. Hence per-type TTLs and schema stamps.
- **Constraints as a design tool.** The screen takes ~25s to build; a serverless function
  has to answer in seconds. That one fact produced the precompute Action, the fetch-once
  client-side filtering, and the entire refresh design. Good constraints write the
  architecture for you.
- **Chart design from scratch.** Every chart is hand-written SVG, no library — which forced
  the question of what a chart should actually *say*. The dual-axis revenue chart got
  deleted for being quietly misleading; the series palette got rebuilt after two lines
  rendered as the same colour on one theme. Both mistakes taught more than their fixes.
- **Working honestly on top of a weak data source.** yfinance is scraping. Knowing exactly
  where each number comes from, and the specific ways it can be wrong, is the part that
  transfers to everything else.

## Positioning (a design principle, not a pitch)
> **Your lens on the market — you choose what matters, it shows it clearly and explains why.**

The "stalled stocks" screen is *one lens among many*, not the whole identity. As of
2026-09-02 the screener is a **spreadsheet** — sort and filter any column from its header —
which makes that literal. Two rules follow:
- **Opinionated defaults first, customization on top.** Never ship a blank canvas: it's
  useless to anyone new, and "customizable screener" isn't interesting on its own — Finviz
  has done it for years. The default sort (1Y desc) plus a few shipped screens are the
  opinionated layer.
- **The explanation is the point.** The "why it may be down" thesis plus sourced evidence
  (SEC filings, real analyst counts, real news) is what separates this from a bare screener
  and from finfluencer noise. Same instinct as the papers: show the work.

## What's next
1. **Watchlist** ✅ done — ★ stocks, own tab, persisted.
2. **Spreadsheet screener** ✅ done (2026-09-02) — sort + filter any column; state persists
   in `localStorage["ss-table"]` as `{sort, filters}` per table. This also retired the
   jargon-y filter bar and the "stall score" framing.
3. **Saved / named screens** ← NEXT. Persist a *list* of named `{sort, filters}` objects
   (the `ss-table` shape is already the unit), add a small picker above the table, and ship
   a few good presets ("Dead money", "Cheap growers", "Momentum leaders") to clone and
   tweak. A small extension of the existing `localStorage` pattern.
4. **Alerts** — "tell me when one of my names crosses a threshold or gets news." The piece
   that would make it a daily habit instead of an occasional visit.

Also queued (cheap, high-value):
- **An uptime check that exercises a real page, not just `/`.** Two outages now have been
  invisible from both dashboards: the 2026-08-04 routing break, and a 2026-09-03 change
  that returned 500 for every detail page while the front page stayed 200 and the build
  stayed green. A scheduled job asserting `/` → 200, `GET /api/refresh` → 405 (it is
  POST-only, so a 404 there means requests are not reaching Flask) and
  `/api/company/<T>` → 200 *with* a non-empty payload would have caught both. Natural
  home: a second job in the precompute workflow, failing loudly.
- **"What changed since last visit" digest** — the reason to open it at all on a quiet day.
- **Custom columns** — let the user pick which windows/metrics show; the column model
  (`tableCols()`) already makes this a data change, not a rewrite.
- **Plain-language everywhere** — the screener is de-jargoned; the **Weights** tab and some
  detail-page chart headings still lean technical.

## Honest caveats
- **Data source:** yfinance is Yahoo *scraping*. Fine for a personal research tool; it would
  not hold up under anything with real users depending on it (ToS, reliability, rate
  limits). Anything more serious needs licensed market data.
- **Index weights are approximate** — full market cap, not float-adjusted, so dual-class
  names are off. Good enough to reason with, not good enough to quote.
- **Not investment advice.** A research-idea generator. The framing that matters is "here's
  where to look", never "here's what to do" — same as everywhere else on the site.

## How an investor "sees" it (design lens)
Investors don't think in "trailing windows" — they think in stories ("why is my Pfizer dead
money", "is energy back"). They want orientation, a narrative, and *their* stocks — not a
503-row spreadsheet as the front door. The spreadsheet is the power-user surface; bias
future work toward the layers *above* it: saved screens as named stories, the watchlist,
"what changed since last visit", and letting the chart *say something* (annotations like
"flat while its sector rose 18%").

## Open questions
- Precompute freshness cadence — is twice-daily enough, or add more Action runs?
- The 11-bar detail return chart is now chronological + zero-anchored + extremes-labelled
  (2026-09-03); a short/long split or capped scale is still open if a huge outlier window
  (e.g. +503%) compresses the rest too much.
- Is the "why it may be down" thesis carrying its weight, or does it read as filler when the
  heuristics have nothing interesting to say?
- Should the topbar be sticky? The wordmark now goes home, but it scrolls out of view, so
  it is only reachable near the top — against the vertical space a sticky header costs on a
  500-row table.
