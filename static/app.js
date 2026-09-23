// Signal Sift SPA. Fetches the full universe ONCE, caches it in localStorage,
// and does all filtering / sorting / sector math client-side so clicking a stock
// never drops your place or re-pulls data. Shares chart helpers (buildProfileHTML,
// esc, cls, num, money…) with company.js, which loads first.
const $ = (id) => document.getElementById(id);
let WINDOWS = ["1D", "1W", "1M", "3M", "6M", "9M", "1Y", "2Y", "3Y", "4Y", "5Y"];

// Bump when the cached payload shape changes; stale local caches self-purge.
// Keep in step with the server schema stamps in company.py / fundamentals.py.
const APP_SCHEMA = "7";
function purgeStaleCaches() {
  if (localStorage.getItem("ss-schema") === APP_SCHEMA) return;
  // Drop data caches + the retired filter-bar keys; keep theme + the new ss-table.
  ["ss-base", "ss-filters", "ss-wlover"].concat(
    Object.keys(localStorage).filter((k) => k.startsWith("ss-co-"))
  ).forEach((k) => localStorage.removeItem(k));
  localStorage.setItem("ss-schema", APP_SCHEMA);
}

function pct(v, d = 1) {
  if (v == null) return '<span class="na">—</span>';
  const c = v > 0.02 ? "ret-up" : v < -0.02 ? "ret-down" : "ret-flat";
  return `<span class="${c}">${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%</span>`;
}
function fmtAge(sec) {
  if (sec == null) return "";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m old` : `${m}m old`;
}
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------- State + persistence ----------------
const State = {
  base: null,                 // { rows, meta, ts }
  secOver: "1Y",
  wtOver: "1Y",               // Weights view: return window for basket-vs-SPY
  wtScheme: "cap",            // Weights view: 'cap' | 'equal'
  wtSecView: "bars",          // Weights view: sector card 'bars' | 'lines'
  wtCmpView: "chart",         // Weights view: basket card 'chart' | 'table'
  wtCompare: [null, null, null], // Weights view: ready-made baskets overlaid, by colour slot
  active: "stocks",
  cursor: -1,                 // keyboard row cursor in stocks/watchlist tables
  detailTicker: null,
  detailCache: {},            // ticker -> profile (also mirrored to localStorage)
  watchlist: new Set(),       // starred tickers
  basket: new Set(),          // Weights view: tickers in the "replicate SPY" basket
};

function loadWatchlist() {
  try { State.watchlist = new Set(JSON.parse(localStorage.getItem("ss-watchlist")) || []); }
  catch (e) { State.watchlist = new Set(); }
}
function saveWatchlist() {
  localStorage.setItem("ss-watchlist", JSON.stringify([...State.watchlist]));
}
const isWatched = (t) => State.watchlist.has(t);

function loadBasket() {
  try { State.basket = new Set(JSON.parse(localStorage.getItem("ss-basket")) || []); }
  catch (e) { State.basket = new Set(); }
}
function saveBasket() {
  localStorage.setItem("ss-basket", JSON.stringify([...State.basket]));
}

function saveBase() {
  try { localStorage.setItem("ss-base", JSON.stringify(State.base)); } catch (e) {}
}
function loadBase() {
  try { return JSON.parse(localStorage.getItem("ss-base")); } catch (e) { return null; }
}
function saveFilters() {
  localStorage.setItem("ss-secover", State.secOver);
  localStorage.setItem("ss-wtover", State.wtOver);
  localStorage.setItem("ss-wtscheme", State.wtScheme);
  localStorage.setItem("ss-wtsecview", State.wtSecView);
  localStorage.setItem("ss-wtcmpview", State.wtCmpView);
  localStorage.setItem("ss-wtcompare", JSON.stringify(State.wtCompare));
}
function loadFilters() {
  State.secOver = localStorage.getItem("ss-secover") || "1Y";
  State.wtOver = localStorage.getItem("ss-wtover") || "1Y";
  State.wtScheme = localStorage.getItem("ss-wtscheme") || "cap";
  State.wtSecView = localStorage.getItem("ss-wtsecview") === "lines" ? "lines" : "bars";
  State.wtCmpView = localStorage.getItem("ss-wtcmpview") === "table" ? "table" : "chart";
  try {
    const c = JSON.parse(localStorage.getItem("ss-wtcompare"));
    State.wtCompare = [0, 1, 2].map((i) => (Array.isArray(c) && wtBasketById(c[i]) ? c[i] : null));
  } catch (e) { State.wtCompare = [null, null, null]; }
}

// Per-column sort + filter for the two spreadsheet-style tables. This is the
// state a future "saved screens" feature would name and persist.
const DEFAULT_SORT = { key: "1Y", dir: "desc" };
const STX = { key: "stx", headEl: "headRow", bodyEl: "rows", statusEl: "status-line",
              noun: "names", sort: { ...DEFAULT_SORT }, filters: {},
              scope: () => (State.base ? State.base.rows : []) };
const WL  = { key: "wl", headEl: "wlHead", bodyEl: "wlRows", statusEl: "wl-status",
              noun: "watched", sort: { ...DEFAULT_SORT }, filters: {},
              scope: () => (State.base ? State.base.rows.filter((r) => State.watchlist.has(r.ticker)) : []) };

function saveTable() {
  localStorage.setItem("ss-table", JSON.stringify({
    stx: { sort: STX.sort, filters: STX.filters },
    wl:  { sort: WL.sort,  filters: WL.filters },
  }));
}
function loadTable() {
  try {
    const t = JSON.parse(localStorage.getItem("ss-table")) || {};
    if (t.stx) { STX.sort = t.stx.sort || STX.sort; STX.filters = t.stx.filters || {}; }
    if (t.wl)  { WL.sort  = t.wl.sort  || WL.sort;  WL.filters  = t.wl.filters  || {}; }
  } catch (e) {}
}
function clearDetailCache() {
  State.detailCache = {};
  Object.keys(localStorage).filter((k) => k.startsWith("ss-co-"))
    .forEach((k) => localStorage.removeItem(k));
}

// ---------------- Data ----------------
async function fetchBase(force = false) {
  const url = "/api/screen?status=all&over=1Y&direction=desc&ceiling=0.05" +
              (force ? "&refresh=1" : "");
  const res = await fetch(url);
  const data = await res.json();
  State.base = {
    rows: data.rows,
    meta: {
      generated_at: data.generated_at,
      windows: data.windows,
      benchmark: data.benchmark,
      benchmark_returns: data.benchmark_returns,
      universe_size: data.universe_size,
      evaluated: data.evaluated,
      sectors: data.sectors,
      live_screen: data.live_screen,
      can_trigger_refresh: data.can_trigger_refresh,
    },
    ts: Date.now(),
  };
  WINDOWS = data.windows || WINDOWS;
  saveBase();
  return data.generated_at;
}

// ---------------- Client-side classification (Sectors tab up/down split) ----------------
// The screener no longer exposes a "counts as up" control — filtering is now
// per-column. The Sectors tab still shows a growing/stalled mix, judged against
// this fixed line.
const GROWTH_LINE = 0.05;

// true = up, false = down, null = unjudgeable (no price history that far back).
// null must fall into NEITHER bucket — always compare === true / === false.
function judge(row, w) {
  const v = row.returns[w];
  return v == null ? null : v > GROWTH_LINE;
}

// ---------------- Spreadsheet-style table (stocks + watchlist) ----------------
// Columns are data-driven. `kind` drives the header popover: text = contains,
// enum = checklist, money/pct = min/max range (pct entered as a percentage).
function tableCols() {
  return [
    { key: "ticker", label: "Ticker",  kind: "text",  get: (r) => r.ticker,
      cell: (r) => `<td class="tk">${r.ticker}</td>` },
    { key: "name",   label: "Company", kind: "text",  get: (r) => r.name || "",
      cell: (r) => `<td>${esc(r.name || "")}</td>` },
    { key: "sector", label: "Sector",  kind: "enum",  get: (r) => r.sector || "",
      cell: (r) => `<td>${esc(r.sector || "")}</td>` },
    { key: "price",  label: "Price",   kind: "money", num: true, get: (r) => r.price,
      cell: (r) => `<td class="num">$${Number(r.price).toFixed(2)}</td>` },
    ...WINDOWS.map((w) => ({
      key: w, label: w, kind: "pct", num: true, get: (r) => r.returns[w],
      cell: (r) => `<td class="num">${pct(r.returns[w])}</td>`,
    })),
  ];
}

// Is a stored filter value actually constraining anything?
function activeFilter(f) {
  if (f == null) return false;
  if (Array.isArray(f)) return f.length > 0;
  if (typeof f === "object") return f.min != null || f.max != null;
  return f !== "";
}

function rowPasses(r, filters, cols) {
  for (const c of cols) {
    const f = filters[c.key];
    if (!activeFilter(f)) continue;
    const v = c.get(r);
    if (c.kind === "text") {
      if (!String(v).toLowerCase().includes(String(f).toLowerCase())) return false;
    } else if (c.kind === "enum") {
      if (!f.includes(v)) return false;
    } else {
      if (f.min != null && (v == null || v < f.min)) return false;
      if (f.max != null && (v == null || v > f.max)) return false;
    }
  }
  return true;
}

function sortRows(rows, sort, cols) {
  const c = cols.find((x) => x.key === sort.key) ||
            cols.find((x) => x.key === "1Y") || cols[0];
  const dir = sort.dir === "asc" ? 1 : -1;
  const text = c.kind === "text" || c.kind === "enum";
  return rows.sort((a, b) => {
    let av = c.get(a), bv = c.get(b);
    if (text) return dir * String(av).toLowerCase().localeCompare(String(bv).toLowerCase());
    av = av == null ? -Infinity : av;
    bv = bv == null ? -Infinity : bv;
    return dir * (av - bv);
  });
}

function paintHead(ctx, cols) {
  const th = cols.map((c) => {
    const s = ctx.sort.key === c.key ? (ctx.sort.dir === "asc" ? " up" : " down") : "";
    const fl = activeFilter(ctx.filters[c.key]) ? " filtered" : "";
    return `<th class="${c.num ? "num " : ""}colh">` +
      `<button class="colhead${s}${fl}" data-col="${c.key}">` +
      `<span class="ch-label">${c.label}</span><span class="ch-ind" aria-hidden="true"></span>` +
      `</button></th>`;
  }).join("");
  $(ctx.headEl).innerHTML = `<th class="star-h"></th>` + th;
  $(ctx.headEl).querySelectorAll(".colhead").forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); openColPop(ctx, btn.dataset.col, btn); };
  });
}

function tableRow(r, cols) {
  const tr = document.createElement("tr");
  tr.dataset.tk = r.ticker;
  const on = isWatched(r.ticker);
  tr.innerHTML =
    `<td class="starcell"><span class="star ${on ? "on" : "off"}" title="Watchlist">${on ? "★" : "☆"}</span></td>` +
    cols.map((c) => c.cell(r)).join("");
  tr.onclick = () => openDetail(r.ticker);
  tr.querySelector(".star").onclick = (e) => { e.stopPropagation(); toggleWatch(r.ticker); };
  return tr;
}

function paintBody(ctx, cols) {
  const all = ctx.scope();
  let rows = all.filter((r) => rowPasses(r, ctx.filters, cols));
  rows = sortRows(rows, ctx.sort, cols);

  const tb = $(ctx.bodyEl);
  tb.innerHTML = "";
  State.cursor = -1;
  const frag = document.createDocumentFragment();
  rows.forEach((r) => frag.appendChild(tableRow(r, cols)));
  tb.appendChild(frag);

  const has = cols.some((c) => activeFilter(ctx.filters[c.key]));
  $(ctx.statusEl).innerHTML =
    `Showing <b>${rows.length}</b> of ${all.length} ${ctx.noun}` +
    (has ? ` · <span class="linkbtn" data-clearall>Clear all filters</span>` : "");
  const cl = $(ctx.statusEl).querySelector("[data-clearall]");
  if (cl) cl.onclick = () => { ctx.filters = {}; saveTable(); closeColPop(); paint(ctx); };
}

function paint(ctx) {
  const cols = tableCols();
  paintHead(ctx, cols);
  paintBody(ctx, cols);
}

// ---------------- Column sort/filter popover ----------------
let popCtx = null, popColKey = null;

function openColPop(ctx, colKey, btnEl) {
  const cols = tableCols();
  const c = cols.find((x) => x.key === colKey);
  if (!c) return;
  const pop = $("colpop");
  if (popCtx === ctx && popColKey === colKey && !pop.classList.contains("hidden")) {
    closeColPop();
    return;
  }
  popCtx = ctx; popColKey = colKey;
  pop.innerHTML = colPopHTML(ctx, c);
  pop.classList.remove("hidden");
  const r = btnEl.getBoundingClientRect();
  const w = pop.offsetWidth || 220;
  pop.style.top = Math.round(r.bottom + 4) + "px";
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)) + "px";
  wireColPop(ctx, c);
}

function closeColPop() {
  $("colpop").classList.add("hidden");
  popCtx = null; popColKey = null;
}

function colPopHTML(ctx, c) {
  const txt = c.kind === "text" || c.kind === "enum";
  const asc = txt ? "A → Z" : "Low → High";
  const desc = txt ? "Z → A" : "High → Low";
  const sk = ctx.sort.key === c.key;
  const f = ctx.filters[c.key];
  let body = "";
  if (c.kind === "text") {
    body = `<label class="cp-l">Contains` +
      `<input class="cp-in" id="cpText" type="text" value="${f ? esc(String(f)) : ""}" placeholder="ticker or name…"></label>`;
  } else if (c.kind === "enum") {
    const opts = (State.base && State.base.meta.sectors) ||
      [...new Set(ctx.scope().map((r) => r.sector).filter(Boolean))].sort();
    const set = new Set(Array.isArray(f) ? f : []);
    const none = set.size === 0;
    body = `<div class="cp-list">` + opts.map((s) =>
      `<label class="cp-chk"><input type="checkbox" value="${esc(s)}" ${none || set.has(s) ? "checked" : ""}> ${esc(s)}</label>`
    ).join("") + `</div>`;
  } else {
    const unit = c.kind === "money" ? "$" : "%";
    const scale = c.kind === "money" ? 1 : 100;
    const mn = f && f.min != null ? +(f.min * scale).toFixed(4) : "";
    const mx = f && f.max != null ? +(f.max * scale).toFixed(4) : "";
    body = `<div class="cp-range">` +
      `<label class="cp-l">Min ${unit}<input class="cp-in" id="cpMin" type="number" step="any" value="${mn}"></label>` +
      `<label class="cp-l">Max ${unit}<input class="cp-in" id="cpMax" type="number" step="any" value="${mx}"></label></div>`;
  }
  return `<div class="cp-sort">` +
    `<button class="cp-s${sk && ctx.sort.dir === "asc" ? " on" : ""}" data-dir="asc">↑ ${asc}</button>` +
    `<button class="cp-s${sk && ctx.sort.dir === "desc" ? " on" : ""}" data-dir="desc">↓ ${desc}</button>` +
    `</div><div class="cp-div"></div>${body}` +
    `<div class="cp-foot"><button class="cp-clear">Clear</button><button class="cp-done">Done</button></div>`;
}

function wireColPop(ctx, c) {
  const pop = $("colpop");
  let t = null;
  const cancel = () => { if (t) { clearTimeout(t); t = null; } };

  const val = (sel) => { const el = pop.querySelector(sel); return el ? el.value : ""; };

  // Current popover inputs -> a filter value, or undefined for "no filter".
  function readFilter() {
    if (c.kind === "text") {
      return val("#cpText").trim() || undefined;
    }
    if (c.kind === "enum") {
      const boxes = [...pop.querySelectorAll(".cp-chk input")];
      const on = boxes.filter((b) => b.checked).map((b) => b.value);
      return on.length === 0 || on.length === boxes.length ? undefined : on;
    }
    const scale = c.kind === "money" ? 1 : 0.01;
    const mn = parseFloat(val("#cpMin")), mx = parseFloat(val("#cpMax"));
    const o = {};
    if (!isNaN(mn)) o.min = mn * scale;
    if (!isNaN(mx)) o.max = mx * scale;
    return o.min != null || o.max != null ? o : undefined;
  }

  // Commit whatever is in the inputs right now. `close` also dismisses the popover.
  function commit(close) {
    cancel();
    const v = readFilter();
    if (v === undefined) delete ctx.filters[c.key];
    else ctx.filters[c.key] = v;
    saveTable();
    paint(ctx);
    if (close) closeColPop();
  }

  // Wire the escape hatches (Clear / Done / sort) FIRST and each in its own try,
  // so a problem building one control can never leave the others dead.
  const wire = (sel, fn) => { try { const el = pop.querySelector(sel); if (el) el.onclick = fn; } catch (e) {} };

  wire(".cp-clear", () => {
    cancel();
    // Blank the visible inputs so a pending edit can't reinstate the filter.
    pop.querySelectorAll("#cpText, #cpMin, #cpMax").forEach((el) => (el.value = ""));
    pop.querySelectorAll(".cp-chk input").forEach((x) => (x.checked = true));
    delete ctx.filters[c.key];
    // Clear undoes everything this popover did to the column — including a sort
    // it owns. Revert to the table default so the ▲/▼ indicator goes away.
    if (ctx.sort.key === c.key) ctx.sort = { ...DEFAULT_SORT };
    saveTable(); paint(ctx); closeColPop();
  });
  wire(".cp-done", () => commit(true));

  try {
    pop.querySelectorAll(".cp-s").forEach((b) => {
      b.onclick = () => {
        cancel();
        ctx.sort = { key: c.key, dir: b.dataset.dir };
        saveTable(); paint(ctx); closeColPop();
      };
    });
  } catch (e) {}

  try {
    const live = () => { cancel(); t = setTimeout(() => commit(false), 200); };
    const onEnter = (e) => { if (e.key === "Enter") commit(true); };
    if (c.kind === "text") {
      const inp = pop.querySelector("#cpText");
      if (inp) { inp.oninput = live; inp.onkeydown = onEnter; }
    } else if (c.kind === "enum") {
      pop.querySelectorAll(".cp-chk input").forEach((b) => (b.onchange = () => commit(false)));
    } else {
      pop.querySelectorAll("#cpMin, #cpMax").forEach((el) => { el.oninput = live; el.onkeydown = onEnter; });
    }
  } catch (e) {}
}

// ---------------- Stocks view ----------------
function renderStocks() {
  if (!State.base) return;
  paint(STX);
}

// ---------------- Watchlist view ----------------
function toggleWatch(ticker) {
  if (State.watchlist.has(ticker)) State.watchlist.delete(ticker);
  else State.watchlist.add(ticker);
  saveWatchlist();
  updateStars(ticker);
  updateWatchCount();
  if (State.active === "watchlist") renderWatchlist();
}

function updateStars(ticker) {
  const on = isWatched(ticker);
  document.querySelectorAll(`tr[data-tk="${ticker}"] .star`).forEach((el) => {
    el.textContent = on ? "★" : "☆";
    el.classList.toggle("on", on);
    el.classList.toggle("off", !on);
  });
  const db = $("detailStar");
  if (db && State.detailTicker === ticker) {
    db.textContent = on ? "★ Watching" : "☆ Add to watchlist";
    db.classList.toggle("on", on);
  }
}

function updateWatchCount() {
  $("wlCount").textContent = State.watchlist.size;
}

function renderWatchlist() {
  const empty = State.watchlist.size === 0;
  $("wlEmpty").classList.toggle("hidden", !empty);
  $("wlGrid").classList.toggle("hidden", empty);
  if (empty || !State.base) {
    $("wl-status").textContent = "";
    $("wlRows").innerHTML = "";
    $("wlHead").innerHTML = "";
    return;
  }
  paint(WL);
}

// ---------------- Sectors view ----------------
function computeSectors(over) {
  const groups = {};
  State.base.rows.forEach((r) => {
    (groups[r.sector || "Unknown"] ||= []).push(r);
  });
  const bench = State.base.meta.benchmark_returns || {};
  const out = Object.entries(groups).map(([sector, rows]) => {
    const medByWin = {};
    WINDOWS.forEach((w) => {
      medByWin[w] = median(rows.map((r) => r.returns[w]).filter((v) => v != null));
    });
    const refs = rows.map((r) => r.returns[over]).filter((v) => v != null);
    // Count over judgeable names only, so the up/down mix always sums to n.
    const judged = rows.map((r) => judge(r, over)).filter((v) => v != null);
    const growing = judged.filter(Boolean).length;
    const ranked = [...rows].sort((a, b) => (a.returns[over] ?? -Infinity) - (b.returns[over] ?? -Infinity));
    return {
      sector, count: rows.length, medByWin,
      medOver: median(refs), growing, stalled: judged.length - growing,
      pctGrowing: judged.length ? growing / judged.length : null,
      best: ranked.length ? ranked[ranked.length - 1] : null,
      worst: ranked.length ? ranked[0] : null,
    };
  });
  out.sort((a, b) => (b.medOver ?? -Infinity) - (a.medOver ?? -Infinity));
  return { sectors: out, benchOver: bench[over] };
}

function heatColor(v) {
  if (v == null) return "transparent";
  const t = Math.max(-1, Math.min(1, v / 0.4)); // saturate at ±40%
  return t >= 0 ? `rgba(63,185,80,${0.12 + t * 0.55})`
                : `rgba(248,81,73,${0.12 + (-t) * 0.55})`;
}

function renderSectors() {
  if (!State.base) return;
  const over = State.secOver;
  const { sectors, benchOver } = computeSectors(over);

  const vals = sectors.map((s) => s.medOver).filter((v) => v != null);
  const max = Math.max(0.02, ...vals.map(Math.abs));

  const chart = sectors.map((s) => {
    const v = s.medOver;
    const w = v == null ? 0 : (Math.abs(v) / max) * 50;
    const col = v == null ? "var(--muted)" : v > 0.02 ? "var(--up)" : v < -0.02 ? "var(--down)" : "var(--flat)";
    const side = v >= 0 ? "left:50%" : "right:50%";
    const pg = s.pctGrowing != null ? Math.round(s.pctGrowing * 100) : "—";
    return `<div class="secrow" data-sector="${esc(s.sector)}">
      <div class="secname">${esc(s.sector)} <span class="na">(${s.count})</span></div>
      <div class="secbar"><span class="seczero"></span>
        <span class="secfill" style="${side};width:${w}%;background:${col}"></span></div>
      <div class="secval ${v == null ? "na" : v >= 0 ? "ret-up" : "ret-down"}">${pct(v)}</div>
      <div class="secmix"><span class="ret-up">${s.growing}▲</span>/<span class="ret-down">${s.stalled}▼</span> <span class="na">${pg}%↑</span></div>
    </div>`;
  }).join("");
  $("sectorChart").innerHTML =
    `<div class="sechead"><span>Sector (n)</span>` +
    `<span class="secmid">◀ down · median ${over} · up ▶${benchOver != null ? " · SPY " : ""}${benchOver != null ? pct(benchOver) : ""}</span>` +
    `<span>median</span><span>mix</span></div>` + chart;

  // Heatmap table: sectors × windows.
  const head = `<tr><th>Sector</th>${WINDOWS.map((w) => `<th class="num">${w}</th>`).join("")}<th class="num">Best</th><th class="num">Worst</th></tr>`;
  const body = sectors.map((s) => {
    const cells = WINDOWS.map((w) => {
      const v = s.medByWin[w];
      return `<td class="num heat" style="background:${heatColor(v)}">${v == null ? "—" : (v * 100).toFixed(0) + "%"}</td>`;
    }).join("");
    const b = s.best, wst = s.worst;
    return `<tr class="secrow2" data-sector="${esc(s.sector)}">
      <td class="secname">${esc(s.sector)}</td>${cells}
      <td class="num"><span class="tk">${b ? b.ticker : "—"}</span> ${b ? pct(b.returns[over]) : ""}</td>
      <td class="num"><span class="tk">${wst ? wst.ticker : "—"}</span> ${wst ? pct(wst.returns[over]) : ""}</td></tr>`;
  }).join("");
  $("sectorHeat").innerHTML = `<table class="heattable"><thead>${head}</thead><tbody>${body}</tbody></table>`;

  // Wire clicks -> open the stocks tab filtered to that one sector.
  const go = (secName) => {
    STX.filters = { sector: [secName] };
    saveTable();
    closeColPop();
    switchTab("stocks");
    renderStocks();
  };
  document.querySelectorAll(".secrow").forEach((el) =>
    el.onclick = () => go(el.dataset.sector));
  document.querySelectorAll(".secrow2").forEach((el) =>
    el.onclick = () => go(el.dataset.sector));
}

// ---------------- Weights view (index-weight visualizer) ----------------
// Approximate SPY weights from each name's market_cap (implied shares × price,
// supplied by the backend). All `wt*`/`basket*` names to avoid the company.js
// shared-scope collision.
//
// Weights *over time* are rebuilt from the trailing returns already in the
// screen: a name's value at the start of window w is market_cap / (1 + r_w).
// That holds share counts constant (buybacks / issuance ignored), uses today's
// constituents (no index changes), and the prices are dividend-adjusted — an
// approximation, but one that needs no extra data. A name with no lookback price
// for w (a recent listing) simply isn't in the index at that point.
function wpct(frac, d = 2) { return frac == null ? "—" : (frac * 100).toFixed(d) + "%"; }
function wpts(diff) {
  if (diff == null) return '<span class="na">—</span>';
  const v = diff * 100, c = Math.abs(v) < 0.005 ? "ret-flat" : v > 0 ? "ret-up" : "ret-down";
  return `<span class="${c}">${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)} pts</span>`;
}
const wtAgo = (w) => (w === "now" ? "Now" : `${w} ago`);

function weightUniverse() {
  const rows = (State.base && State.base.rows) || [];
  const capped = rows.filter((r) => r.market_cap != null && r.market_cap > 0);
  const total = capped.reduce((a, r) => a + r.market_cap, 0);
  return { rows, capped, total };
}

// A name's price relative to today at point w ("now" = 1), or null.
function wtRel(r, w) {
  if (w === "now") return 1;
  const x = r.returns[w];
  return x == null ? null : 1 / (1 + x);
}
function capAt(r, w) {
  const rel = wtRel(r, w);
  return rel == null || !(r.market_cap > 0) ? null : r.market_cap * rel;
}

// Points on the time axis for a window: every lookback at or inside it, oldest
// first, then "now".
function wtTimeline(over) {
  const d = winDays(over);
  return WINDOWS.filter((w) => winDays(w) <= d)
    .sort((a, b) => winDays(b) - winDays(a)).concat("now");
}

// Index total and per-sector share at point w, over names with a value then.
function wtIndexAt(w) {
  const { capped } = weightUniverse();
  const sec = {}, vals = [];
  let total = 0;
  capped.forEach((r) => {
    const v = capAt(r, w);
    if (v == null) return;
    const s = r.sector || "Unknown";
    sec[s] = (sec[s] || 0) + v;
    total += v;
    vals.push(v);
  });
  Object.keys(sec).forEach((s) => (sec[s] = total ? sec[s] / total : 0));
  vals.sort((a, b) => b - a);
  const top = (n) => (total ? vals.slice(0, n).reduce((a, v) => a + v, 0) / total : null);
  return { total, sec, top };
}

// Buy-and-hold basket bought at the start of `over`: level at each timeline
// point, indexed to 100 at the start. Cap-weighted holds each name in
// proportion to its market value then (what SPY does); equal-weighted puts the
// same dollars in each name. Names without a lookback price for `over` are left
// out. `tickers` is any Set (default: your basket). Returns
// { members, points, levels } or null when nothing qualifies.
function basketPath(over, scheme, tickers = State.basket) {
  const points = wtTimeline(over);
  const members = State.base.rows.filter((r) =>
    tickers.has(r.ticker) && points.every((p) => wtRel(r, p) != null) &&
    (scheme !== "cap" || r.market_cap > 0));
  if (!members.length) return null;
  const units = members.map((r) => (scheme === "cap" ? r.market_cap : 1 / wtRel(r, over)));
  const valueAt = (p) => members.reduce((a, r, i) => a + units[i] * wtRel(r, p), 0);
  const start = valueAt(over);
  return { members, points, levels: points.map((p) => (100 * valueAt(p)) / start) };
}
function basketReturn(over, scheme, tickers = State.basket) {
  const b = basketPath(over, scheme, tickers);
  return b ? b.levels[b.levels.length - 1] / 100 - 1 : null;
}
function spyPath(over) {
  const bench = State.base.meta.benchmark_returns || {};
  if (bench[over] == null) return null;
  return wtTimeline(over).map((p) =>
    p === "now" ? 100 * (1 + bench[over])
      : bench[p] == null ? null : (100 * (1 + bench[over])) / (1 + bench[p]));
}

// Time-scaled line chart (x = days before today), for the weights-over-time and
// basket-vs-SPY views. `muted` series draw thin and grey behind the coloured
// ones; with `endLabels` every line is named at its right end (nudged apart).
function wtLineChart(points, series, { fmt, endLabels = false, lo: lo0, hi: hi0, width = 900 } = {}) {
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) return `<div class="na">No data for this window.</div>`;
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
  lo = lo0 != null ? lo0 : lo - pad;
  hi = hi0 != null ? hi0 : hi + pad;
  // Snap the scale to round ticks (1 / 2 / 2.5 / 5 × 10^k).
  const raw = (hi - lo) / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw * 0.999);
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  const W = width, H = endLabels ? 340 : 280, padT = 14, padB = 30, padL = 52;
  const padR = endLabels ? 190 : 20;
  const days = points.map((p) => (p === "now" ? 0 : winDays(p)));
  const span = Math.max(1, days[0]);
  const x = (i) => padL + (1 - days[i] / span) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart wtchart" role="img">`;
  for (const gv of ticks) {
    const gy = y(gv).toFixed(1);
    svg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="${C.line}"/>` +
      `<text x="${padL - 8}" y="${(+gy + 3.5).toFixed(1)}" fill="${C.muted}" font-size="11" text-anchor="end">${fmt(gv)}</text>`;
  }
  // Label the time axis right-to-left, skipping points that would collide.
  let lastX = Infinity;
  for (let i = points.length - 1; i >= 0; i--) {
    const px = x(i);
    if (lastX - px < 44) continue;
    svg += `<text x="${px.toFixed(1)}" y="${H - 9}" fill="${C.muted}" font-size="11" text-anchor="middle">${points[i] === "now" ? "Now" : points[i] + " ago"}</text>`;
    lastX = px;
  }
  const ordered = [...series.filter((s) => s.muted), ...series.filter((s) => !s.muted)];
  ordered.forEach((s) => {
    const pts = s.values.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
    const col = s.muted ? C.muted : s.color;
    svg += `<g class="wtline${s.muted ? " muted" : ""}"><title>${esc(s.name)}</title>`;
    if (pts.length > 1) svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${col}" stroke-width="${s.muted ? 1.5 : MARK.line}" stroke-linejoin="round" stroke-linecap="round"/>`;
    s.values.forEach((v, i) => {
      if (v == null) return;
      svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${s.muted ? 2.6 : MARK.dot}" fill="${col}" stroke="${C.panel}" stroke-width="${MARK.ring}" class="mk"><title>${esc(s.name)} · ${wtAgo(points[i])}: ${fmt(v)}</title></circle>`;
    });
    svg += `</g>`;
  });
  if (endLabels) {
    const n = points.length - 1, minGap = 14;
    const labs = series.filter((s) => s.values[n] != null)
      .map((s) => ({ s, y: y(s.values[n]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labs.length; i++) labs[i].y = Math.max(labs[i].y, labs[i - 1].y + minGap);
    const over = labs.length ? labs[labs.length - 1].y - (H - padB) : 0;
    if (over > 0) labs.forEach((l) => (l.y -= over));
    for (let i = labs.length - 2; i >= 0; i--) labs[i].y = Math.min(labs[i].y, labs[i + 1].y - minGap);
    labs.forEach(({ s, y: ly }) => {
      const lx = x(n) + 10;
      svg += `<circle cx="${lx + 3}" cy="${(ly - 0.5).toFixed(1)}" r="3.5" fill="${s.muted ? C.muted : s.color}"/>` +
        `<text x="${lx + 11}" y="${(ly + 3.5).toFixed(1)}" fill="${s.muted ? C.muted : C.text}" font-size="11.5">${esc(s.name)} ${fmt(s.values[n])}</text>`;
    });
  }
  return svg + `</svg>`;
}

function updateBasketCount() { $("wtCount").textContent = State.basket.size; }

function toggleBasket(ticker) {
  if (State.basket.has(ticker)) State.basket.delete(ticker);
  else State.basket.add(ticker);
  saveBasket(); updateBasketCount(); renderWeights();
}
function setBasket(tickers) {
  State.basket = new Set(tickers);
  saveBasket(); updateBasketCount(); renderWeights();
}
function toggleSectorBasket(sector) {
  const names = State.base.rows.filter((r) => (r.sector || "Unknown") === sector).map((r) => r.ticker);
  const allIn = names.length && names.every((t) => State.basket.has(t));
  names.forEach((t) => (allIn ? State.basket.delete(t) : State.basket.add(t)));
  saveBasket(); updateBasketCount(); renderWeights();
}
function wtByWeight() {
  return [...weightUniverse().capped].sort((a, b) => b.market_cap - a.market_cap);
}

// Ready-made baskets: load one as your basket, or overlay it on the compare
// chart. Hand-picked lists are filtered to names in today's screen, so a
// delisting just shrinks the basket. `scheme` pins the weighting (the
// equal-weight index is the point of that basket); otherwise it follows yours.
const WT_BASKETS = [
  { id: "top10", label: "Top 10", note: "The 10 biggest names by index weight", top: 10 },
  { id: "top25", label: "Top 25", note: "The 25 biggest names by index weight", top: 25 },
  { id: "top50", label: "Top 50", note: "The 50 biggest names by index weight", top: 50 },
  { id: "top100", label: "Top 100", note: "The 100 biggest names by index weight", top: 100 },
  { id: "mag7", label: "Magnificent 7", list: "AAPL MSFT GOOGL AMZN NVDA META TSLA" },
  { id: "chips", label: "Chipmakers", list: "NVDA AVGO AMD MU INTC QCOM TXN AMAT LRCX KLAC ADI MRVL MCHP NXPI ON MPWR" },
  { id: "memory", label: "Memory & storage", list: "MU WDC STX SNDK" },
  { id: "banks", label: "Big banks", list: "JPM BAC WFC C GS MS" },
  { id: "pharma", label: "Big pharma", list: "LLY JNJ ABBV MRK PFE BMY AMGN" },
  { id: "staples", label: "Household staples", list: "WMT COST PG KO PEP PM" },
  { id: "oil", label: "Oil majors", list: "XOM CVX COP EOG" },
  { id: "ew", label: "Equal-weight S&P 500", note: "Every name, same dollars in each (like RSP)", all: true, scheme: "equal" },
];
const WT_SERIES = [...SERIES, "#c98500"];   // + a 4th hue; validated with SERIES as lines
const WT_MAX_COMPARE = WT_SERIES.length - 1;  // slot 0 is always your basket

function wtBasketTickers(b) {
  const inScreen = new Set(State.base.rows.map((r) => r.ticker));
  if (b.top) return wtByWeight().slice(0, b.top).map((r) => r.ticker);
  if (b.all) return State.base.rows.map((r) => r.ticker);
  return b.list.split(" ").filter((t) => inScreen.has(t));
}
const wtBasketById = (id) => WT_BASKETS.find((b) => b.id === id);
function wtSameAsBasket(tickers) {
  return tickers.length === State.basket.size && tickers.every((t) => State.basket.has(t));
}

// Compare slots keep their colour when a neighbour is removed (colour follows
// the basket, not its position in the list).
function toggleCompare(id) {
  const i = State.wtCompare.indexOf(id);
  if (i >= 0) State.wtCompare[i] = null;
  else {
    const free = State.wtCompare.indexOf(null);
    if (free < 0) return;
    State.wtCompare[free] = id;
  }
  saveFilters(); renderWeights();
}

// The basket picker: ready-made baskets, sector chips, add-by-search, and the
// current basket as removable chips. Every control here is one click.
function renderWtPicker() {
  const byW = wtByWeight(), { rows, total } = weightUniverse();
  const cur = State.basket;
  $("wtPresets").innerHTML = WT_BASKETS.map((b) => {
    const t = wtBasketTickers(b);
    return `<button class="wtchip${wtSameAsBasket(t) ? " on" : ""}" data-load="${b.id}" title="${esc(b.note || t.join(", "))}">${esc(b.label)}</button>`;
  }).join("") + `<button class="wtchip clear" data-load="clear"${cur.size ? "" : " disabled"}>Clear</button>`;
  $("wtPresets").querySelectorAll("[data-load]").forEach((btn) => (btn.onclick = () => {
    const k = btn.dataset.load;
    setBasket(k === "clear" ? [] : wtBasketTickers(wtBasketById(k)));
  }));

  const cnt = {}, inb = {}, mc = {};
  rows.forEach((r) => {
    const s = r.sector || "Unknown";
    cnt[s] = (cnt[s] || 0) + 1;
    mc[s] = (mc[s] || 0) + (r.market_cap > 0 ? r.market_cap : 0);
    if (cur.has(r.ticker)) inb[s] = (inb[s] || 0) + 1;
  });
  $("wtSecChips").innerHTML = Object.keys(cnt).sort((a, b) => mc[b] - mc[a]).map((s) => {
    const k = inb[s] || 0, st = k === 0 ? "" : k === cnt[s] ? " on" : " some";
    return `<button class="wtchip${st}" data-sector="${esc(s)}" title="${k === cnt[s] ? "Remove" : "Add"} all ${cnt[s]} ${esc(s)} names">${esc(s)} <span class="wtchip-n">${k}/${cnt[s]}</span></button>`;
  }).join("");
  $("wtSecChips").querySelectorAll("[data-sector]").forEach((b) =>
    (b.onclick = () => toggleSectorBasket(b.dataset.sector)));

  const chosen = byW.filter((r) => cur.has(r.ticker));
  const mcIn = chosen.reduce((a, r) => a + r.market_cap, 0);
  const SHOW = 30;
  $("wtChosen").innerHTML = chosen.length
    ? `<span class="wtsum"><b>${chosen.length}</b> name${chosen.length === 1 ? "" : "s"} · <b>${wpct(total ? mcIn / total : 0, 1)}</b> of the index</span>` +
      chosen.slice(0, SHOW).map((r) =>
        `<button class="wtchip on sm" data-rm="${r.ticker}" title="Remove ${r.ticker}">${r.ticker} <span class="x">×</span></button>`).join("") +
      (chosen.length > SHOW ? `<span class="na">+${chosen.length - SHOW} more</span>` : "")
    : `<span class="na">Empty. Load a ready-made basket, add a sector, or search for a name.</span>`;
  $("wtChosen").querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => toggleBasket(b.dataset.rm)));
  renderWtSuggest();
}

