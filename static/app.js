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
  hist: null,                 // Weights view: price paths from /api/history (lazy)
  spyOut: new Set(),          // How would SPY do?: tickers taken out of the index
  spyRange: { k: "1Y" },      // How would SPY do?: { k: preset } or { from, to } (ISO dates)
  spyAlone: false,            // How would SPY do?: also chart the taken-out names alone
  spyLast: null,              // last computed model (the list re-renders from it on search)
  histFor: null,              // the screen generated_at that `hist` was fetched for
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
  localStorage.setItem("ss-spyout", JSON.stringify([...State.spyOut]));
  localStorage.setItem("ss-spyrange", JSON.stringify(State.spyRange));
  localStorage.setItem("ss-spyalone", State.spyAlone ? "1" : "");
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
  // First visit: start with the Magnificent 7 taken out, so the section has a
  // story to tell straight away. Once a visitor changes it (even to nothing),
  // their own choice is kept.
  const firstOut = () => new Set(wtBasketById("mag7").list.split(" "));
  try {
    const raw = localStorage.getItem("ss-spyout");
    State.spyOut = raw == null ? firstOut() : new Set(JSON.parse(raw) || []);
  } catch (e) { State.spyOut = firstOut(); }
  try {
    const r = JSON.parse(localStorage.getItem("ss-spyrange"));
    State.spyRange = r && (SPY_RANGES.includes(r.k) || /^\d{4}-\d\d-\d\d$/.test(r.from || "")) ? r : { k: "1Y" };
  } catch (e) { State.spyRange = { k: "1Y" }; }
  State.spyAlone = localStorage.getItem("ss-spyalone") === "1";
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

// Price history for the Weights charts (/api/history): per ticker, each close
// divided by the latest one, weekly for ~5y and daily for the last ~100 days.
// Fetched once per published screen, only when the Weights tab is opened; until
// it arrives (or if it's missing) the charts fall back to the 11 lookback points.
const DAY_MS = 864e5;
function wtEnsureHistory() {
  const gen = State.base && State.base.meta.generated_at;
  if (!gen || State.histFor === gen) return;
  State.histFor = gen;
  fetch("/api/history").then((r) => (r.ok ? r.json() : null)).then((h) => {
    if (!h || !h.dates || State.histFor !== gen) return;
    State.hist = { t: h.dates.map((d) => Date.parse(d + "T00:00:00Z")), s: h.series };
    if (State.active === "weights") renderWeights();
  }).catch(() => {});
}

// Everything a chart over window `over` needs: timestamps `t`, and `rel(row)` →
// that name's price at each t divided by today's (null if it has no price at the
// start). The first point is the exact lookback the screen uses (its trailing
// return), so a chart's endpoints always agree with the returns in the tables.
function wtFrame(over) {
  const H = State.hist;
  if (H && H.t.length > 1) {
    const last = H.t[H.t.length - 1], t0 = last - winDays(over) * DAY_MS;
    let i1 = H.t.findIndex((x) => x > t0);
    if (i1 < 0) i1 = H.t.length - 1;
    const t = [t0, ...H.t.slice(i1)];
    const path = (ret, arr) => (ret == null || !arr ? null : [1 / (1 + ret), ...arr.slice(i1)]);
    const bench = State.base.meta.benchmark_returns || {};
    return { t, rich: true, rel: (r) => path(r.returns[over], H.s[r.ticker]), spy: path(bench[over], H.s.SPY) };
  }
  const points = wtTimeline(over), now = Date.now();
  const bench = State.base.meta.benchmark_returns || {};
  const spyRel = (p) => (p === "now" ? 1 : bench[p] == null ? null : 1 / (1 + bench[p]));
  const all = (f) => { const v = points.map(f); return v.some((x) => x == null) ? null : v; };
  return {
    t: points.map((p) => now - (p === "now" ? 0 : winDays(p)) * DAY_MS), rich: false,
    rel: (r) => all((p) => wtRel(r, p)), spy: all(spyRel),
  };
}

