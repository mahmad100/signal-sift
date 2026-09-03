// Pitchbook profile renderer — inline SVG charts, theme-aware, no external deps.
// Shared by the standalone /company page and the SPA detail tab.
let C = { accent: "#4c9aff", up: "#3fb950", down: "#f85149", flat: "#d29922",
          muted: "#8b96a5", line: "#2a3140", panel: "#1c2230", text: "#e6edf3" };

// Fixed categorical palette for multi-series charts. The semantic theme tokens
// (accent / flat / up) collide on some themes — accent === flat on Amber, near
// so on Carbon — which made two lines in one chart the same colour. These three
// hues stay put across every theme; order is fixed. Validated colourblind-safe
// (all-pairs) against both a dark and a light chart surface.
const SERIES = ["#3987e5", "#d95926", "#199e70"];

// Shared mark specs (SVG viewBox units; the fundamental charts use a ~420-wide
// box that renders ~500px, so 1 unit ≈ 1.2px). Thin marks, capped bars, generous
// air — the data is the only thing allowed to be loud.
const MARK = { barMax: 26, barGap: 2, radius: 4, line: 2, dot: 3.6, ring: 1.4 };

// A column rounded only at the data end (top for ≥0, bottom for <0) and square at
// the baseline, so every bar reads as growing from one line.
function barPath(x, w, yEnd, yBase, r) {
  r = Math.max(0, Math.min(r, w / 2, Math.abs(yBase - yEnd)));
  const f = (a, b) => `${a.toFixed(1)},${b.toFixed(1)}`;
  if (yEnd <= yBase) // points up
    return `M${f(x, yBase)} L${f(x, yEnd + r)} Q${f(x, yEnd)} ${f(x + r, yEnd)} `
      + `L${f(x + w - r, yEnd)} Q${f(x + w, yEnd)} ${f(x + w, yEnd + r)} L${f(x + w, yBase)} Z`;
  return `M${f(x, yBase)} L${f(x, yEnd - r)} Q${f(x, yEnd)} ${f(x + r, yEnd)} `
    + `L${f(x + w - r, yEnd)} Q${f(x + w, yEnd)} ${f(x + w, yEnd - r)} L${f(x + w, yBase)} Z`;
}

