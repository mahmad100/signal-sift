// Pitchbook profile renderer — inline SVG charts, theme-aware, no external deps.
// Shared by the standalone /company page and the SPA detail tab.
let C = { accent: "#4c9aff", up: "#3fb950", down: "#f85149", flat: "#d29922",
          muted: "#8b96a5", line: "#2a3140", panel: "#1c2230", text: "#e6edf3" };

function palette() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  C = {
    accent: g("--accent", C.accent), up: g("--up", C.up), down: g("--down", C.down),
    flat: g("--flat", C.flat), muted: g("--muted", C.muted), line: g("--line", C.line),
    panel: g("--panel2", C.panel), text: g("--text", C.text),
  };
  return C;
}

const fmtPct = (v, d = 1) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
const cls = (v) => v == null ? "na" : v > 0.02 ? "ret-up" : v < -0.02 ? "ret-down" : "ret-flat";
const num = (v, d = 2) => v == null ? "—" : Number(v).toFixed(d);

function money(v) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}
const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function boot() {
  const ticker = document.getElementById("app").dataset.ticker;
  let p;
  try {
    const res = await fetch("/api/company/" + encodeURIComponent(ticker));
    p = await res.json();
  } catch (e) {
    document.getElementById("pbBody").innerHTML = `<p class="na">Failed to load ${ticker}: ${e}</p>`;
    return;
  }
  document.getElementById("pbBody").innerHTML = buildProfileHTML(p);
}