// Buy-and-hold basket bought at the start of `over`: its value at each point of
// the frame, indexed to 100 at the start. Cap-weighted holds each name in
// proportion to its market value then (what SPY does); equal-weighted puts the
// same dollars in each name. Names without a price at the start are left out.
// `tickers` is any Set (default: your basket). Returns { members, t, levels } or
// null when nothing qualifies.
function basketPath(over, scheme, tickers = State.basket, frame = wtFrame(over)) {
  const members = [], rels = [];
  State.base.rows.forEach((r) => {
    if (!tickers.has(r.ticker) || (scheme === "cap" && !(r.market_cap > 0))) return;
    const rel = frame.rel(r);
    if (rel) { members.push(r); rels.push(rel); }
  });
  if (!members.length) return null;
  const units = members.map((r, i) => (scheme === "cap" ? r.market_cap : 1 / rels[i][0]));
  const valueAt = (k) => rels.reduce((a, rel, i) => a + units[i] * rel[k], 0);
  const start = valueAt(0);
  return { members, t: frame.t, levels: frame.t.map((_, k) => (100 * valueAt(k)) / start) };
}
function basketReturn(over, scheme, tickers = State.basket) {
  const b = basketPath(over, scheme, tickers);
  return b ? b.levels[b.levels.length - 1] / 100 - 1 : null;
}
function spyPath(over, frame = wtFrame(over)) {
  return frame.spy ? frame.spy.map((v) => (100 * v) / frame.spy[0]) : null;
}

// Sector shares of the index at each point of the frame (names count from their
// first price on).
function wtSectorPaths(frame) {
  const n = frame.t.length, tot = new Array(n).fill(0), sec = {};
  weightUniverse().capped.forEach((r) => {
    const rel = frame.rel(r);
    if (!rel) return;
    const k = r.sector || "Unknown", acc = sec[k] || (sec[k] = new Array(n).fill(0));
    for (let i = 0; i < n; i++) { const v = r.market_cap * rel[i]; acc[i] += v; tot[i] += v; }
  });
  Object.keys(sec).forEach((k) => (sec[k] = sec[k].map((v, i) => (tot[i] ? v / tot[i] : null))));
  return sec;
}