function renderWtSuggest() {
  const q = ($("wtSearch").value || "").trim().toLowerCase();
  const box = $("wtSuggest");
  if (!q) { box.innerHTML = ""; return; }
  const hits = wtByWeight().filter((r) =>
    r.ticker.toLowerCase().startsWith(q) || (r.name || "").toLowerCase().includes(q)).slice(0, 8);
  box.innerHTML = hits.length
    ? hits.map((r) => {
        const on = State.basket.has(r.ticker);
        return `<button class="wtchip${on ? " on" : ""} sm" data-tk="${r.ticker}">${on ? "✓" : "+"} ${r.ticker} <span class="wtchip-n">${esc(r.name)}</span></button>`;
      }).join("")
    : `<span class="na">No match.</span>`;
  box.querySelectorAll("[data-tk]").forEach((b) => (b.onclick = () => toggleBasket(b.dataset.tk)));
}

function wtSegs(id, cur, opts) {
  $(id).innerHTML = opts.map(([v, l]) =>
    `<button data-v="${v}" class="${v === cur ? "on" : ""}">${l}</button>`).join("");
}

function renderWtSectors(over) {
  const then = wtIndexAt(over), now = wtIndexAt("now");
  const secs = Object.keys(now.sec).sort((a, b) => now.sec[b] - now.sec[a]);
  $("wtSecTitle").textContent = `Sector weights · ${over} ago → now`;
  wtSegs("wtSecView", State.wtSecView, [["bars", "Bars"], ["lines", "Lines"]]);
  if (State.wtSecView === "lines") {
    const points = wtTimeline(over), at = points.map((p) => wtIndexAt(p).sec);
    const colored = secs.slice(0, SERIES.length);   // the three biggest sectors today
    const series = secs.map((s) => ({
      name: s, values: at.map((m) => (m[s] == null ? null : m[s])),
      color: SERIES[colored.indexOf(s)], muted: !colored.includes(s),
    }));
    $("wtSectors").innerHTML =
      wtLineChart(points, series, { fmt: (v) => +(v * 100).toFixed(1) + "%", endLabels: true, lo: 0 }) +
      `<p class="sub2">Share of the index at each point, rebuilt from each name's price then. Hover a point for its value.</p>`;
    return;
  }
  const maxW = Math.max(0.01, ...secs.map((s) => Math.max(now.sec[s] || 0, then.sec[s] || 0)));
  $("wtSectors").innerHTML =
    `<div class="wtsec wtsec-head"><div></div><div class="legend" style="margin:0">` +
    `<span><i style="background:${C.accent}"></i>Now</span><span><i class="tick"></i>${over} ago</span></div>` +
    `<div class="wtsec-w">Now</div><div class="wtsec-w">Then</div><div class="wtsec-w">Change</div></div>` +
    secs.map((s) => {
      const a = now.sec[s] || 0, b = then.sec[s];
      return `<div class="wtsec" title="${esc(s)}: ${wpct(b)} ${over} ago → ${wpct(a)} now">
        <div class="wtsec-name">${esc(s)}</div>
        <div class="wtsec-bar"><span class="wtsec-fill" style="width:${(a / maxW) * 100}%"></span>` +
        (b != null ? `<span class="wtsec-then" style="left:${(b / maxW) * 100}%"></span>` : "") + `</div>
        <div class="wtsec-w">${wpct(a)}</div><div class="wtsec-w na">${wpct(b)}</div>
        <div class="wtsec-w">${wpts(b == null ? null : a - b)}</div></div>`;
    }).join("");
}