// Centre a bar in its slot, capped at MARK.barMax and leaving the surface gap.
function barBox(cx, slot, frac) {
  const w = Math.max(2, Math.min(slot * (frac ?? 1) - MARK.barGap, MARK.barMax));
  return { x: cx - w / 2, w };
}

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
      <div class="legend"><span><i class="line" style="background:${C.accent}"></i>${p.ticker}</span><span><i class="line" style="background:${C.muted}"></i>SPY</span></div>
    </div>
    <div class="card"><h3>Trailing returns vs. SPY</h3>${returnBars(p.returns, p.excess)}</div>
  </div>`;

  // ---- Peer comparison (SPA injects p._peers) ----
  if (p._peers) html += peerSection(p._peers, p.returns, p.ticker);

  // ---- Thesis ----
  html += `<div class="card thesis"><h3>Why it may be down</h3><ul class="why">` +
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
  const W = 840, H = 300, padL = 34, padR = 46, padT = 16, padB = 26;
  const all = s.map((d) => d.n).concat(b.map((d) => d.n));
  let lo = Math.min(...all), hi = Math.max(...all);
  const padY = (hi - lo) * 0.08 || 1; lo = Math.max(0, lo - padY); hi += padY;
  const x = (i, arr) => padL + (i / (arr.length - 1)) * (W - padL - padR);
  const y = (v) => H - padB - ((v - lo) / (hi - lo)) * (H - padT - padB);
  const path = (arr) => arr.map((d, i) => `${i ? "L" : "M"}${x(i, arr).toFixed(1)},${y(d.n).toFixed(1)}`).join(" ");
  const area = `${path(s)} L${x(s.length - 1, s).toFixed(1)},${y(lo).toFixed(1)} L${padL},${y(lo).toFixed(1)} Z`;
  const first = s[0].t, last = s[s.length - 1].t;
  const endS = s[s.length - 1].n, endB = b.length ? b[b.length - 1].n : null;
  const tick = (v) => `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="${C.line}"/>`
    + `<text x="${(W - padR + 6)}" y="${(y(v) + 3.5).toFixed(1)}" fill="${C.muted}" font-size="11">${v.toFixed(0)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">
    ${tick(hi)}${tick((hi + lo) / 2)}${tick(lo)}
    <line x1="${padL}" y1="${y(100).toFixed(1)}" x2="${W - padR}" y2="${y(100).toFixed(1)}" stroke="${C.muted}" opacity="0.5"/>
    <path d="${area}" fill="${C.accent}" opacity="0.10"/>
    <path d="${path(b)}" fill="none" stroke="${C.muted}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="${path(s)}" fill="none" stroke="${C.accent}" stroke-width="${MARK.line}" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(s.length - 1, s).toFixed(1)}" cy="${y(endS).toFixed(1)}" r="${MARK.dot}" fill="${C.accent}" stroke="${C.panel}" stroke-width="${MARK.ring}"/>
    ${endB != null ? `<circle cx="${x(b.length - 1, b).toFixed(1)}" cy="${y(endB).toFixed(1)}" r="${MARK.dot}" fill="${C.muted}" stroke="${C.panel}" stroke-width="${MARK.ring}"/>` : ""}
    <text x="${padL}" y="${(H - 8)}" fill="${C.muted}" font-size="11">${first}</text>
    <text x="${W - padR}" y="${(H - 8)}" fill="${C.muted}" font-size="11" text-anchor="end">${last}</text>
  </svg>`;
}

// Approx. calendar days for a "1D" / "3M" / "2Y" window token — used only to put
// the windows in chronological order (the API dict isn't ordered).
function winDays(w) {
  const m = String(w).match(/^(\d+)\s*([DWMY])$/i);
  if (!m) return 0;
  return +m[1] * { D: 1, W: 7, M: 30, Y: 365 }[m[2].toUpperCase()];
}

function returnBars(rets, excess) {
  const wins = Object.keys(rets).sort((a, b) => winDays(a) - winDays(b));
  if (!wins.length) return `<div class="na">No return data.</div>`;
  const bench = {}, all = [];
  wins.forEach((w) => {
    bench[w] = (rets[w] != null && excess[w] != null) ? rets[w] - excess[w] : null;
    if (rets[w] != null) all.push(rets[w]);
    if (bench[w] != null) all.push(bench[w]);
  });
  const b = _bounds(all);
  if (!b) return `<div class="na">No return data.</div>`;
  const W = 440, H = 244, padX = 14, padTop = 26, padBot = 28;
  const slot = (W - 2 * padX) / wins.length;
  const y = (v) => padTop + (1 - (v - b.lo) / (b.hi - b.lo)) * (H - padTop - padBot);
  const y0 = y(0);
  // Direct-label only the extremes; every value is in the hover title.
  let hiW = null, loW = null;
  wins.forEach((w) => {
    if (rets[w] == null) return;
    if (hiW == null || rets[w] > rets[hiW]) hiW = w;
    if (loW == null || rets[w] < rets[loW]) loW = w;
  });
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">`
    + `<line x1="${padX}" y1="${y0.toFixed(1)}" x2="${W - padX}" y2="${y0.toFixed(1)}" stroke="${C.line}"/>`;
  wins.forEach((w, i) => {
    const cx = padX + slot * i + slot / 2;
    const r = rets[w], bv = bench[w];
    if (r != null) {
      const col = r > 0.02 ? C.up : r < -0.02 ? C.down : C.flat;
      const { x, w: bw } = barBox(cx, slot, 0.62);
      svg += `<path d="${barPath(x, bw, y(r), y0, 3)}" fill="${col}" class="mk"><title>${w}: ${fmtPct(r)}${bv != null ? ` · SPY ${fmtPct(bv)}` : ""}</title></path>`;
      if (w === hiW || w === loW) {
        const lblY = r >= 0 ? Math.min(y(r), y0) - 6 : Math.max(y(r), y0) + 13;
        svg += `<text x="${cx.toFixed(1)}" y="${lblY.toFixed(1)}" fill="${C.text}" font-size="10" font-weight="600" text-anchor="middle">${fmtPct(r, 0)}</text>`;
      }
    }
    if (bv != null)
      svg += `<line x1="${(cx - slot * 0.26).toFixed(1)}" y1="${y(bv).toFixed(1)}" x2="${(cx + slot * 0.26).toFixed(1)}" y2="${y(bv).toFixed(1)}" stroke="${C.muted}" stroke-width="2" stroke-linecap="round"><title>SPY ${w}: ${fmtPct(bv)}</title></line>`;
    svg += `<text x="${cx.toFixed(1)}" y="${H - 9}" fill="${C.muted}" font-size="11" text-anchor="middle">${w}</text>`;
  });
  svg += `</svg><div class="legend"><span><i style="background:${C.up}"></i>gain</span><span><i style="background:${C.down}"></i>loss</span><span><i class="line" style="background:${C.muted}"></i>SPY</span><span class="legend-note">hover a bar for its value</span></div>`;
  return svg;
}