// Time-series line chart, drawn at the container's real pixel width so text
// stays text-sized. Thin lines, one end dot per series, each line named at its
// right end (nudged apart); a baseline (e.g. $100) when given. Hovering shows a
// crosshair, a dot on every line, and a tooltip with all values on that date.
// series: [{ name, values, color, muted }]; opts: { fmt, tipFmt, base, lo, height }.
function wtTimeChart(el, t, series, opts = {}) {
  const fmt = opts.fmt, tipFmt = opts.tipFmt || fmt, labFmt = opts.labFmt || fmt;
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) { el.innerHTML = `<div class="na">No data for this window.</div>`; return; }
  const W = Math.max(300, Math.round(el.clientWidth || 900));
  const narrow = W < 620;
  const H = opts.height ? Math.round(opts.height * (narrow ? 0.8 : 1)) : narrow ? 260 : 320;

  // y: pad, then snap to round ticks (1 / 2 / 2.5 / 5 × 10^k).
  let lo = Math.min(...all, opts.base ?? Infinity), hi = Math.max(...all, opts.base ?? -Infinity);
  const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.05 || 1;
  lo = opts.lo != null ? opts.lo : lo - pad; hi += pad;
  const raw = (hi - lo) / (narrow ? 4 : 5), mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw * 0.999);
  lo = Math.floor(lo / step + 1e-9) * step; hi = Math.ceil(hi / step - 1e-9) * step;

  // Right margin sized to the longest end label (none on narrow screens: the
  // legend / table under the chart names the lines there).
  const labText = (s) => `${s.name}  ${labFmt(s.values[s.values.length - 1])}`;
  const labW = narrow ? 0 : Math.min(W * 0.34, 26 + 6.4 * Math.max(...series.map((s) => labText(s).length)));
  const padL = 50, padR = narrow ? 14 : labW + 12, padT = 12, padB = 28;
  const t0 = t[0], t1 = t[t.length - 1];
  const x = (ms) => padL + ((ms - t0) / (t1 - t0 || 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="wtchart" role="img">`;
  for (let v = lo; v <= hi + step / 2; v += step) {
    const gy = y(v).toFixed(1);
    svg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="${C.line}"/>` +
      `<text x="${padL - 8}" y="${(+gy + 4).toFixed(1)}" fill="${C.muted}" font-size="11" text-anchor="end">${fmt(v)}</text>`;
  }
  if (opts.base != null) {
    const by = y(opts.base).toFixed(1);
    svg += `<line x1="${padL}" y1="${by}" x2="${W - padR}" y2="${by}" stroke="${C.muted}" stroke-dasharray="4 4" opacity=".8"/>`;
  }
  wtTimeTicks(t0, t1, (W - padL - padR) / 80).forEach(([ms, lab]) => {
    svg += `<text x="${x(ms).toFixed(1)}" y="${H - 8}" fill="${C.muted}" font-size="11" text-anchor="middle">${lab}</text>`;
  });
  const ordered = [...series.filter((s) => s.muted), ...series.filter((s) => !s.muted)];
  ordered.forEach((s) => {
    const col = s.muted ? C.muted : s.color;
    let d = "", pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
    });
    svg += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${s.muted ? 1.5 : 2}" stroke-linejoin="round" stroke-linecap="round"${s.muted ? ' opacity=".75"' : ""}/>`;
    const lv = s.values[s.values.length - 1];
    if (lv != null) svg += `<circle cx="${x(t1).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="3.5" fill="${col}" stroke="${C.panel}" stroke-width="1.5"/>`;
  });
  if (!narrow) {
    const labs = series.filter((s) => s.values[s.values.length - 1] != null)
      .map((s) => ({ s, y: y(s.values[s.values.length - 1]) })).sort((a, b) => a.y - b.y);
    const gap = 15;
    for (let i = 1; i < labs.length; i++) labs[i].y = Math.max(labs[i].y, labs[i - 1].y + gap);
    const spill = labs.length ? labs[labs.length - 1].y - (H - padB) : 0;
    if (spill > 0) labs.forEach((l) => (l.y -= spill));
    for (let i = labs.length - 2; i >= 0; i--) labs[i].y = Math.min(labs[i].y, labs[i + 1].y - gap);
    const lx = W - padR + 10;
    labs.forEach(({ s, y: ly }) => {
      svg += `<text x="${lx}" y="${(ly + 4).toFixed(1)}" font-size="12"><tspan fill="${s.muted ? C.muted : C.text}" font-weight="${s.muted ? 400 : 600}">${esc(s.name)}</tspan>` +
        `<tspan fill="${C.muted}"> ${labFmt(s.values[s.values.length - 1])}</tspan></text>`;
    });
  }
  svg += `<g class="wthover" style="display:none"><line y1="${padT}" y2="${H - padB}" stroke="${C.muted}"/>` +
    series.map((s) => `<circle r="4" fill="${s.muted ? C.muted : s.color}" stroke="${C.panel}" stroke-width="2"/>`).join("") + `</g>` +
    `<rect x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" fill="transparent" class="wthit"/></svg>`;
  // On narrow screens there's no room for end labels, so a legend names the lines.
  const legend = narrow ? lineLegend(series.map((s) => ({ ...s, name: esc(s.name), color: s.muted ? C.muted : s.color }))) : "";
  el.innerHTML = `<div class="wtchartwrap">${svg}<div class="wttip hidden"></div></div>${legend}`;

  // Hover / touch: snap to the nearest date.
  const wrap = el.firstElementChild, hit = wrap.querySelector(".wthit"), g = wrap.querySelector(".wthover");
  const tip = wrap.querySelector(".wttip"), line = g.querySelector("line"), dots = g.querySelectorAll("circle");
  const move = (clientX) => {
    const box = hit.getBoundingClientRect(), ms = t0 + ((clientX - box.left) / box.width) * (t1 - t0);
    let k = 0;
    for (let i = 1; i < t.length; i++) if (Math.abs(t[i] - ms) < Math.abs(t[k] - ms)) k = i;
    const px = x(t[k]);
    g.style.display = ""; line.setAttribute("x1", px); line.setAttribute("x2", px);
    series.forEach((s, i) => {
      const v = s.values[k];
      dots[i].style.display = v == null ? "none" : "";
      if (v != null) { dots[i].setAttribute("cx", px); dots[i].setAttribute("cy", y(v)); }
    });
    const rowsHtml = series.map((s) => ({ s, v: s.values[k] })).filter((o) => o.v != null)
      .sort((a, b) => b.v - a.v).map(({ s, v }) =>
        `<div class="wttip-r"><i style="background:${s.muted ? C.muted : s.color}"></i><span>${esc(s.name)}</span><b>${tipFmt(v)}</b></div>`).join("");
    tip.innerHTML = `<div class="wttip-d">${k === 0 && t.length > 1 && !opts.exactStart ? "Start · " : ""}${wtDate(t[k], true)}</div>${rowsHtml}`;
    tip.classList.remove("hidden");
    const tw = tip.offsetWidth, left = px + 14 + tw > W ? px - 14 - tw : px + 14;
    tip.style.left = Math.max(0, left) + "px"; tip.style.top = padT + "px";
  };
  const leave = () => { g.style.display = "none"; tip.classList.add("hidden"); };
  hit.addEventListener("mousemove", (e) => move(e.clientX));
  hit.addEventListener("mouseleave", leave);
  hit.addEventListener("touchstart", (e) => move(e.touches[0].clientX), { passive: true });
  hit.addEventListener("touchmove", (e) => move(e.touches[0].clientX), { passive: true });
  hit.addEventListener("touchend", leave);
}