// Everything the compare card plots: your basket (slot 0) plus each compared
// ready-made basket in its own colour slot.
function wtCompareSet(scheme) {
  const out = [{ key: "mine", name: "Your basket", tickers: State.basket, scheme, color: WT_SERIES[0] }];
  State.wtCompare.forEach((id, i) => {
    const b = id && wtBasketById(id);
    if (b) out.push({ key: id, name: b.label, tickers: new Set(wtBasketTickers(b)),
                      scheme: b.scheme || scheme, color: WT_SERIES[i + 1], preset: b });
  });
  return out;
}

function renderWtCompare(over, scheme) {
  const { total } = weightUniverse();
  const bench = State.base.meta.benchmark_returns || {};
  const full = State.wtCompare.every((x) => x != null);
  $("wtCmpPick").innerHTML = WT_BASKETS.map((b) => {
    const slot = State.wtCompare.indexOf(b.id), on = slot >= 0;
    const dis = !on && full ? ` disabled title="Remove one to compare another (max ${WT_MAX_COMPARE})"` : ` title="${esc(b.note || wtBasketTickers(b).join(", "))}"`;
    return `<button class="wtchip sm${on ? " cmp-on" : ""}" data-cmp="${b.id}"${dis}>` +
      (on ? `<i class="wtdot" style="background:${WT_SERIES[slot + 1]}"></i>` : "+ ") + `${esc(b.label)}</button>`;
  }).join("");
  $("wtCmpPick").querySelectorAll("[data-cmp]").forEach((b) => (b.onclick = () => toggleCompare(b.dataset.cmp)));
  wtSegs("wtCmpView", State.wtCmpView, [["chart", "Chart"], ["table", "All windows"]]);

  const set = wtCompareSet(scheme).filter((x) => x.tickers.size);
  if (!set.length) {
    $("wtCompare").innerHTML = `<p class="na">Build a basket above, or pick a ready-made one to compare against SPY.</p>`;
    return;
  }
  const schemeTxt = (x) => (x.scheme === "cap" ? "cap-weighted" : "equal-weighted");

  if (State.wtCmpView === "table") {
    const head = set.map((x) => `<th class="num"><i class="wtdot" style="background:${x.color}"></i>${esc(x.name)}</th>`).join("");
    const body = WINDOWS.map((w) => {
      const cells = set.map((x) => {
        const r = basketReturn(w, x.scheme, x.tickers), d = r != null && bench[w] != null ? r - bench[w] : null;
        return `<td class="num">${pct(r)}${d == null ? "" : ` <span class="wtvs ${d >= 0 ? "ret-up" : "ret-down"}">${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}</span>`}</td>`;
      }).join("");
      return `<tr${w === over ? ' class="cur"' : ""}><td class="wcw">${w}</td>${cells}<td class="num">${pct(bench[w])}</td></tr>`;
    }).join("");
    $("wtCompare").innerHTML =
      `<div class="tablewrap"><table class="wtcmp"><thead><tr><th>Window</th>${head}<th class="num">SPY</th></tr></thead><tbody>${body}</tbody></table></div>` +
      `<p class="sub2">Return over each window; the small number is the gap to SPY in points.</p>`;
    return;
  }

  const series = [], rowsHtml = [];
  set.forEach((x) => {
    const b = basketPath(over, x.scheme, x.tickers);
    const mc = State.base.rows.filter((r) => x.tickers.has(r.ticker) && r.market_cap > 0)
      .reduce((a, r) => a + r.market_cap, 0);
    const ret = b ? b.levels[b.levels.length - 1] / 100 - 1 : null;
    const d = ret != null && bench[over] != null ? ret - bench[over] : null;
    const left = b ? x.tickers.size - b.members.length : 0;
    if (b) series.push({ name: x.name, values: b.levels, color: x.color });
    rowsHtml.push(`<tr><td><i class="wtdot" style="background:${x.color}"></i><b>${esc(x.name)}</b>` +
      `<div class="na wtsmall">${x.tickers.size} names · ${schemeTxt(x)}${left ? ` · ${left} without a price ${over} back, left out` : ""}</div></td>` +
      `<td class="num">${wpct(total ? mc / total : 0, 1)}</td><td class="num">${pct(ret)}</td>` +
      `<td class="num">${d == null ? '<span class="na">—</span>' : pct(d)}</td>` +
      `<td class="num">${x.preset
        ? (wtSameAsBasket([...x.tickers]) ? '<span class="na">Is your basket</span>' : `<button class="ghost small" data-use="${x.key}">Use as my basket</button>`)
        : ""}</td></tr>`);
  });
  const spy = spyPath(over);
  if (spy) series.push({ name: "SPY", values: spy, color: C.muted, muted: true });
  rowsHtml.push(`<tr class="spyrow"><td><i class="wtdot" style="background:${C.muted}"></i><b>SPY</b><div class="na wtsmall">S&amp;P 500 ETF (the benchmark)</div></td>` +
    `<td class="num">100%</td><td class="num">${pct(bench[over])}</td><td class="num"><span class="na">—</span></td><td></td></tr>`);

  $("wtCompare").innerHTML =
    wtLineChart(wtTimeline(over), series, { fmt: (v) => "$" + +v.toFixed(1), endLabels: true }) +
    `<p class="sub2">$100 put into each basket ${over} ago and held to today. Hover a point for its value.</p>` +
    `<div class="tablewrap"><table class="wtcmp wtcmp-sum"><thead><tr><th>Basket</th><th class="num">Share of index</th>` +
    `<th class="num">${over} return</th><th class="num">vs SPY</th><th></th></tr></thead><tbody>${rowsHtml.join("")}</tbody></table></div>`;
  $("wtCompare").querySelectorAll("[data-use]").forEach((b) =>
    (b.onclick = () => setBasket(wtBasketTickers(wtBasketById(b.dataset.use)))));
}

