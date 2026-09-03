# Signal Sift — Strategy & Roadmap

Direction, positioning, and what's next. See [ARCHITECTURE.md](ARCHITECTURE.md) for the code.

## Goal
Eventually **sell to small / retail investors** who want to spot trends and "see things
better" — a B2C subscription product, not selling the company.

## Positioning (decided)
> **Your lens on the market — you choose what matters, we show it clearly and explain why.**

The user resolved the "value-investor vs. trend-follower" tension by choosing
**customization**: the "stalled stocks" screen is now *one lens among many*, not the whole
identity. As of 2026-09-02 the screener is a **spreadsheet** — sort and filter any column
from its header — which makes "one lens among many" literal. Guiding principles:
- **Opinionated defaults first, customization on top.** Never ship a blank canvas — it
  loses beginners, and "customizable screener" alone is not a moat (Finviz already does it).
  The default sort (1Y desc) + a few shipped saved screens are the opinionated layer.
- **The real moat is explanation + trust.** The "why it may be down" thesis plus sourced
  evidence (SEC filings, real analyst counts, real news) is what makes this ≠ another
  screener and ≠ finfluencer noise.

## Retention roadmap (agreed order)
1. **Watchlist** ✅ done — ★ stocks, own tab, persisted.
2. **Spreadsheet screener** ✅ done (2026-09-02) — sort + filter any column; state persists
   in `localStorage["ss-table"]` as `{sort, filters}` per table. This also retired the
   jargon-y filter bar and the "stall score" framing.
3. **Saved / named screens** ← NEXT. Persist a *list* of named `{sort, filters}` objects
   (the `ss-table` shape is already the unit), add a small picker above the table, and ship
   a few great presets ("Dead money", "Cheap growers", "Momentum leaders") that users clone
   and tweak. Small extension of the existing `localStorage` pattern.
4. **Alerts** — "tell me when one of my names crosses a threshold / gets news." The daily
   habit loop and a natural paywall.

Also queued (cheap, high-value):
- **"What changed since last visit" digest** — the reason to open it daily.
- **Custom columns** — let users pick which windows/metrics show; the column model
  (`tableCols()`) already makes this a data change, not a rewrite.
- **Plain-language everywhere** — the screener is de-jargoned; the **Weights** tab and some
  detail-page chart headings still lean technical.

## Monetization shape
- **Free:** the default lenses + one saved screen.
- **Pro:** unlimited saved screens, watchlist alerts, custom columns, full history.
The architecture already supports this split.

## Honest caveats (flagged to the user)
- **Data source:** yfinance = Yahoo *scraping*. Fine for a prototype; **not sellable**
  (ToS, reliability, rate limits). A real product needs **licensed market data** — price
  that in early.
- **Not investment advice.** The app is a research-idea generator; keep the disclaimer and
  the "here's where to look" framing central (it's a trust asset).

## How an investor "sees" it (design lens)
Investors don't think in "trailing windows" — they think in stories ("why is my Pfizer
dead money", "is energy back"). They want orientation, a narrative, and *their* stocks —
not a 503-row spreadsheet as the front door. The spreadsheet is the power-user surface;
bias future work toward the layers *above* it: saved screens as named stories, the
watchlist, "what changed since last visit", and letting the chart *say something*
(annotations like "flat while its sector rose 18%").

## Open questions for a future session
- Precompute freshness cadence — is twice-daily enough, or add more Action runs?
- When to introduce accounts/auth (needed for cross-device watchlists, alerts, billing)?
- Which licensed data provider when moving past yfinance?
- The 11-bar detail return chart is now chronological + zero-anchored + extremes-labelled
  (2026-09-03); a short/long split or capped scale is still open if a huge outlier window
  (e.g. +503%) compresses the rest too much.