const WT_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function wtDate(ms, full) {
  const d = new Date(ms);
  return `${WT_MON[d.getUTCMonth()]} ${d.getUTCDate()}${full ? ", " + d.getUTCFullYear() : ""}`;
}
// Calendar ticks for a time axis: years, quarters, months, weeks or days —
// whichever unit gives at most `maxN` labels.
function wtTimeTicks(t0, t1, maxN) {
  const span = (t1 - t0) / DAY_MS, out = [];
  const d0 = new Date(t0);
  if (span > 30) {
    const monthsPer = [1, 3, 6, 12].find((m) => span / 30.4 / m <= maxN) || 12;
    let y = d0.getUTCFullYear(), m = d0.getUTCMonth() + 1;
    for (;;) {
      if (m > 11) { y++; m -= 12; }
      const ms = Date.UTC(y, m, 1);
      if (ms > t1) break;
      if (m % monthsPer === 0)
        out.push([ms, monthsPer === 12 || (m === 0 && monthsPer >= 3) ? String(y) : m === 0 ? `${WT_MON[m]} '${String(y).slice(2)}` : WT_MON[m]]);
      m++;
    }
  } else {
    const daysPer = [1, 2, 7, 14].find((k) => span / k <= maxN) || 14;
    for (let ms = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate() + 1); ms <= t1; ms += DAY_MS) {
      const dd = new Date(ms);
      if (daysPer >= 7 ? dd.getUTCDay() === 1 && (daysPer === 7 || Math.round((ms - t0) / DAY_MS / 7) % 2 === 0)
          : Math.round((ms - t0) / DAY_MS) % daysPer === 0) out.push([ms, wtDate(ms)]);
    }
  }
  return out.filter(([ms]) => ms > t0 + (t1 - t0) * 0.03 && ms < t1 - (t1 - t0) * 0.03);
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
  { id: "mag7", label: "Magnificent 7", note: "Apple, Microsoft, Alphabet (both share classes), Amazon, Nvidia, Meta, Tesla", list: "AAPL MSFT GOOGL GOOG AMZN NVDA META TSLA" },
  { id: "ai", label: "AI trade", note: "Our pick, not an official list: AI chips, the cloud builders, AI software and networking, and the power and cooling behind data centres", list: "NVDA AVGO AMD MU MRVL SMCI MSFT GOOGL GOOG META AMZN ORCL PLTR ANET DELL VRT CEG VST" },
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
    const frame = wtFrame(over), paths = wtSectorPaths(frame);
    const colored = secs.slice(0, SERIES.length);   // the three biggest sectors today
    const series = secs.filter((s) => paths[s]).map((s) => ({
      name: s, values: paths[s], color: SERIES[colored.indexOf(s)], muted: !colored.includes(s),
    }));
    $("wtSectors").innerHTML = `<div id="wtSecChart"></div>` +
      `<p class="sub2">Each sector's share of the index over time, rebuilt from its names' prices${frame.rich ? "" : " at each lookback (price history still loading)"}. Hover the chart to read every sector on one date.</p>`;
    wtTimeChart($("wtSecChart"), frame.t, series, {
      fmt: (v) => +(v * 100).toFixed(1) + "%", labFmt: (v) => (v * 100).toFixed(1) + "%",
      tipFmt: (v) => (v * 100).toFixed(2) + "%", lo: 0, height: 380,
    });
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

  const series = [], rowsHtml = [], frame = wtFrame(over);
  set.forEach((x) => {
    const b = basketPath(over, x.scheme, x.tickers, frame);
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
        ? (wtSameAsBasket([...x.tickers]) ? '<span class="na">Is your basket</span>' : `<button class="ghost small" data-use="${x.key}">Use<span class="wtlong"> as my basket</span></button>`)
        : ""}</td></tr>`);
  });
  const spy = spyPath(over, frame);
  if (spy) series.push({ name: "SPY", values: spy, color: C.muted, muted: true });
  rowsHtml.push(`<tr class="spyrow"><td><i class="wtdot" style="background:${C.muted}"></i><b>SPY</b><div class="na wtsmall">S&amp;P 500 ETF (the benchmark)</div></td>` +
    `<td class="num">100%</td><td class="num">${pct(bench[over])}</td><td class="num"><span class="na">—</span></td><td></td></tr>`);

  $("wtCompare").innerHTML = `<div id="wtCmpChart"></div>` +
    `<p class="sub2">What $100 put into each basket ${over} ago would be worth, held to today${frame.rich ? "" : " (lookback points only while the price history loads)"}. Hover the chart to compare them on any date.</p>` +
    `<div class="tablewrap"><table class="wtcmp wtcmp-sum"><thead><tr><th>Basket</th><th class="num">Share of index</th>` +
    `<th class="num">${over} return</th><th class="num">vs SPY</th><th></th></tr></thead><tbody>${rowsHtml.join("")}</tbody></table></div>`;
  wtTimeChart($("wtCmpChart"), frame.t, series, {
    fmt: (v) => "$" + +v.toFixed(1), labFmt: (v) => "$" + Math.round(v),
    tipFmt: (v) => `$${v.toFixed(2)} <span class="${v >= 100 ? "ret-up" : "ret-down"}">${v >= 100 ? "+" : "−"}${Math.abs(v - 100).toFixed(1)}%</span>`,
    base: 100, height: 360,
  });
  $("wtCompare").querySelectorAll("[data-use]").forEach((b) =>
    (b.onclick = () => setBasket(wtBasketTickers(wtBasketById(b.dataset.use)))));
}

// ---------------- How would SPY do? ----------------
// Start from the whole index (every name, cap-weighted, bought at the start of
// the range and held — which is how SPY behaves between rebalances), take names
// out, and compare. Runs on the price history, over any range inside it.
// A name's contribution = its weight at the start × its return; they sum to
// the index return, so "what you took out" splits the gain exactly.
const SPY_RANGES = ["1M", "3M", "6M", "YTD", "1Y", "2Y", "3Y", "5Y"];
// Date boxes being edited. Tracked with focus/blur on the box itself, because
// Chrome fires `change` while it moves between the month/day/year fields, when
// document.activeElement briefly isn't the box.
const SPY_EDITING = new Set();
const spyIso = (ms) => new Date(ms).toISOString().slice(0, 10);

function spyIdxRange() {
  const H = State.hist, n = H.t.length, last = H.t[n - 1];
  const onOrBefore = (ms) => { let k = 0; for (let i = 0; i < n; i++) if (H.t[i] <= ms) k = i; return k; };
  const R = State.spyRange;
  let s, e = n - 1;
  if (R.from) {
    s = onOrBefore(Date.parse(R.from + "T00:00:00Z"));
    e = Math.min(n - 1, Math.max(s + 1, onOrBefore(Date.parse((R.to || spyIso(last)) + "T00:00:00Z"))));
  } else if (R.k === "YTD") {
    s = onOrBefore(Date.UTC(new Date(last).getUTCFullYear(), 0, 1) - 1);
  } else {
    s = onOrBefore(last - winDays(R.k || "1Y") * DAY_MS);
  }
  return { s: Math.min(s, n - 2), e };
}

function spyModel() {
  const H = State.hist, { s, e } = spyIdxRange(), len = e - s + 1;
  const all = new Array(len).fill(0), out = new Array(len).fill(0), names = [];
  weightUniverse().capped.forEach((r) => {
    const a = H.s[r.ticker];
    if (!a || a[s] == null) return;          // not trading yet at the start
    const v = a.slice(s, e + 1).map((x) => (x == null ? 0 : r.market_cap * x));
    const isOut = State.spyOut.has(r.ticker);
    for (let i = 0; i < len; i++) { all[i] += v[i]; if (isOut) out[i] += v[i]; }
    names.push({ r, v0: v[0], v1: v[len - 1], out: isOut });
  });
  const kept = all.map((v, i) => v - out[i]);
  const lvl = (arr) => (arr[0] > 0 ? arr.map((x) => (100 * x) / arr[0]) : null);
  names.forEach((o) => {
    o.w0 = o.v0 / all[0]; o.w1 = o.v1 / all[len - 1];
    o.ret = o.v1 / o.v0 - 1; o.contrib = o.w0 * o.ret;
  });
  const spyA = H.s.SPY && H.s.SPY[s] != null ? H.s.SPY.slice(s, e + 1) : null;
  return {
    t: H.t.slice(s, e + 1), names, weekly: H.t[s + 1] - H.t[s] > 3 * DAY_MS,
    all: lvl(all), kept: lvl(kept), out: lvl(out),
    wOut0: out[0] / all[0], wOut1: out[len - 1] / all[len - 1],
    nOut: names.filter((o) => o.out).length,
    // Companies, not share classes (Alphabet's GOOGL + GOOG are one company).
    nCos: new Set(names.filter((o) => o.out).map((o) => (o.r.name || o.r.ticker).replace(/\s*\(Class [A-Z]\)\s*$/i, ""))).size,
    spy: spyA ? spyA.map((x) => (100 * x) / spyA[0]) : null,
  };
}

function spyToggle(tickers, forceOut) {
  const allOut = tickers.every((t) => State.spyOut.has(t));
  const takeOut = forceOut != null ? forceOut : !allOut;
  tickers.forEach((t) => (takeOut ? State.spyOut.add(t) : State.spyOut.delete(t)));
  saveFilters(); renderSpyWhatIf();
}

function renderSpyWhatIf() {
  if (!State.base) return;
  if (!State.hist) {
    $("spyBody").classList.add("hidden");
    $("spyLoading").classList.remove("hidden");
    return;
  }
  $("spyBody").classList.remove("hidden");
  $("spyLoading").classList.add("hidden");
  const H = State.hist, rows = State.base.rows;

  // Range controls.
  const cur = State.spyRange.from ? null : State.spyRange.k || "1Y";
  wtSegs("spyRangeChips", cur, SPY_RANGES.map((k) => [k, k]));
  const { s, e } = spyIdxRange();
  const fromEl = $("spyFrom"), toEl = $("spyTo");
  // Only touch min/max when they change: rewriting them resets a date box
  // mid-typing in Chrome (it drops focus).
  const lo = spyIso(H.t[0]), hi = spyIso(H.t[H.t.length - 1]);
  [fromEl, toEl].forEach((el) => {
    if (el.min !== lo) el.min = lo;
    if (el.max !== hi) el.max = hi;
  });
  // Never rewrite a date box the visitor is typing in.
  if (!SPY_EDITING.has("spyFrom")) fromEl.value = spyIso(H.t[s]);
  if (!SPY_EDITING.has("spyTo")) toEl.value = spyIso(H.t[e]);

  // Take-out controls: themes, sectors, and what's out now.
  const chipState = (tk) => {
    const k = tk.filter((t) => State.spyOut.has(t)).length;
    return k === 0 ? "" : k === tk.length ? " on" : " some";
  };
  const groups = WT_BASKETS.filter((b) => b.list);
  $("spyGroups").innerHTML = groups.map((b) => {
    const tk = wtBasketTickers(b);
    return `<button class="wtchip${chipState(tk)}" data-g="${b.id}" title="${esc(b.note || tk.join(", "))}">${esc(b.label)} <span class="wtchip-n">${tk.length}</span></button>`;
  }).join("");
  $("spyGroups").querySelectorAll("[data-g]").forEach((b) =>
    (b.onclick = () => spyToggle(wtBasketTickers(wtBasketById(b.dataset.g)))));
  const bySec = {};
  rows.forEach((r) => (bySec[r.sector || "Unknown"] ||= []).push(r.ticker));
  const secMc = (k) => rows.filter((r) => (r.sector || "Unknown") === k).reduce((a, r) => a + (r.market_cap || 0), 0);
  $("spySecs").innerHTML = Object.keys(bySec).sort((a, b) => secMc(b) - secMc(a)).map((k) =>
    `<button class="wtchip sm${chipState(bySec[k])}" data-sec="${esc(k)}">${esc(k)}</button>`).join("");
  $("spySecs").querySelectorAll("[data-sec]").forEach((b) => (b.onclick = () => spyToggle(bySec[b.dataset.sec])));
  const outRows = wtByWeight().filter((r) => State.spyOut.has(r.ticker)), SHOW = 24;
  $("spyOutChips").innerHTML = outRows.length
    ? outRows.slice(0, SHOW).map((r) => `<button class="wtchip on sm" data-back="${r.ticker}" title="Put ${r.ticker} back">${r.ticker} <span class="x">×</span></button>`).join("") +
      (outRows.length > SHOW ? `<span class="na">+${outRows.length - SHOW} more</span>` : "") +
      `<button class="wtchip clear sm" data-back="*">Put everything back</button>`
    : `<span class="na">Nothing yet. This is the whole index. Pick a theme or sector above, or take out single names from the list below.</span>`;
  $("spyOutChips").querySelectorAll("[data-back]").forEach((b) => (b.onclick = () => {
    if (b.dataset.back === "*") { State.spyOut.clear(); saveFilters(); renderSpyWhatIf(); }
    else spyToggle([b.dataset.back], false);
  }));

  const M = spyModel(), last = (a) => a[a.length - 1];
  const R = last(M.all) / 100 - 1, has = M.nOut > 0 && M.kept;
  const Rk = has ? last(M.kept) / 100 - 1 : null, Ro = has && M.out ? last(M.out) / 100 - 1 : null;
  const cOut = has && Ro != null ? M.wOut0 * Ro : null;
  const d0 = wtDate(M.t[0], true), d1 = wtDate(last(M.t), true);
  const money = (v) => "$" + Math.round(v);
  const tile = (k, v, sub, cls = "") => `<div class="spytile ${cls}"><div class="tk-k">${k}</div><div class="tk-v">${v}</div><div class="spytile-s">${sub}</div></div>`;
  let verdict = "";
  if (has && cOut != null) {
    // Whole dollars unless that would make two different values read the same.
    const [mK, mA] = [last(M.kept), last(M.all)];
    const cash = Math.round(mK) === Math.round(mA) ? (v) => "$" + v.toFixed(2) : money;
    const who = M.nCos === M.nOut ? `${M.nOut} name${M.nOut === 1 ? "" : "s"}`
      : `${M.nCos} compan${M.nCos === 1 ? "y" : "ies"} (${M.nOut} share lines)`;
    const share = R > 0.005 ? ` That is <b>${Math.round((cOut / R) * 100)}%</b> of the index's gain.` : "";
    verdict = `The ${who} you took out were <b>${wpct(M.wOut0, 1)}</b> of the S&amp;P 500 on ${d0} and <b>${wpct(M.wOut1, 1)}</b> by ${d1}. ` +
      `They returned <b>${pct(Ro)}</b> and ${cOut >= 0 ? "added" : "took"} <b>${Math.abs(cOut * 100).toFixed(1)} points</b> ${cOut >= 0 ? "to" : "off"} the index's ${pct(R)}.${share} ` +
      `Without them, $100 would have become <b>${cash(mK)}</b> instead of <b>${cash(mA)}</b>.`;
  }
  $("spyStats").innerHTML =
    tile("S&amp;P 500 (all names)", pct(R), `$100 → ${money(last(M.all))}`, "a") +
    tile("Without what you took out", has ? pct(Rk) : '<span class="na">—</span>',
         has ? `$100 → ${money(last(M.kept))} · <span class="${Rk - R >= 0 ? "ret-up" : "ret-down"}">${Rk - R >= 0 ? "+" : "−"}${Math.abs((Rk - R) * 100).toFixed(1)} pts</span>` : "Take something out to compare", "b") +
    tile("What you took out", has && Ro != null ? pct(Ro) : '<span class="na">—</span>',
         has ? `${M.nOut} names · ${wpct(M.wOut0, 1)} → ${wpct(M.wOut1, 1)} of the index` : "—", "c") +
    (verdict ? `<p class="spyverdict">${verdict}</p>` : "");

  const series = [{ name: "S&P 500 (all names)", values: M.all, color: WT_SERIES[0] }];
  if (has) series.push({ name: "Without your picks", values: M.kept, color: WT_SERIES[1] });
  if (has && State.spyAlone && M.out) series.push({ name: "Your picks alone", values: M.out, color: WT_SERIES[2] });
  if (M.spy) series.push({ name: "SPY (the fund)", values: M.spy, color: C.muted, muted: true });
  if (M.t.length < 4)
    $("spyStats").insertAdjacentHTML("beforeend", `<p class="spyverdict spywarn">This range only has ${M.t.length} closing prices (${d0} to ${d1}), so each line is just a straight join between them. Pick a week or more to see a trend.</p>`);
  $("spyNote").innerHTML = `${d0} to ${d1}${M.weekly ? " · weekly closes before the last ~3 months" : ""}. ` +
    `The S&amp;P 500 line is rebuilt from today's members at full market cap, so it runs close to, not exactly on, the SPY fund.`;
  $("spyAloneWrap").classList.toggle("hidden", !has);
  $("spyAlone").checked = State.spyAlone;
  wtTimeChart($("spyChart"), M.t, series, {
    fmt: (v) => "$" + +v.toFixed(1), labFmt: money,
    tipFmt: (v) => `$${v.toFixed(2)} <span class="${v >= 100 ? "ret-up" : "ret-down"}">${v >= 100 ? "+" : "−"}${Math.abs(v - 100).toFixed(1)}%</span>`,
    base: 100, height: 360,
  });
  State.spyLast = M;
  renderSpyList();
}