function renderWtNames(over) {
  const { capped, total } = weightUniverse(), then = wtIndexAt(over);
  $("wtHead").innerHTML =
    `<th class="star-h"></th><th>Ticker</th><th>Company</th><th>Sector</th>` +
    `<th class="num">Weight now</th><th class="num">${over} ago</th><th class="num">Change</th>` +
    `<th class="num">${over} return</th>`;
  const rows = [...capped].sort((a, b) => b.market_cap - a.market_cap).slice(0, 100);
  const tb = $("wtRows");
  tb.innerHTML = "";
  const frag = document.createDocumentFragment();
  rows.forEach((r) => {
    const on = State.basket.has(r.ticker);
    const wNow = total ? r.market_cap / total : 0;
    const v = capAt(r, over), wThen = v != null && then.total ? v / then.total : null;
    const tr = document.createElement("tr");
    tr.dataset.tk = r.ticker;
    if (on) tr.classList.add("inbasket");
    tr.innerHTML =
      `<td class="starcell"><span class="bchk ${on ? "on" : "off"}">${on ? "✓" : "+"}</span></td>` +
      `<td class="tk">${r.ticker}</td><td>${esc(r.name)}</td><td>${esc(r.sector || "")}</td>` +
      `<td class="num">${wpct(wNow)}</td><td class="num na">${wpct(wThen)}</td>` +
      `<td class="num">${wpts(wThen == null ? null : wNow - wThen)}</td>` +
      `<td class="num">${pct(r.returns[over])}</td>`;
    tr.onclick = () => toggleBasket(r.ticker);
    frag.appendChild(tr);
  });
  tb.appendChild(frag);
}