function buildProfileHTML(p) {
  palette();
  const id = p.identity, mk = p.market, val = p.valuation, pr = p.profitability;
  const dc = mk.day_change;

  let html = "";

  // ---- Hero ----
  html += `<header class="hero">
    <div>
      <div class="hero-tk">${p.ticker}</div>
      <div class="hero-name">${esc(id.name)}</div>
      <div class="chips">
        ${id.sector ? `<span class="chip">${esc(id.sector)}</span>` : ""}
        ${id.industry ? `<span class="chip">${esc(id.industry)}</span>` : ""}
        ${id.country ? `<span class="chip">${esc(id.city ? id.city + ", " : "")}${esc(id.country)}</span>` : ""}
        ${id.website ? `<a class="chip link" href="${esc(id.website)}" target="_blank" rel="noopener">${esc(id.website.replace(/^https?:\/\//, ""))} ↗</a>` : ""}
      </div>
    </div>
    <div class="hero-px">
      <div class="px">${mk.price != null ? "$" + num(mk.price) : "—"}</div>
      <div class="${cls(dc)}">${fmtPct(dc, 2)} today</div>
    </div>
  </header>`;

  // ---- KPI tiles ----
  const range52 = (mk.week52_low != null && mk.week52_high != null && mk.price != null)
    ? (mk.price - mk.week52_low) / (mk.week52_high - mk.week52_low) : null;
  const tiles = [
    ["Market cap", money(mk.market_cap)],
    ["Trailing P/E", num(val.trailing_pe, 1)],
    ["Forward P/E", num(val.forward_pe, 1)],
    ["Div yield", mk.dividend_yield != null ? fmtPct(mk.dividend_yield > 1 ? mk.dividend_yield / 100 : mk.dividend_yield) : "—"],
    ["Beta", num(mk.beta, 2)],
    ["52-wk range", range52 != null ? `${(range52 * 100).toFixed(0)}%` : "—"],
    ["Analysts", p.analyst_count != null ? p.analyst_count : "—"],
  ];
  html += `<div class="tiles">` + tiles.map(([k, v]) =>
    `<div class="tile"><div class="tk-k">${k}</div><div class="tk-v">${v}</div></div>`).join("") + `</div>`;

  // ---- Charts row ----
  html += `<div class="grid2">
    <div class="card wide"><h3>Price vs. S&amp;P 500 — 5-year trend (indexed to 100)</h3>
      ${lineChart(p.history)}
      <div class="legend"><span><i style="background:${C.accent}"></i>${p.ticker}</span><span><i style="background:${C.muted}"></i>SPY</span></div>
    </div>
    <div class="card"><h3>Trailing returns vs. SPY</h3>${returnBars(p.returns, p.excess)}</div>
  </div>`;

  // ---- Peer comparison (SPA injects p._peers) ----
  if (p._peers) html += peerSection(p._peers, p.returns);

  // ---- Thesis ----
  html += `<div class="card thesis"><h3>Why it may be stalled</h3><ul class="why">` +
    (p.why || []).map((w) => `<li>${esc(w)}</li>`).join("") + `</ul></div>`;

  // ---- Business summary ----
  if (id.summary) {
    html += `<div class="card"><h3>Business</h3><p class="summary">${esc(id.summary)}</p>
      ${id.employees ? `<div class="sub2">${id.employees.toLocaleString()} employees</div>` : ""}</div>`;
  }

  // ---- Valuation + profitability ----
  html += `<div class="grid2">
    <div class="card"><h3>Valuation</h3>${kvRows([
      ["Trailing P/E", num(val.trailing_pe, 1) + "x"],
      ["Forward P/E", num(val.forward_pe, 1) + "x"],
      ["PEG", num(val.peg, 2)],
      ["Price / book", num(val.price_to_book, 2) + "x"],
      ["Price / sales", num(val.price_to_sales, 2) + "x"],
      ["EV / EBITDA", num(val.ev_ebitda, 1) + "x"],
    ])}</div>
    <div class="card"><h3>Profitability &amp; growth</h3>${kvRows([
      ["Gross margin", fmtPct(pr.gross_margin)],
      ["Operating margin", fmtPct(pr.operating_margin)],
      ["Net margin", fmtPct(pr.profit_margin)],
      ["Return on equity", fmtPct(pr.roe)],
      ["Revenue growth", fmtPct(pr.revenue_growth)],
      ["Earnings growth", fmtPct(pr.earnings_growth)],
    ], true)}</div>
  </div>`;

  // ---- Fundamentals ----
  html += fundamentalsSection(p.fundamentals, p.pe_history);

  // ---- Analysts ----
  const a = p.analysts || {}, t = a.targets || {}, rt = a.rating || {};
  html += `<div class="grid2">
    <div class="card"><h3>Analyst price target</h3>
      ${targetGauge(t)}
      ${kvRows([
        ["Consensus", rt.key ? `${rt.key} (${rt.num_analysts ?? "?"} analysts)` : "—"],
        ["Mean target", t.mean != null ? "$" + num(t.mean) : "—"],
        ["Upside to mean", t.upside_pct != null ? fmtPct(t.upside_pct) : "—"],
      ])}
    </div>
    <div class="card"><h3>Rating distribution</h3>${ratingBar(a.recommendations)}</div>
  </div>`;

  // ---- News ----
  html += newsCard(p.news);

  // ---- Filings ----
  const f = p.filings || {};
  html += `<div class="card"><h3>Recent SEC filings</h3>`;
  if (f.error) html += `<div class="na">${esc(f.error)}</div>`;
  if (f.filings && f.filings.length) {
    html += f.filings.map((x) =>
      `<div class="filing"><span class="form">${x.form}</span>
       <a href="${x.url}" target="_blank" rel="noopener">${esc(x.description) || "View filing"}</a>
       <span class="na">${x.date}</span></div>`).join("");
  } else if (!f.error) html += `<div class="na">No recent notable filings.</div>`;
  if (f.edgar_url) html += `<div style="margin-top:10px"><a class="ext" href="${f.edgar_url}" target="_blank" rel="noopener">Full EDGAR history →</a></div>`;
  html += `</div>`;

  html += `<div class="disclaimer">Signal Sift is a research-idea generator, not investment advice. Data: Yahoo Finance &amp; SEC EDGAR.</div>`;

  return html;
}

function newsCard(news) {
  news = news || { items: [], tally: {}, count: 0 };
  const items = news.items || [];
  const dot = { positive: "sent-pos", negative: "sent-neg", neutral: "sent-neu" };
  const label = { positive: "▲", negative: "▼", neutral: "•" };
  const ty = news.tally || {};
  let head = `<div class="newsmix">
    <span class="sent-pos">${ty.positive || 0} positive</span>
    <span class="sent-neu">${ty.neutral || 0} neutral</span>
    <span class="sent-neg">${ty.negative || 0} negative</span>
    <span class="na">· ${news.count || 0} recent headlines</span></div>`;
  if (!items.length)
    return `<div class="card"><h3>In the news</h3><div class="na">No recent headlines found.</div></div>`;
  const rows = items.map((n) =>
    `<div class="newsrow">
       <span class="sentdot ${dot[n.sentiment]}" title="${n.sentiment}">${label[n.sentiment]}</span>
       <a href="${n.url || "#"}" target="_blank" rel="noopener">${esc(n.title)}</a>
       <span class="na newsmeta">${esc(n.publisher)}${n.published ? " · " + n.published : ""}</span>
     </div>`).join("");
  return `<div class="card"><h3>In the news — how ${""}it's being mentioned</h3>${head}${rows}</div>`;
}

function kvRows(rows, colorize = false) {
  return rows.map(([k, v]) => {
    const c = colorize && typeof v === "string" && v.includes("%")
      ? (v.startsWith("+") ? "ret-up" : v.startsWith("-") ? "ret-down" : "") : "";
    return `<div class="kv"><span class="k">${k}</span><span class="${c}">${v}</span></div>`;
  }).join("");
}

// ---------- SVG charts ----------
function lineChart(hist) {
  const s = (hist && hist.series) || [], b = (hist && hist.benchmark) || [];
  if (s.length < 2) return `<div class="na">No price history.</div>`;
  const W = 820, H = 300, pad = 34;
  const all = s.map((d) => d.n).concat(b.map((d) => d.n));
  let lo = Math.min(...all), hi = Math.max(...all);
  const padY = (hi - lo) * 0.08 || 1; lo -= padY; hi += padY;
  const x = (i, arr) => pad + (i / (arr.length - 1)) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad);
  const path = (arr) => arr.map((d, i) => `${i ? "L" : "M"}${x(i, arr).toFixed(1)},${y(d.n).toFixed(1)}`).join(" ");
  const area = `${path(s)} L${x(s.length - 1, s).toFixed(1)},${(H - pad)} L${pad},${(H - pad)} Z`;
  const y100 = y(100);
  const first = s[0].t, last = s[s.length - 1].t;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none" role="img">
    <line x1="${pad}" y1="${y(hi).toFixed(1)}" x2="${W - pad}" y2="${y(hi).toFixed(1)}" stroke="${C.line}"/>
    <line x1="${pad}" y1="${y(lo).toFixed(1)}" x2="${W - pad}" y2="${y(lo).toFixed(1)}" stroke="${C.line}"/>
    <line x1="${pad}" y1="${y100.toFixed(1)}" x2="${W - pad}" y2="${y100.toFixed(1)}" stroke="${C.muted}" stroke-dasharray="4 4" opacity="0.5"/>
    <path d="${area}" fill="${C.accent}" opacity="0.12"/>
    <path d="${path(b)}" fill="none" stroke="${C.muted}" stroke-width="1.5"/>
    <path d="${path(s)}" fill="none" stroke="${C.accent}" stroke-width="2.2"/>
    <text x="${pad}" y="${(H - 8)}" fill="${C.muted}" font-size="11">${first}</text>
    <text x="${W - pad}" y="${(H - 8)}" fill="${C.muted}" font-size="11" text-anchor="end">${last}</text>
    <text x="${W - pad}" y="${(y(hi) + 12).toFixed(1)}" fill="${C.muted}" font-size="11" text-anchor="end">${hi.toFixed(0)}</text>
    <text x="${W - pad}" y="${(y(lo) - 4).toFixed(1)}" fill="${C.muted}" font-size="11" text-anchor="end">${lo.toFixed(0)}</text>
  </svg>`;
}

function returnBars(rets, excess) {
  const wins = Object.keys(rets);
  if (!wins.length) return `<div class="na">No return data.</div>`;
  const W = 420, H = 260, pad = 26, base = H / 2;
  const bench = {}, vals = [];
  wins.forEach((w) => {
    bench[w] = (rets[w] != null && excess[w] != null) ? rets[w] - excess[w] : null;
    if (rets[w] != null) vals.push(Math.abs(rets[w]));
    if (bench[w] != null) vals.push(Math.abs(bench[w]));
  });
  const max = Math.max(0.05, ...vals);
  const bw = (W - 2 * pad) / wins.length;
  const yv = (v) => base - (v / max) * (base - pad);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">
    <line x1="${pad}" y1="${base}" x2="${W - pad}" y2="${base}" stroke="${C.muted}" opacity="0.6"/>`;
  wins.forEach((w, i) => {
    const cx = pad + bw * i + bw / 2;
    const r = rets[w], bv = bench[w];
    if (r != null) {
      const col = r > 0.02 ? C.up : r < -0.02 ? C.down : C.flat;
      const yTop = Math.min(base, yv(r)), h = Math.abs(base - yv(r));
      svg += `<rect x="${cx - bw * 0.28}" y="${yTop.toFixed(1)}" width="${(bw * 0.56).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="${col}"/>`;
      svg += `<text x="${cx}" y="${(r >= 0 ? yTop - 5 : yTop + h + 12).toFixed(1)}" fill="${C.text}" font-size="10" text-anchor="middle">${fmtPct(r, 0)}</text>`;
    }
    if (bv != null) {
      svg += `<line x1="${cx - bw * 0.32}" y1="${yv(bv).toFixed(1)}" x2="${cx + bw * 0.32}" y2="${yv(bv).toFixed(1)}" stroke="${C.muted}" stroke-width="2"/>`;
    }
    svg += `<text x="${cx}" y="${H - 7}" fill="${C.muted}" font-size="11" text-anchor="middle">${w}</text>`;
  });
  svg += `</svg><div class="legend"><span><i style="background:${C.accent};"></i>stock return</span><span><i style="background:${C.muted}"></i>SPY (tick)</span></div>`;
  return svg;
}

function targetGauge(t) {
  if (t.low == null || t.high == null || t.current == null)
    return `<div class="na" style="margin-bottom:10px">Analyst targets unavailable.</div>`;
  const W = 380, H = 70, pad = 16;
  const lo = Math.min(t.low, t.current), hi = Math.max(t.high, t.current);
  const span = hi - lo || 1;
  const x = (v) => pad + ((v - lo) / span) * (W - 2 * pad);
  const mk = (v, col, label, up) => v == null ? "" :
    `<line x1="${x(v).toFixed(1)}" y1="18" x2="${x(v).toFixed(1)}" y2="46" stroke="${col}" stroke-width="2"/>
     <text x="${x(v).toFixed(1)}" y="${up ? 12 : 60}" fill="${col}" font-size="10" text-anchor="middle">${label} $${v.toFixed(0)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="gauge" role="img">
    <line x1="${x(t.low).toFixed(1)}" y1="32" x2="${x(t.high).toFixed(1)}" y2="32" stroke="${C.line}" stroke-width="6" stroke-linecap="round"/>
    ${mk(t.mean, C.accent, "mean", true)}
    ${mk(t.current, C.flat, "now", false)}
    ${mk(t.low, C.muted, "low", true)}
    ${mk(t.high, C.muted, "high", true)}
  </svg>`;
}

function ratingBar(recs) {
  if (!recs || !recs.length) return `<div class="na">Rating breakdown unavailable.</div>`;
  const r = recs[0];
  const seg = [
    ["Strong buy", r.strongBuy, C.up],
    ["Buy", r.buy, "#6fbf5f"],
    ["Hold", r.hold, C.flat],
    ["Sell", r.sell, "#e06c50"],
    ["Strong sell", r.strongSell, C.down],
  ].filter(([, v]) => v != null);
  const total = seg.reduce((s, [, v]) => s + (v || 0), 0);
  if (!total) return `<div class="na">Rating breakdown unavailable.</div>`;
  const W = 380, H = 26; let xacc = 0;
  let bars = "";
  seg.forEach(([, v, col]) => {
    const w = (v / total) * W; if (w <= 0) return;
    bars += `<rect x="${xacc.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${H}" fill="${col}"/>`;
    if (w > 24) bars += `<text x="${(xacc + w / 2).toFixed(1)}" y="17" fill="#06122a" font-size="11" font-weight="700" text-anchor="middle">${v}</text>`;
    xacc += w;
  });
  const legend = seg.map(([n, v, col]) =>
    `<span><i style="background:${col}"></i>${n} (${v})</span>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="ratingbar" preserveAspectRatio="none" role="img">${bars}</svg>
    <div class="legend wrap">${legend}</div>`;
}

// ---------- Fundamentals ----------
function fundamentalsSection(fu, pe) {
  if (!fu || fu.error || !fu.years || !fu.years.length) {
    return `<div class="card"><h3>Fundamentals</h3><div class="na">${
      esc((fu && fu.error) || "No financial statements available.")}</div></div>`;
  }
  const yr = fu.years;
  const mBn = (v) => (v == null ? "—" : money(v));
  const q = fu.quarterly || { labels: [] };

  let html = `<h2 class="secdiv">Fundamentals — ${yr[0]}–${yr[yr.length - 1]}</h2>`;

  html += `<div class="grid2">
    <div class="card"><h3>Revenue &amp; YoY growth</h3>${barsWithLine(yr, fu.revenue, fu.revenue_yoy, {
      barColor: C.accent, lineColor: C.flat, barFmt: money })}</div>
    <div class="card"><h3>Margins</h3>${multiLine(yr, [
      { name: "Gross", values: fu.gross_margin, color: C.accent },
      { name: "Operating", values: fu.operating_margin, color: C.flat },
      { name: "Net", values: fu.net_margin, color: C.up },
    ])}</div>
  </div>`;

  html += `<div class="grid2">
    <div class="card"><h3>Net income</h3>${barChart(yr, fu.net_income, {
      fmt: money, colorFn: (v) => (v >= 0 ? C.up : C.down) })}</div>
    <div class="card"><h3>Free cash flow</h3>${barChart(yr, fu.free_cash_flow, {
      fmt: money, colorFn: (v) => (v >= 0 ? C.up : C.down) })}</div>
  </div>`;

  html += `<div class="grid2">
    <div class="card"><h3>Diluted EPS</h3>${barChart(yr, fu.eps, {
      fmt: (v) => "$" + num(v, 2), colorFn: (v) => (v >= 0 ? C.accent : C.down) })}</div>
    <div class="card"><h3>Valuation history — year-end P/E</h3>${peHistoryChart(pe)}</div>
  </div>`;

  if (q.labels && q.labels.length) {
    html += `<div class="card"><h3>Quarterly revenue &amp; net income</h3>${groupedBars(q.labels, [
      { name: "Revenue", values: q.revenue, color: C.accent },
      { name: "Net income", values: q.net_income, color: C.up },
    ], money)}</div>`;
  }

  // Database-style statement table.
  const rows = [
    ["Revenue", fu.revenue, money], ["Gross profit", fu.gross_profit, money],
    ["Operating income", fu.operating_income, money], ["Net income", fu.net_income, money],
    ["EBITDA", fu.ebitda, money], ["Diluted EPS", fu.eps, (v) => "$" + num(v, 2)],
    ["Free cash flow", fu.free_cash_flow, money], ["R&D", fu.rnd, money],
    ["Total debt", fu.total_debt, money], ["Equity", fu.equity, money],
    ["Gross margin", fu.gross_margin, fmtPct], ["Operating margin", fu.operating_margin, fmtPct],
    ["Net margin", fu.net_margin, fmtPct], ["Revenue YoY", fu.revenue_yoy, fmtPct],
    ["EPS YoY", fu.eps_yoy, fmtPct],
  ];
  const head = `<tr><th>Metric</th>${yr.map((y) => `<th class="num">${y}</th>`).join("")}</tr>`;
  const body = rows.map(([label, vals, fmt]) => {
    if (!vals) return "";
    const cells = yr.map((_, i) => {
      const v = vals[i];
      const cl = fmt === fmtPct ? cls(v) : "";
      return `<td class="num ${cl}">${v == null ? "—" : fmt(v)}</td>`;
    }).join("");
    return `<tr><td class="metric">${label}</td>${cells}</tr>`;
  }).join("");
  html += `<div class="card"><h3>Statement detail</h3><div class="tablewrap">
    <table class="fundtable"><thead>${head}</thead><tbody>${body}</tbody></table></div></div>`;

  return html;
}

// ---------- Generic fundamental charts (theme-aware via C) ----------
function _bounds(all) {
  const v = all.filter((x) => x != null);
  if (!v.length) return null;
  let lo = Math.min(0, ...v), hi = Math.max(0, ...v);
  if (lo === hi) hi = lo + 1;
  return { lo, hi };
}

function barChart(labels, values, opts = {}) {
  const b = _bounds(values || []);
  if (!b) return `<div class="na">No data.</div>`;
  const fmt = opts.fmt || ((v) => v);
  const W = 420, H = 230, padT = 22, padB = 26, padX = 10;
  const n = labels.length, bw = (W - 2 * padX) / n;
  const y = (v) => padT + (1 - (v - b.lo) / (b.hi - b.lo)) * (H - padT - padB);
  const y0 = y(0);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">
    <line x1="${padX}" y1="${y0.toFixed(1)}" x2="${W - padX}" y2="${y0.toFixed(1)}" stroke="${C.muted}" opacity=".5"/>`;
  labels.forEach((lab, i) => {
    const v = values[i], cx = padX + bw * i + bw / 2;
    if (v != null) {
      const col = opts.color || (opts.colorFn ? opts.colorFn(v) : C.accent);
      const top = Math.min(y0, y(v)), h = Math.max(1, Math.abs(y0 - y(v)));
      svg += `<rect x="${cx - bw * 0.3}" y="${top.toFixed(1)}" width="${(bw * 0.6).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${col}"/>`;
      svg += `<text x="${cx}" y="${(v >= 0 ? top - 5 : top + h + 12).toFixed(1)}" fill="${C.text}" font-size="9.5" text-anchor="middle">${fmt(v)}</text>`;
    }
    svg += `<text x="${cx}" y="${H - 8}" fill="${C.muted}" font-size="10.5" text-anchor="middle">${lab}</text>`;
  });
  return svg + `</svg>`;
}

function groupedBars(labels, series, fmt) {
  const all = series.flatMap((s) => s.values || []);
  const b = _bounds(all);
  if (!b) return `<div class="na">No data.</div>`;
  const W = 420, H = 230, padT = 22, padB = 26, padX = 10;
  const n = labels.length, k = series.length, group = (W - 2 * padX) / n, bw = group * 0.72 / k;
  const y = (v) => padT + (1 - (v - b.lo) / (b.hi - b.lo)) * (H - padT - padB);
  const y0 = y(0);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">
    <line x1="${padX}" y1="${y0.toFixed(1)}" x2="${W - padX}" y2="${y0.toFixed(1)}" stroke="${C.muted}" opacity=".5"/>`;
  labels.forEach((lab, i) => {
    const gx = padX + group * i + group * 0.14;
    series.forEach((s, j) => {
      const v = (s.values || [])[i];
      if (v == null) return;
      const x = gx + bw * j, top = Math.min(y0, y(v)), h = Math.max(1, Math.abs(y0 - y(v)));
      svg += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${s.color}"/>`;
    });
    svg += `<text x="${(padX + group * i + group / 2).toFixed(1)}" y="${H - 8}" fill="${C.muted}" font-size="10.5" text-anchor="middle">${lab}</text>`;
  });
  svg += `</svg><div class="legend">` +
    series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("") + `</div>`;
  return svg;
}

function multiLine(labels, series) {
  const all = series.flatMap((s) => s.values || []).filter((v) => v != null);
  if (!all.length) return `<div class="na">No data.</div>`;
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.12 || 0.02; lo -= pad; hi += pad;
  const W = 420, H = 230, padT = 16, padB = 26, padX = 30;
  const n = labels.length;
  const x = (i) => padX + (n === 1 ? 0.5 : i / (n - 1)) * (W - padX - 10);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">`;
  [hi, (hi + lo) / 2, lo].forEach((gv) => {
    svg += `<line x1="${padX}" y1="${y(gv).toFixed(1)}" x2="${W - 10}" y2="${y(gv).toFixed(1)}" stroke="${C.line}"/>
      <text x="${padX - 4}" y="${(y(gv) + 3).toFixed(1)}" fill="${C.muted}" font-size="9.5" text-anchor="end">${(gv * 100).toFixed(0)}%</text>`;
  });
  labels.forEach((lab, i) =>
    svg += `<text x="${x(i).toFixed(1)}" y="${H - 8}" fill="${C.muted}" font-size="10.5" text-anchor="middle">${lab}</text>`);
  series.forEach((s) => {
    const pts = (s.values || []).map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
    if (pts.length) svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.2"/>`;
    (s.values || []).forEach((v, i) => { if (v != null) svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6" fill="${s.color}"/>`; });
  });
  svg += `</svg><div class="legend">` +
    series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("") + `</div>`;
  return svg;
}

// Bars (left axis) with a line overlay (right axis, e.g. YoY %).
function barsWithLine(labels, barVals, lineVals, opts = {}) {
  const bb = _bounds(barVals || []);
  if (!bb) return `<div class="na">No data.</div>`;
  const barFmt = opts.barFmt || ((v) => v);
  const W = 420, H = 230, padT = 22, padB = 26, padL = 10, padR = 34;
  const n = labels.length, bw = (W - padL - padR) / n;
  const yb = (v) => padT + (1 - (v - bb.lo) / (bb.hi - bb.lo)) * (H - padT - padB);
  const y0 = yb(0);

  const lv = (lineVals || []).filter((v) => v != null);
  const lb = lv.length ? { lo: Math.min(0, ...lv), hi: Math.max(0, ...lv) } : null;
  if (lb && lb.lo === lb.hi) lb.hi = lb.lo + 0.01;
  const yl = (v) => padT + (1 - (v - lb.lo) / (lb.hi - lb.lo)) * (H - padT - padB);

  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">
    <line x1="${padL}" y1="${y0.toFixed(1)}" x2="${W - padR}" y2="${y0.toFixed(1)}" stroke="${C.muted}" opacity=".4"/>`;
  labels.forEach((lab, i) => {
    const v = barVals[i], cx = padL + bw * i + bw / 2;
    if (v != null) {
      const top = Math.min(y0, yb(v)), h = Math.max(1, Math.abs(y0 - yb(v)));
      svg += `<rect x="${cx - bw * 0.3}" y="${top.toFixed(1)}" width="${(bw * 0.6).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${opts.barColor || C.accent}"/>`;
      svg += `<text x="${cx}" y="${(top - 5).toFixed(1)}" fill="${C.text}" font-size="9" text-anchor="middle">${barFmt(v)}</text>`;
    }
    svg += `<text x="${cx}" y="${H - 8}" fill="${C.muted}" font-size="10.5" text-anchor="middle">${lab}</text>`;
  });
  if (lb) {
    const pts = (lineVals || []).map((v, i) => v == null ? null :
      `${(padL + bw * i + bw / 2).toFixed(1)},${yl(v).toFixed(1)}`).filter(Boolean);
    if (pts.length) svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${opts.lineColor || C.flat}" stroke-width="2.2"/>`;
    (lineVals || []).forEach((v, i) => {
      if (v == null) return;
      const cx = padL + bw * i + bw / 2;
      svg += `<circle cx="${cx.toFixed(1)}" cy="${yl(v).toFixed(1)}" r="2.6" fill="${opts.lineColor || C.flat}"/>`;
      svg += `<text x="${cx.toFixed(1)}" y="${(yl(v) - 6).toFixed(1)}" fill="${opts.lineColor || C.flat}" font-size="9" text-anchor="middle">${(v * 100).toFixed(0)}%</text>`;
    });
  }
  svg += `</svg><div class="legend"><span><i style="background:${opts.barColor || C.accent}"></i>Revenue</span><span><i style="background:${opts.lineColor || C.flat}"></i>YoY growth</span></div>`;
  return svg;
}

function peHistoryChart(pe) {
  if (!pe || !pe.pe || !pe.pe.some((v) => v != null))
    return `<div class="na">P/E history unavailable.</div>`;
  return multiLineRaw(pe.years, [{ name: "P/E", values: pe.pe, color: C.accent }],
    (v) => v.toFixed(0) + "x");
}

// Line chart for non-percent values (e.g. P/E multiple).
function multiLineRaw(labels, series, fmt) {
  const all = series.flatMap((s) => s.values || []).filter((v) => v != null);
  if (!all.length) return `<div class="na">No data.</div>`;
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.15 || 1; lo = Math.max(0, lo - pad); hi += pad;
  const W = 420, H = 230, padT = 16, padB = 26, padX = 34;
  const n = labels.length;
  const x = (i) => padX + (n === 1 ? 0.5 : i / (n - 1)) * (W - padX - 10);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">`;
  [hi, (hi + lo) / 2, lo].forEach((gv) => {
    svg += `<line x1="${padX}" y1="${y(gv).toFixed(1)}" x2="${W - 10}" y2="${y(gv).toFixed(1)}" stroke="${C.line}"/>
      <text x="${padX - 4}" y="${(y(gv) + 3).toFixed(1)}" fill="${C.muted}" font-size="9.5" text-anchor="end">${fmt(gv)}</text>`;
  });
  labels.forEach((lab, i) =>
    svg += `<text x="${x(i).toFixed(1)}" y="${H - 8}" fill="${C.muted}" font-size="10.5" text-anchor="middle">${lab}</text>`);
  series.forEach((s) => {
    const pts = (s.values || []).map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean);
    if (pts.length) svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.2"/>`;
    (s.values || []).forEach((v, i) => {
      if (v == null) return;
      svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.8" fill="${s.color}"/>`;
      svg += `<text x="${x(i).toFixed(1)}" y="${(y(v) - 7).toFixed(1)}" fill="${C.text}" font-size="9.5" text-anchor="middle">${fmt(v)}</text>`;
    });
  });
  return svg + `</svg>`;
}

// Peer comparison vs sector median (data injected by the SPA as p._peers).
function peerSection(peers, stockReturns) {
  if (!peers) return "";
  const wins = ["1M", "3M", "6M", "12M"].filter((w) => stockReturns[w] != null);
  const rankTxt = peers.rank
    ? `Ranks <b>#${peers.rank}</b> of ${peers.count} in ${esc(peers.sector)} by 12-month return.`
    : "";
  const chart = groupedBars(wins, [
    { name: "This stock", values: wins.map((w) => stockReturns[w]), color: C.accent },
    { name: `${esc(peers.sector)} median`, values: wins.map((w) => peers.median[w]), color: C.flat },
    { name: "SPY", values: wins.map((w) => (peers.spy || {})[w]), color: C.muted },
  ], (v) => (v * 100).toFixed(0) + "%");
  return `<div class="card"><h3>Peers — vs ${esc(peers.sector)} sector</h3>
    <div class="sub2" style="margin:0 0 10px">${rankTxt}</div>${chart}</div>`;
}

// Only auto-boot on the standalone pitchbook page; the SPA calls
// buildProfileHTML() directly and reuses the chart helpers above.
if (document.body.classList.contains("pb")) boot();