// Who drove the index: every name ranked by contribution, or search results.
function renderSpyList() {
  const M = State.spyLast;
  if (!M) return;
  const q = ($("spySearch").value || "").trim().toLowerCase();
  const ranked = [...M.names].sort((a, b) => b.contrib - a.contrib);
  const rankOf = new Map(ranked.map((o, i) => [o.r.ticker, i + 1]));
  let list, note;
  if (q) {
    list = ranked.filter((o) => o.r.ticker.toLowerCase().startsWith(q) || (o.r.name || "").toLowerCase().includes(q)).slice(0, 25);
    note = list.length ? "" : `<p class="na">No name matches “${esc(q)}”, or it wasn't trading at the start of the range.</p>`;
  } else {
    list = [...ranked.slice(0, 12), ...ranked.slice(-3).reverse()];
    note = `<p class="sub2">The 12 names that added the most, then the 3 biggest drags. Search to find any other name.</p>`;
  }
  const maxC = Math.max(1e-9, ...list.map((o) => Math.abs(o.contrib)));
  const row = (o, i) => {
    const w = (Math.abs(o.contrib) / maxC) * 50;
    const bar = `<span class="spybar"><span class="spybar-f ${o.contrib >= 0 ? "pos" : "neg"}" style="${o.contrib >= 0 ? "left:50%" : `left:${50 - w}%`};width:${w}%"></span></span>`;
    const sep = !q && i === 12 ? `<tr class="spysep"><td colspan="7">Biggest drags</td></tr>` : "";
    return sep + `<tr class="${o.out ? "isout" : ""}">` +
      `<td class="num na">#${rankOf.get(o.r.ticker)}</td>` +
      `<td><b class="tk">${o.r.ticker}</b> <span class="spynm">${esc(o.r.name)}</span></td>` +
      `<td class="num">${wpct(o.w0)}</td><td class="num">${pct(o.ret)}</td>` +
      `<td class="spybarcell">${bar}</td>` +
      `<td class="num"><b class="${o.contrib >= 0 ? "ret-up" : "ret-down"}">${o.contrib >= 0 ? "+" : "−"}${Math.abs(o.contrib * 100).toFixed(2)}</b></td>` +
      `<td class="num"><button class="ghost small" data-tog="${o.r.ticker}">${o.out ? "Put back" : "Take out"}</button></td></tr>`;
  };
  $("spyList").innerHTML = list.length
    ? `<div class="tablewrap"><table class="wtcmp spylist"><thead><tr><th class="num">Rank</th><th>Name</th>` +
      `<th class="num">Weight at start</th><th class="num">Return</th><th></th><th class="num">Added (pts)</th><th></th></tr></thead>` +
      `<tbody>${list.map(row).join("")}</tbody></table></div>` + note
    : note;
  $("spyList").querySelectorAll("[data-tog]").forEach((b) =>
    (b.onclick = () => spyToggle([b.dataset.tog])));
}