function renderWeights() {
  if (!State.base) return;
  palette();
  const over = State.wtOver, scheme = State.wtScheme;
  const { capped, total } = weightUniverse();

  const hasData = capped.length > 0;
  $("wtEmpty").classList.toggle("hidden", hasData);
  $("wtBody").classList.toggle("hidden", !hasData);
  if (!hasData) { $("wtStatus").textContent = ""; return; }

  // Index totals + concentration, now vs the start of the window.
  const now = wtIndexAt("now"), then = wtIndexAt(over);
  $("wtStatus").innerHTML =
    `Index ≈ <b>${money(total)}</b> across ${capped.length} weighted names · ` +
    `top 10 = <b>${wpct(now.top(10))}</b> <span class="na">(${wpct(then.top(10))} ${over} ago)</span> · ` +
    `top 50 = <b>${wpct(now.top(50))}</b> <span class="na">(${wpct(then.top(50))})</span>. ` +
    `<span class="na">Approx. weights: full market cap, not float-adjusted; past weights assume today's share counts and members.</span>`;

  renderWtPicker();
  renderWtCompare(over, scheme);
  renderWtSectors(over);
  renderWtNames(over);
}

// ---------------- Detail view ----------------
function paintDetailBasket(ticker) {
  const b = $("detailBasket"), on = State.basket.has(ticker);
  if (!b) return;
  b.classList.toggle("on", on);
  b.textContent = on ? "✓ In your basket" : "+ Add to basket";
  b.title = "Your basket lives on the Weights tab, where you can chart it against SPY";
}

