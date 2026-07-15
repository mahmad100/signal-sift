# Signal Sift — Strategy & Roadmap

Direction, positioning, and what's next. See [HANDOFF.md](HANDOFF.md) to resume and
[ARCHITECTURE.md](ARCHITECTURE.md) for the code.

## Goal
Eventually **sell to small / retail investors** who want to spot trends and "see things
better" — a B2C subscription product, not selling the company.

## Positioning (decided)
> **Your lens on the market — you choose what matters, we show it clearly and explain why.**

The user resolved the "value-investor vs. trend-follower" tension by choosing
**customization**: the "stalled stocks" screen is now *one lens among many*, not the whole
identity. Guiding principles:
- **Opinionated defaults first, customization on top.** Never ship a blank canvas — it
  loses beginners, and "customizable screener" alone is not a moat (Finviz already does it).
- **The real moat is explanation + trust.** The "why it's stalled" thesis plus sourced
  evidence (SEC filings, real analyst counts, real news) is what makes this ≠ another
  screener and ≠ finfluencer noise.

## Retention roadmap (agreed order)
1. **Watchlist** ✅ done — ★ stocks, own tab, persisted.
2. **Saved / named screens** ← NEXT. Turn the filter bar (status · window · sort · sector ·
   growth line · search) into named, reusable lenses ("My dead-money screen", "Cheap
   growers", "Momentum leaders"). Small extension of the existing filter + `localStorage`
   pattern. Ship a few great presets that users can clone and tweak.
3. **Alerts** — "tell me when one of my names goes stalled / gets news." This is the daily
   habit loop and a natural paywall.

Also queued (cheap, high-value):
- **Plain-language relabeling** — investors think "dead money" / "on a run" / "falling
  knife", not "stall score 11". Nearly free, big perceived-value jump.
- **"What changed since last visit" digest** — the reason to open it daily.
- **Custom columns** — let users pick which windows/metrics show in the table.

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
Investors don't think in "trailing windows" and "stall scores" — they think in stories
("why is my Pfizer dead money", "is energy back"). They want orientation, a narrative, and
*their* stocks — not a 503-row table as the front door. Bias future work toward: their
watchlist, plain language, "what changed", and letting the chart *say something*
(annotations like "flat while its sector rose 18%").

## Open questions for a future session
- Precompute freshness cadence — is twice-daily enough, or add more Action runs?
- When to introduce accounts/auth (needed for cross-device watchlists, alerts, billing)?
- Which licensed data provider when moving past yfinance?
- Split the 11-bar detail return chart into short/long groups?