function renderWeights() {
  if (!State.base) return;
  wtEnsureHistory();
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
  renderSpyWhatIf();
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
  let wtResizeT, wtLastW = window.innerWidth;
  window.addEventListener("resize", () => {
    if (!$("colpop").classList.contains("hidden")) closeColPop();
    // Weights charts are drawn at pixel width; redraw when the width changes.
    if (State.active === "weights" && window.innerWidth !== wtLastW) {
      wtLastW = window.innerWidth;
      clearTimeout(wtResizeT);
      wtResizeT = setTimeout(renderWeights, 150);
    }
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
  $("spyRangeChips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    State.spyRange = { k: b.dataset.v }; saveFilters(); renderSpyWhatIf();
  });
  // Typing a date fires `change` on every segment, so half-typed years like
  // 0002 or 0202 arrive as valid dates. Only act on a date inside the history;
  // anything else waits, and leaving the box snaps it back to the current range.
  const spyDateOk = (el) => el.value && el.value >= el.min && el.value <= el.max;
  ["spyFrom", "spyTo"].forEach((id) => {
    $(id).addEventListener("change", () => {
      if (!spyDateOk($("spyFrom")) || !spyDateOk($("spyTo"))) return;
      let [a, b] = [$("spyFrom").value, $("spyTo").value];
      if (a > b) [a, b] = [b, a];
      State.spyRange = { from: a, to: b }; saveFilters(); renderSpyWhatIf();
    });
    $(id).addEventListener("focus", () => SPY_EDITING.add(id));
    $(id).addEventListener("blur", () => { SPY_EDITING.delete(id); setTimeout(renderSpyWhatIf, 0); });
  });
  $("spyAlone").addEventListener("change", () => {
    State.spyAlone = $("spyAlone").checked; saveFilters(); renderSpyWhatIf();
  });
  let spySearchT;
  $("spySearch").addEventListener("input", () => {
    clearTimeout(spySearchT); spySearchT = setTimeout(renderSpyList, 120);
  });
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