async function loadProfile(ticker, force = false) {
  if (!force && State.detailCache[ticker]) return State.detailCache[ticker];
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem("ss-co-" + ticker));
      if (cached) { State.detailCache[ticker] = cached; return cached; }
    } catch (e) {}
  }
  const res = await fetch("/api/company/" + encodeURIComponent(ticker));
  const p = await res.json();
  State.detailCache[ticker] = p;
  try { localStorage.setItem("ss-co-" + ticker, JSON.stringify(p)); } catch (e) {}
  return p;
}

function computePeers(sector, ticker) {
  if (!State.base || !sector) return null;
  const rows = State.base.rows.filter((r) => r.sector === sector);
  if (!rows.length) return null;
  const med = {};
  WINDOWS.forEach((w) => { med[w] = median(rows.map((r) => r.returns[w]).filter((v) => v != null)); });
  const sorted = [...rows].sort((a, b) => (b.returns["1Y"] ?? -Infinity) - (a.returns["1Y"] ?? -Infinity));
  const rank = sorted.findIndex((r) => r.ticker === ticker) + 1;
  return { sector, count: rows.length, rank, median: med,
           spy: State.base.meta.benchmark_returns || {} };
}

async function openDetail(ticker) {
  State.detailTicker = ticker;
  $("detailTabName").textContent = ticker;
  $("detailTab").classList.remove("hidden");
  switchTab("detail");
  $("detailBody").innerHTML = `<p class="loading">Loading ${ticker} — data, trends, analysts &amp; news…</p>`;
  try {
    const p = await loadProfile(ticker);
    // Use the screen's GICS sector (yfinance's own sector label differs).
    const baseRow = State.base && State.base.rows.find((r) => r.ticker === ticker);
    p._peers = computePeers(baseRow ? baseRow.sector : p.identity.sector, ticker);
    const on = isWatched(ticker);
    $("detailBody").innerHTML =
      `<a class="back" id="detailBack">← Back to list</a>` +
      `<button id="detailStar" class="watchbtn ${on ? "on" : ""}">${on ? "★ Watching" : "☆ Add to watchlist"}</button>` +
      `<button id="detailBasket" class="watchbtn"></button>` +
      `<a class="ext pblink" href="/company/${encodeURIComponent(ticker)}" target="_blank" rel="noopener">Open standalone ↗</a>` +
      buildProfileHTML(p);
    const back = $("detailBack");
    if (back) back.onclick = () => switchTab("stocks");
    const star = $("detailStar");
    if (star) star.onclick = () => toggleWatch(ticker);
    paintDetailBasket(ticker);
    $("detailBasket").onclick = () => { toggleBasket(ticker); paintDetailBasket(ticker); };
  } catch (e) {
    $("detailBody").innerHTML = `<p class="na">Failed to load ${ticker}: ${e}</p>`;
  }
}