function targetGauge(t) {
  if (t.low == null || t.high == null || t.current == null)
    return `<div class="na" style="margin-bottom:10px">Analyst targets unavailable.</div>`;
  const W = 380, H = 74, pad = 22, axis = 38;
  const lo = Math.min(t.low, t.current), hi = Math.max(t.high, t.current);
  const span = hi - lo || 1;
  const x = (v) => pad + ((v - lo) / span) * (W - 2 * pad);
  // Keep end labels inside the box: nudge anchor as a point nears an edge.
  const anchor = (v) => x(v) < pad + 24 ? "start" : x(v) > W - pad - 24 ? "end" : "middle";
  const ax = (v) => { const a = anchor(v); return a === "start" ? x(v) - MARK.dot : a === "end" ? x(v) + MARK.dot : x(v); };
  const tick = (v, label, up) => v == null ? "" :
    `<line x1="${x(v).toFixed(1)}" y1="${axis - 7}" x2="${x(v).toFixed(1)}" y2="${axis + 7}" stroke="${C.muted}" stroke-width="1.5"/>`
    + `<text x="${ax(v).toFixed(1)}" y="${up ? axis - 12 : axis + 18}" fill="${C.muted}" font-size="10" text-anchor="${anchor(v)}">${label} $${v.toFixed(0)}</text>`;
  const dot = (v, col, label, up) => v == null ? "" :
    `<circle cx="${x(v).toFixed(1)}" cy="${axis}" r="${MARK.dot}" fill="${col}" stroke="${C.panel}" stroke-width="${MARK.ring}"/>`
    + `<text x="${ax(v).toFixed(1)}" y="${up ? axis - 12 : axis + 18}" fill="${col}" font-size="10" font-weight="600" text-anchor="${anchor(v)}">${label} $${v.toFixed(0)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="gauge" role="img">
    <line x1="${x(t.low).toFixed(1)}" y1="${axis}" x2="${x(t.high).toFixed(1)}" y2="${axis}" stroke="${C.line}" stroke-width="5" stroke-linecap="round"/>
    <line x1="${x(Math.min(t.current, t.mean ?? t.current)).toFixed(1)}" y1="${axis}" x2="${x(Math.max(t.current, t.mean ?? t.current)).toFixed(1)}" y2="${axis}" stroke="${SERIES[0]}" stroke-width="5" stroke-linecap="round" opacity="0.5"/>
    ${tick(t.low, "low", true)}
    ${tick(t.high, "high", true)}
    ${dot(t.mean, SERIES[0], "mean", true)}
    ${dot(t.current, C.text, "now", false)}
  </svg>`;
}

