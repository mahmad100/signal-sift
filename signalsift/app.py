"""Flask app: dashboard + JSON API for Signal Sift."""
import os

from flask import Flask, jsonify, render_template, request

import config
from . import analysts, cache, company, edgar, screener

app = Flask(
    __name__,
    template_folder=os.path.join(config.BASE_DIR, "templates"),
    static_folder=os.path.join(config.BASE_DIR, "static"),
)


@app.route("/")
def index():
    # index.html opens with the intro splash overlay (plays on every load), then
    # reveals the dashboard. See templates/index.html #ss-intro + static/styles.css.
    return render_template("index.html")


def _ceiling_arg():
    c = request.args.get("ceiling")
    return float(c) if c not in (None, "") else None


@app.route("/api/screen")
def api_screen():
    force = request.args.get("refresh") == "1"
    payload = screener.run_screen(force=force)

    sector = request.args.get("sector") or None
    ceiling = _ceiling_arg()
    status = request.args.get("status", "all")
    over = request.args.get("over", "1Y")
    sort = request.args.get("sort") or None
    direction = request.args.get("direction", "desc")

    rows = screener.filter_rows(payload, sector=sector, ceiling=ceiling,
                                status=status, over=over, sort=sort,
                                direction=direction)

    # Headline growing/stalled counts over the reference window (sector-scoped).
    ceil = payload["stall_ceiling"] if ceiling is None else ceiling
    scope = [r for r in payload["rows"] if not sector or r["sector"] == sector]
    grow = sum(1 for r in scope if r["returns"].get(over) is not None
               and r["returns"][over] > ceil)
    stall = sum(1 for r in scope if r["returns"].get(over) is not None
                and r["returns"][over] <= ceil)
    sectors = sorted({r["sector"] for r in payload["rows"] if r["sector"]})

    return jsonify({
        "generated_at": payload["generated_at"],
        "cache_age_seconds": cache.age_seconds("screen_latest"),
        "windows": payload["windows"],
        "benchmark": payload["benchmark"],
        "benchmark_returns": payload["benchmark_returns"],
        "stall_ceiling": ceil,
        "over": over,
        "universe_size": payload["universe_size"],
        "evaluated": payload["evaluated"],
        "matched": len(rows),
        "growing_count": grow,
        "stalled_count": stall,
        "sectors": sectors,
        "rows": rows,
    })


@app.route("/api/sectors")
def api_sectors():
    payload = screener.run_screen(force=request.args.get("refresh") == "1")
    over = request.args.get("over", "1Y")
    stats = screener.sector_stats(payload, over=over, ceiling=_ceiling_arg())
    return jsonify(stats)


@app.route("/api/detail/<ticker>")
def api_detail(ticker):
    ticker = ticker.upper()
    filings = edgar.recent_filings(ticker)
    expect = analysts.expectations(ticker)
    return jsonify({
        "ticker": ticker,
        "filings": filings,
        "analysts": expect,
        "why": _why_notes(expect),
    })


@app.route("/company/<ticker>")
def company_page(ticker):
    return render_template("company.html", ticker=ticker.upper())


@app.route("/api/company/<ticker>")
def api_company(ticker):
    return jsonify(company.profile(ticker))


def _why_notes(expect):
    """Cheap heuristic bullets pointing at where to look for the 'why'."""
    notes = []
    tg = expect.get("targets", {})
    rt = expect.get("rating", {})
    up = tg.get("upside_pct")
    if up is not None:
        if up > 0.15:
            notes.append(f"Analysts see ~{up*100:.0f}% upside to mean target — "
                         "price may be lagging fundamentals.")
        elif up < 0:
            notes.append(f"Price sits above mean target ({up*100:.0f}%) — "
                         "little analyst room to run.")
    if rt.get("key"):
        notes.append(f"Consensus rating: {rt['key']} "
                     f"({rt.get('num_analysts') or '?'} analysts).")
    notes.append("Check the latest 8-K / 10-Q filings below for guidance cuts, "
                 "litigation, or slowing growth.")
    return notes


def create_app():
    return app