// ---------------- Command palette (Cmd/Ctrl-K, /) ----------------
// Fast jump to any ticker's pitchbook, plus a few nav actions. Named `Cmd*`
// so nothing collides with the helpers company.js declares in the shared scope.
const Cmd = { open: false, results: [], sel: 0 };

function paletteActions() {
  return [
    { type: "nav", label: "Go to Individual stocks", hint: "tab", run: () => switchTab("stocks") },
    { type: "nav", label: "Go to Watchlist", hint: "tab", run: () => switchTab("watchlist") },
    { type: "nav", label: "Go to Sectors", hint: "tab", run: () => switchTab("sectors") },
    { type: "nav", label: "Go to Weights", hint: "tab", run: () => switchTab("weights") },
    { type: "nav", label: "Refresh data (re-pull prices)", hint: "action", run: () => $("refresh").click() },
  ];
}

function scoreTicker(r, q) {
  const t = r.ticker.toLowerCase(), n = (r.name || "").toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (n.startsWith(q)) return 2;
  if (t.includes(q)) return 3;
  if (n.includes(q)) return 4;
  return 99;
}

function computePaletteResults(query) {
  const q = (query || "").trim().toLowerCase();
  const rows = (State.base && State.base.rows) || [];
  if (!q) {
    // Empty query: nav actions, then your watchlist for one-key access.
    const wl = rows.filter((r) => State.watchlist.has(r.ticker))
                   .map((r) => ({ type: "ticker", row: r }));
    return [...paletteActions(), ...wl];
  }
  const tickers = rows
    .map((r) => ({ r, s: scoreTicker(r, q) }))
    .filter((x) => x.s < 99)
    .sort((a, b) => a.s - b.s || a.r.ticker.localeCompare(b.r.ticker))
    .slice(0, 20)
    .map((x) => ({ type: "ticker", row: x.r }));
  const navs = paletteActions().filter((a) => a.label.toLowerCase().includes(q));
  return [...tickers, ...navs];
}

function renderPalette() {
  const list = $("cmdkList");
  const res = Cmd.results;
  if (!res.length) { list.innerHTML = `<div class="cmdk-empty">No matches.</div>`; return; }
  list.innerHTML = res.map((it, i) => {
    const sel = i === Cmd.sel ? " sel" : "";
    if (it.type === "nav") {
      return `<div class="cmdk-item nav${sel}" data-i="${i}">` +
        `<span class="ci-star">→</span><span class="ci-tk"></span>` +
        `<span class="ci-name">${esc(it.label)}</span>` +
        `<span class="ci-ret na">${it.hint}</span></div>`;
    }
    const r = it.row, on = isWatched(r.ticker);
    return `<div class="cmdk-item${sel}" data-i="${i}">` +
      `<span class="ci-star star ${on ? "on" : "off"}" title="Toggle watchlist">${on ? "★" : "☆"}</span>` +
      `<span class="ci-tk">${r.ticker}</span>` +
      `<span class="ci-name">${esc(r.name || "")} <span class="ci-sec">${esc(r.sector || "")}</span></span>` +
      `<span class="ci-ret">${pct(r.returns["1Y"])}</span></div>`;
  }).join("");
  list.querySelectorAll(".cmdk-item").forEach((el) => {
    const i = +el.dataset.i;
    el.onmouseenter = () => { Cmd.sel = i; highlightPalette(); };
    el.onclick = (e) => {
      if (e.target.classList.contains("star")) {
        const it = Cmd.results[i];
        if (it && it.type === "ticker") { toggleWatch(it.row.ticker); renderPalette(); }
        return;
      }
      Cmd.sel = i; runPalette();
    };
  });
}

function highlightPalette() {
  const items = $("cmdkList").querySelectorAll(".cmdk-item");
  items.forEach((el, i) => el.classList.toggle("sel", i === Cmd.sel));
  if (items[Cmd.sel]) items[Cmd.sel].scrollIntoView({ block: "nearest" });
}

function runPalette() {
  const it = Cmd.results[Cmd.sel];
  if (!it) return;
  closePalette();
  if (it.type === "nav") it.run();
  else openDetail(it.row.ticker);
}

function openPalette() {
  Cmd.open = true;
  Cmd.sel = 0;
  $("cmdk").classList.remove("hidden");
  const inp = $("cmdkInput");
  inp.value = "";
  Cmd.results = computePaletteResults("");
  renderPalette();
  inp.focus();
}

function closePalette() {
  Cmd.open = false;
  $("cmdk").classList.add("hidden");
}

function onPaletteInput() {
  Cmd.results = computePaletteResults($("cmdkInput").value);
  Cmd.sel = 0;
  renderPalette();
}

function onPaletteKey(e) {
  const n = Cmd.results.length;
  if (e.key === "ArrowDown") { e.preventDefault(); Cmd.sel = n ? (Cmd.sel + 1) % n : 0; highlightPalette(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); Cmd.sel = n ? (Cmd.sel - 1 + n) % n : 0; highlightPalette(); }
  else if (e.key === "Enter") { e.preventDefault(); runPalette(); }
  else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
}

// ---------------- Keyboard row cursor (stocks / watchlist tables) ----------------
function cursorRows() {
  const tb = State.active === "watchlist" ? $("wlRows") : $("rows");
  return Array.from(tb.querySelectorAll("tr"));
}
function clearCursor() {
  document.querySelectorAll("tr.rowsel").forEach((el) => el.classList.remove("rowsel"));
  State.cursor = -1;
}
function moveCursor(delta) {
  const rows = cursorRows();
  if (!rows.length) return;
  let i = State.cursor < 0 ? (delta > 0 ? 0 : rows.length - 1) : State.cursor + delta;
  i = Math.max(0, Math.min(rows.length - 1, i));
  State.cursor = i;
  rows.forEach((r, j) => r.classList.toggle("rowsel", j === i));
  rows[i].scrollIntoView({ block: "nearest" });
}

// ---------------- Tabs ----------------
function switchTab(name) {
  clearCursor();
  closeColPop();
  State.active = name;
  ["stocks", "watchlist", "sectors", "weights", "detail"].forEach((v) => {
    $("view-" + v).classList.toggle("hidden", v !== name);
  });
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name));
  if (name === "sectors") renderSectors();
  if (name === "watchlist") renderWatchlist();
  if (name === "weights") renderWeights();
  syncHash();
}

// ---------------- URL routing (deep links) ----------------
// Mirror the active view into location.hash so a stock or tab survives a
// refresh and is bookmarkable, and browser back/forward navigate the app.
//   #/stocks  #/watchlist  #/sectors  #/company/<TICKER>
let programmaticHash = false;   // our own hash writes shouldn't re-trigger routing
function currentHash() {
  if (State.active === "detail" && State.detailTicker)
    return "#/company/" + encodeURIComponent(State.detailTicker);
  return "#/" + State.active;
}
function syncHash() {
  const h = currentHash();
  if (location.hash !== h) { programmaticHash = true; location.hash = h; }
}
function applyHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "company" && parts[1]) {
    openDetail(decodeURIComponent(parts[1]).toUpperCase());
    return;
  }
  switchTab(["watchlist", "sectors", "weights", "stocks"].includes(parts[0]) ? parts[0] : "stocks");
}

// ---------------- Boot + events ----------------
function syncControlsFromState() {
  $("secOver").value = State.secOver;
  $("wtOver").value = State.wtOver;
  $("wtScheme").value = State.wtScheme;
  $("theme").value = localStorage.getItem("ss-theme") || "midnight";
}

function setMeta() {
  const m = State.base.meta, br = m.benchmark_returns || {};
  const age = (Date.now() - State.base.ts) / 1000;
  const b = (w) => (br[w] != null ? (br[w] * 100).toFixed(0) + "%" : "—");
  $("meta").innerHTML =
    `${m.evaluated}/${m.universe_size} names · ${m.benchmark} 1Y ${b("1Y")} · 5Y ${b("5Y")}<br>` +
    `<span class="na">cached ${fmtAge(age)} · pulled ${m.generated_at || "?"}</span>`;
}

// ---------------- Refresh ----------------
// How long to wait for an Action-driven pull: the run itself is ~2-3 min, plus
// Vercel's redeploy of the resulting commit.
const REFRESH_POLL_MS = 15000;
const REFRESH_WAIT_MS = 6 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function redrawAll() {
  setMeta();
  renderStocks();
  if (State.active === "sectors") renderSectors();
  if (State.active === "weights") renderWeights();
  if (State.active === "watchlist") renderWatchlist();
}