function ratingBar(recs) {
  if (!recs || !recs.length) return `<div class="na">Rating breakdown unavailable.</div>`;
  const r = recs[0];
  // Buy → sell is a diverging scale: green poles, a neutral-grey "hold" midpoint.
  const seg = [
    ["Strong buy", r.strongBuy, C.up],
    ["Buy", r.buy, mix(C.up, C.muted, 0.45)],
    ["Hold", r.hold, C.muted],
    ["Sell", r.sell, mix(C.down, C.muted, 0.45)],
    ["Strong sell", r.strongSell, C.down],
  ].filter(([, v]) => v != null);
  const total = seg.reduce((s, [, v]) => s + (v || 0), 0);
  if (!total) return `<div class="na">Rating breakdown unavailable.</div>`;
  const W = 380, H = 24, gap = 2; let xacc = 0;
  let bars = "";
  seg.forEach(([n, v, col]) => {
    const w = (v / total) * W; if (w <= 0) return;
    bars += `<rect x="${xacc.toFixed(1)}" y="0" width="${Math.max(0, w - gap).toFixed(1)}" height="${H}" rx="2" fill="${col}"><title>${n}: ${v}</title></rect>`;
    if (w > 22) bars += `<text x="${(xacc + (w - gap) / 2).toFixed(1)}" y="16" fill="#fff" font-size="11" font-weight="700" text-anchor="middle">${v}</text>`;
    xacc += w;
  });
  const legend = seg.map(([n, v, col]) =>
    `<span><i style="background:${col}"></i>${n} (${v})</span>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="ratingbar" preserveAspectRatio="none" role="img">${bars}</svg>
    <div class="legend wrap">${legend}</div>`;
}

// Blend two hex colours (t = weight of b). Used for the rating scale's mid steps.
function mix(a, b, t) {
  const h = (c) => {
    c = String(c).trim();
    const rgb = c.match(/rgba?\(([^)]+)\)/);
    if (rgb) return rgb[1].split(",").slice(0, 3).map((x) => parseInt(x, 10));
    if (c[0] === "#" && c.length === 4) c = "#" + [...c.slice(1)].map((x) => x + x).join("");
    return c[0] === "#" ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : null;
  };
  const A = h(a), B = h(b);
  if (!A || !B) return a;
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
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
    <div class="card"><h3>Revenue &amp; YoY growth</h3>${barChart(yr, fu.revenue, {
      fmt: money, color: SERIES[0], deltas: fu.revenue_yoy })}</div>
    <div class="card"><h3>Margins</h3>${multiLine(yr, [
      { name: "Gross", values: fu.gross_margin, color: SERIES[0] },
      { name: "Operating", values: fu.operating_margin, color: SERIES[1] },
      { name: "Net", values: fu.net_margin, color: SERIES[2] },
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
      { name: "Revenue", values: q.revenue, color: SERIES[0] },
      { name: "Net income", values: q.net_income, color: SERIES[2] },
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
  // Headroom past the data on whichever side leaves zero, so the value labels
  // that sit just outside each bar don't collide with the axis labels.
  const p = (hi - lo) * 0.08;
  return { lo: lo < 0 ? lo - p : lo, hi: hi > 0 ? hi + p : hi };
}

// Single-series bars. `opts.deltas` (array parallel to values, fractions) prints a
// small red/green change figure above each bar — used for the revenue chart's YoY
// growth, which is a per-bar annotation, not a second axis.
function barChart(labels, values, opts = {}) {
  const b = _bounds(values || []);
  if (!b) return `<div class="na">No data.</div>`;
  const fmt = opts.fmt || ((v) => v);
  const dels = opts.deltas || [];
  const W = 440, H = 232, padT = dels.length ? 34 : 24, padB = 28, padX = 12;
  const n = labels.length, slot = (W - 2 * padX) / n;
  const y = (v) => padT + (1 - (v - b.lo) / (b.hi - b.lo)) * (H - padT - padB);
  const y0 = y(0);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">
    <line x1="${padX}" y1="${y0.toFixed(1)}" x2="${W - padX}" y2="${y0.toFixed(1)}" stroke="${C.line}"/>`;
  labels.forEach((lab, i) => {
    const v = values[i], cx = padX + slot * i + slot / 2;
    if (v != null) {
      const col = opts.color || (opts.colorFn ? opts.colorFn(v) : C.accent);
      const { x, w } = barBox(cx, slot, 0.7);
      const yv = y(v), lblY = v >= 0 ? Math.min(yv, y0) - 6 : Math.max(yv, y0) + 13;
      svg += `<path d="${barPath(x, w, yv, y0, MARK.radius)}" fill="${col}" class="mk"><title>${lab}: ${fmt(v)}</title></path>`;
      svg += `<text x="${cx.toFixed(1)}" y="${lblY.toFixed(1)}" fill="${C.text}" font-size="10" text-anchor="middle">${fmt(v)}</text>`;
      const d = dels[i];
      if (d != null) svg += `<text x="${cx.toFixed(1)}" y="${(lblY - 11).toFixed(1)}" fill="${d >= 0 ? C.up : C.down}" font-size="9.5" font-weight="600" text-anchor="middle">${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(0)}%</text>`;
    }
    svg += `<text x="${cx.toFixed(1)}" y="${H - 9}" fill="${C.muted}" font-size="11" text-anchor="middle">${lab}</text>`;
  });
  if (dels.length)
    svg += `</svg><div class="legend"><span><i style="background:${opts.color || C.accent}"></i>Revenue</span><span class="legend-note">YoY growth <b style="color:${C.up}">▲</b> / <b style="color:${C.down}">▼</b> above each bar</span></div>`;
  else svg += `</svg>`;
  return svg;
}

function groupedBars(labels, series, fmt) {
  const all = series.flatMap((s) => s.values || []);
  const b = _bounds(all);
  if (!b) return `<div class="na">No data.</div>`;
  const W = 440, H = 232, padT = 22, padB = 28, padX = 12;
  const n = labels.length, k = series.length, slot = (W - 2 * padX) / n;
  const bw = Math.min((slot * 0.78) / k, 18);
  const y = (v) => padT + (1 - (v - b.lo) / (b.hi - b.lo)) * (H - padT - padB);
  const y0 = y(0);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">
    <line x1="${padX}" y1="${y0.toFixed(1)}" x2="${W - padX}" y2="${y0.toFixed(1)}" stroke="${C.line}"/>`;
  labels.forEach((lab, i) => {
    const gcx = padX + slot * i + slot / 2, x0 = gcx - (bw * k) / 2;
    series.forEach((s, j) => {
      const v = (s.values || [])[i];
      if (v == null) return;
      const x = x0 + bw * j + MARK.barGap / 2, w = bw - MARK.barGap;
      svg += `<path d="${barPath(x, w, y(v), y0, 3)}" fill="${s.color}" class="mk"><title>${s.name} · ${lab}: ${fmt ? fmt(v) : v}</title></path>`;
    });
    svg += `<text x="${gcx.toFixed(1)}" y="${H - 9}" fill="${C.muted}" font-size="11" text-anchor="middle">${lab}</text>`;
  });
  svg += `</svg><div class="legend">` +
    series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("") + `</div>`;
  return svg;
}

// A short line-key swatch reads truer for a line chart than a filled square.
function lineLegend(series) {
  return `<div class="legend">` + series.map((s) =>
    `<span><i class="line" style="background:${s.color}"></i>${s.name}</span>`).join("") + `</div>`;
}

// Shared multi-series line renderer. fmt formats the y ticks + tooltip values;
// `raw` keeps values as-is (P/E), otherwise they're percentages.
function _lines(labels, series, { fmt, raw, area } = {}) {
  const all = series.flatMap((s) => s.values || []).filter((v) => v != null);
  if (!all.length) return `<div class="na">No data.</div>`;
  let lo = Math.min(...all), hi = Math.max(...all);
  const p = (hi - lo) * 0.14 || (raw ? 1 : 0.02);
  lo = raw ? Math.max(0, lo - p) : lo - p;
  hi += p;
  const f = fmt || ((v) => `${(v * 100).toFixed(0)}%`);
  const W = 440, H = 232, padT = 18, padB = 28, padL = 40, padR = 12;
  const n = labels.length;
  const x = (i) => padL + (n === 1 ? 0.5 : i / (n - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">`;
  [hi, (hi + lo) / 2, lo].forEach((gv) => {
    svg += `<line x1="${padL}" y1="${y(gv).toFixed(1)}" x2="${W - padR}" y2="${y(gv).toFixed(1)}" stroke="${C.line}"/>`
      + `<text x="${(padL - 6).toFixed(1)}" y="${(y(gv) + 3.5).toFixed(1)}" fill="${C.muted}" font-size="10" text-anchor="end">${f(gv)}</text>`;
  });
  labels.forEach((lab, i) =>
    svg += `<text x="${x(i).toFixed(1)}" y="${H - 9}" fill="${C.muted}" font-size="11" text-anchor="middle">${lab}</text>`);
  if (area && series.length === 1) {
    const s = series[0];
    const pts = (s.values || []).map((v, i) => v == null ? null : [x(i), y(v)]).filter(Boolean);
    if (pts.length > 1) {
      const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
      svg += `<path d="${d} L${pts[pts.length - 1][0].toFixed(1)},${y(lo).toFixed(1)} L${pts[0][0].toFixed(1)},${y(lo).toFixed(1)} Z" fill="${s.color}" opacity="0.1"/>`;
    }
  }
  series.forEach((s) => {
    const pts = (s.values || []).map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
    if (pts.length) svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="${MARK.line}" stroke-linejoin="round" stroke-linecap="round"/>`;
    // Surface-coloured ring keeps two markers legible where the lines cross.
    (s.values || []).forEach((v, i) => {
      if (v == null) return;
      svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${MARK.dot}" fill="${s.color}" stroke="${C.panel}" stroke-width="${MARK.ring}" class="mk"><title>${s.name} · ${labels[i]}: ${f(v)}</title></circle>`;
    });
  });
  svg += `</svg>` + (series.length > 1 ? lineLegend(series) : "");
  return svg;
}

function multiLine(labels, series) {
  return _lines(labels, series, {});
}

function peHistoryChart(pe) {
  if (!pe || !pe.pe || !pe.pe.some((v) => v != null))
    return `<div class="na">P/E history unavailable.</div>`;
  return multiLineRaw(pe.years, [{ name: "P/E", values: pe.pe, color: SERIES[0] }],
    (v) => v.toFixed(0) + "x");
}

// Line chart for non-percent values (e.g. P/E multiple) — single-series gets a
// soft area fill under the line.
function multiLineRaw(labels, series, fmt) {
  return _lines(labels, series, { fmt, raw: true, area: true });
}

// Peer comparison vs sector median (data injected by the SPA as p._peers).
function peerSection(peers, stockReturns, ticker) {
  if (!peers) return "";
  const wins = ["1M", "3M", "6M", "1Y"].filter((w) => stockReturns[w] != null);
  const rankTxt = peers.rank
    ? `Ranks <b>#${peers.rank}</b> of ${peers.count} in ${esc(peers.sector)} by 12-month return.`
    : "";
  // Name the stock's own series (its ticker) and give it the fixed SERIES blue —
  // distinct from the sector-median orange and the grey SPY on every theme, where
  // the page accent (a warm gold on Amber/Carbon) would sit too close to orange.
  const chart = groupedBars(wins, [
    { name: esc(ticker || "This stock"), values: wins.map((w) => stockReturns[w]), color: SERIES[0] },
    { name: `${esc(peers.sector)} median`, values: wins.map((w) => peers.median[w]), color: SERIES[1] },
    { name: "SPY", values: wins.map((w) => (peers.spy || {})[w]), color: C.muted },
  ], (v) => (v * 100).toFixed(0) + "%");
  return `<div class="card"><h3>Peers — vs ${esc(peers.sector)} sector</h3>
    <div class="sub2" style="margin:0 0 10px">${rankTxt}</div>${chart}</div>`;
}

// Only auto-boot on the standalone pitchbook page; the SPA calls
// buildProfileHTML() directly and reuses the chart helpers above.
if (document.body.classList.contains("pb")) boot();