// Ask the precompute Action for an off-schedule pull, then poll until its commit
// deploys. `published` is the generated_at we're already showing — new data is
// simply a generated_at that differs from it.
async function pullFresh(published) {
  const showing = `Showing data pulled ${esc(published || "?")}`;
  if (!State.base.meta.can_trigger_refresh) {
    $("status-line").innerHTML =
      `${showing} — the newest published. On-demand pulls are off ` +
      `(no GitHub token on the server); the next scheduled run will bring more.`;
    return;
  }

  let info;
  try {
    info = await (await fetch("/api/refresh", { method: "POST" })).json();
  } catch (e) {
    info = { queued: false, message: "Couldn't reach the server." };
  }
  if (!info.queued) {
    $("status-line").innerHTML =
      `<span class="ret-down">Couldn't start a fresh pull.</span> ` +
      `${esc(info.message || "")} ${showing}.`;
    return;
  }

  const started = Date.now();
  const deadline = started + REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    const mins = Math.round((Date.now() - started) / 60000);
    $("status-line").innerHTML =
      `Pulling fresh prices on GitHub (~2-3 min${mins ? `, ${mins}m elapsed` : ""})… ` +
      `${showing} until it lands.`;
    await sleep(REFRESH_POLL_MS);
    let now = null;
    try { now = await fetchBase(true); } catch (e) { continue; }
    if (now && now !== published) {
      redrawAll();
      $("status-line").innerHTML =
        `<span class="ret-up">Fresh data in</span> — pulled ${esc(now)}.`;
      return;
    }
  }
  $("status-line").innerHTML =
    `The pull is still running. ${showing} — hit Refresh again shortly to pick it up.`;
}

// The Action publishes a fresh screen twice a day, but a browser holding a cached
// copy in localStorage would never see it — before this, only the Refresh button
// replaced that copy, so a stale cache + a failing Refresh meant permanently old
// data. Once our copy ages past this, re-check in the background on load and adopt
// anything newer. Cheap: the server just reads the committed file (~1s).
const BASE_STALE_MS = 60 * 60 * 1000;

async function freshenIfStale() {
  if (State.base.ts && Date.now() - State.base.ts < BASE_STALE_MS) return;
  const before = State.base.meta.generated_at;
  let now;
  try { now = await fetchBase(false); } catch (e) { return; }
  if (now !== before) redrawAll();
  else setMeta();   // nothing new, but the "cached … old" label should still reset
}

async function boot() {
  purgeStaleCaches();
  loadFilters();
  loadTable();
  loadWatchlist();
  loadBasket();
  updateWatchCount();
  updateBasketCount();
  syncControlsFromState();

  const cached = loadBase();
  if (cached && cached.rows) {
    State.base = cached;
    WINDOWS = cached.meta.windows || WINDOWS;
    setMeta();
    renderStocks();
    freshenIfStale();   // deliberately not awaited: paint now, adopt newer data when it lands
  } else {
    $("status-line").textContent = "Fetching the S&P 500 (first run pulls ~500 names)…";
    await fetchBase(false);
    setMeta();
    renderStocks();
  }

  // The wordmark is home: back to Individual stocks (and to the top of it).
  // The href alone would be a no-op when we're already on #/stocks, hence the handler.
  const brand = document.querySelector(".brand");
  if (brand) brand.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;  // let
    e.preventDefault();                                        // modified clicks open a tab
    switchTab("stocks");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // Column sort/filter popover: dismiss on outside-click, Esc, scroll, resize.
  document.addEventListener("mousedown", (e) => {
    if ($("colpop").classList.contains("hidden")) return;
    if (e.target.closest("#colpop") || e.target.closest(".colhead")) return;
    closeColPop();
  });
  window.addEventListener("scroll", () => {
    if (!$("colpop").classList.contains("hidden")) closeColPop();
  }, true);
  window.addEventListener("resize", () => {
    if (!$("colpop").classList.contains("hidden")) closeColPop();
  });

  $("secOver").addEventListener("change", () => {
    State.secOver = $("secOver").value; saveFilters(); renderSectors();
  });
  // Weights view controls.
  $("wtOver").addEventListener("change", () => {
    State.wtOver = $("wtOver").value; saveFilters(); renderWeights();
  });
  $("wtScheme").addEventListener("change", () => {
    State.wtScheme = $("wtScheme").value; saveFilters(); renderWeights();
  });
  [["wtSecView", "wtSecView"], ["wtCmpView", "wtCmpView"]].forEach(([id, key]) =>
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("button[data-v]");
      if (!b || State[key] === b.dataset.v) return;
      State[key] = b.dataset.v; saveFilters(); renderWeights();
    }));
  $("wtSearch").addEventListener("input", renderWtSuggest);
  $("wtSearch").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("wtSearch").value = ""; renderWtSuggest(); }
    if (e.key !== "Enter") return;
    // Enter only ever adds: the first match not already in the basket.
    const first = [...$("wtSuggest").querySelectorAll("[data-tk]")]
      .find((b) => !State.basket.has(b.dataset.tk));
    if (first) { toggleBasket(first.dataset.tk); $("wtSearch").select(); }
  });

  // Tabs.
  document.querySelectorAll(".tab").forEach((t) => {
    if (t.dataset.tab === "detail") return;
    t.onclick = () => switchTab(t.dataset.tab);
  });
  $("detailClose").onclick = (e) => {
    e.stopPropagation();
    $("detailTab").classList.add("hidden");
    State.detailTicker = null;
    switchTab("stocks");
  };
  $("detailTab").onclick = () => { if (State.detailTicker) switchTab("detail"); };

  // Command palette + global keyboard.
  $("cmdkBtn").querySelector(".cmdk-kbd").textContent =
    /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
  $("cmdkBtn").addEventListener("click", openPalette);
  $("cmdkInput").addEventListener("input", onPaletteInput);
  $("cmdkInput").addEventListener("keydown", onPaletteKey);
  $("cmdk").addEventListener("mousedown", (e) => { if (e.target.id === "cmdk") closePalette(); });

  const isTyping = (el) => el && (el.tagName === "INPUT" || el.tagName === "SELECT" ||
    el.tagName === "TEXTAREA" || el.isContentEditable);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault(); Cmd.open ? closePalette() : openPalette(); return;
    }
    if (e.key === "Escape" && Cmd.open) { closePalette(); return; }
    if (Cmd.open) return;                       // palette input handles its own keys
    if (e.key === "Escape" && !$("colpop").classList.contains("hidden")) { closeColPop(); return; }
    const typing = isTyping(document.activeElement);
    if (e.key === "/" && !typing) { e.preventDefault(); openPalette(); return; }
    if (e.key === "Escape" && !typing && State.active === "detail") { switchTab("stocks"); return; }
    // Arrow / Enter / w row cursor on the stocks + watchlist tables.
    if (!typing && (State.active === "stocks" || State.active === "watchlist")) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveCursor(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveCursor(-1); }
      else if (e.key === "Enter") {
        const r = cursorRows()[State.cursor];
        if (r) openDetail(r.dataset.tk);
      } else if (e.key === "w" || e.key === "W") {
        const r = cursorRows()[State.cursor];
        if (r) { e.preventDefault(); toggleWatch(r.dataset.tk); }
      }
    }
  });

  // Theme.
  $("theme").addEventListener("change", () => {
    const name = $("theme").value;
    document.documentElement.dataset.theme = name;
    localStorage.setItem("ss-theme", name);
    // Re-render so SVG chart colors pick up the new palette.
    if (State.active === "sectors") renderSectors();
    else if (State.active === "weights") renderWeights();
    else if (State.active === "detail" && State.detailTicker)
      loadProfile(State.detailTicker).then((p) => {
        $("detailBody").querySelectorAll(".chart, .gauge, .ratingbar").length &&
          openDetail(State.detailTicker);
      });
  });

  // Refresh: drop the local caches and get the newest data there is.
  //
  // Locally the server pulls live in-request. On the deployed (serverless) app it
  // can't — 500 names × 5y of prices takes ~25s and blows the function budget, which
  // is the whole reason the precompute Action exists. So there we do it in two beats:
  // take whatever the Action last published (instant, always works — this alone
  // un-sticks a browser holding a stale localStorage copy), then ask the Action for
  // an off-schedule pull and poll until its commit redeploys with new prices.
  $("refresh").addEventListener("click", async () => {
    $("refresh").disabled = true;
    $("refresh").textContent = "↻ Refreshing…";
    $("status-line").textContent = "Fetching the latest data…";
    clearDetailCache();
    try {
      const before = State.base && State.base.meta && State.base.meta.generated_at;
      const published = await fetchBase(true);
      redrawAll();

      if (State.base.meta.live_screen) {
        $("status-line").textContent = "";
        return;
      }
      if (published !== before) {
        $("status-line").innerHTML =
          `Updated to the latest published data (pulled ${esc(published)}).`;
      }
      await pullFresh(published);
    } catch (e) {
      $("status-line").innerHTML =
        `<span class="ret-down">Refresh failed.</span> ` +
        `Showing the last data — try again in a moment.`;
    } finally {
      $("refresh").disabled = false;
      $("refresh").textContent = "↻ Refresh data";
    }
  });

  // Deep-link routing: react to back/forward + bookmarks, and honor the
  // initial hash so a refresh lands where you were.
  window.addEventListener("hashchange", () => {
    if (programmaticHash) { programmaticHash = false; return; }
    applyHash();
  });
  if (location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).length) applyHash();
}

boot();
