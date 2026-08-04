// Signal Sift SPA. Fetches the full universe ONCE, caches it in localStorage,
// and does all filtering / sorting / sector math client-side so clicking a stock
// never drops your place or re-pulls data. Shares chart helpers (buildProfileHTML,
// esc, cls, num, money…) with company.js, which loads first.
const $ = (id) => document.getElementById(id);
let WINDOWS = ["1D", "1W", "1M", "3M", "6M", "9M", "1Y", "2Y", "3Y", "4Y", "5Y"];

// Bump when the cached payload shape changes; stale local caches self-purge.
// Keep in step with the server schema stamps in company.py / fundamentals.py.
const APP_SCHEMA = "5";
function purgeStaleCaches() {
  if (localStorage.getItem("ss-schema") === APP_SCHEMA) return;
  ["ss-base"].concat(
    Object.keys(localStorage).filter((k) => k.startsWith("ss-co-"))
  ).forEach((k) => localStorage.removeItem(k));   // drop data; keep filters + theme
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
const DEFAULT_FILTERS = {
  status: "all", over: "1Y", sort: "", direction: "desc",
  sector: "", ceiling: "0.05", search: "",
};
const State = {
  base: null,                 // { rows, meta, ts }
  filters: { ...DEFAULT_FILTERS },
  secOver: "1Y",
  wlOver: "1Y",
  wtOver: "1Y",               // Weights view: return window for basket-vs-SPY
  wtScheme: "cap",            // Weights view: 'cap' | 'equal'
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
  localStorage.setItem("ss-filters", JSON.stringify(State.filters));
  localStorage.setItem("ss-secover", State.secOver);
  localStorage.setItem("ss-wlover", State.wlOver);
  localStorage.setItem("ss-wtover", State.wtOver);
  localStorage.setItem("ss-wtscheme", State.wtScheme);
}
function loadFilters() {
  try {
    Object.assign(State.filters, JSON.parse(localStorage.getItem("ss-filters")) || {});
    State.secOver = localStorage.getItem("ss-secover") || "1Y";
    State.wlOver = localStorage.getItem("ss-wlover") || "1Y";
    State.wtOver = localStorage.getItem("ss-wtover") || "1Y";
    State.wtScheme = localStorage.getItem("ss-wtscheme") || "cap";
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

// ---------------- Client-side classification ----------------
const SPY_LINE = "spy";
const isSpyLine = () => State.filters.ceiling === SPY_LINE;

// The bar a window has to clear to count as "up". Either a flat percentage, or
// — on the benchmark line — SPY's own return over that same window, so the bar
// moves per column instead of being one constant across all eleven. A flat 0%
// is a near-meaningless test at 5Y, where SPY itself is up ~85%.
function lineFor(w) {
  if (!isSpyLine()) return parseFloat(State.filters.ceiling) || 0;
  const b = (State.base && State.base.meta && State.base.meta.benchmark_returns) || {};
  return b[w] == null ? null : b[w];
}

// true = up, false = down, null = unjudgeable (no price history that far back,
// or no benchmark for this window). Callers must treat null as "not up" AND
// "not down" — it must not fall into either bucket by default.
function judge(row, w) {
  const v = row.returns[w], line = lineFor(w);
  return v == null || line == null ? null : v > line;
}

// How the current line reads in prose, for the summary lines.
function lineLabel(w) {
  if (!isSpyLine()) return `up = above ${(parseFloat(State.filters.ceiling) * 100).toFixed(0)}%`;
  const l = lineFor(w);
  return l == null ? "up = beat SPY, but SPY has no return for this window"
                   : `up = beat SPY over ${w}, i.e. above ${(l * 100).toFixed(1)}%`;
}

function stallInfo(row) {
  const stalled = WINDOWS.filter((w) => judge(row, w) === false);
  return { stalled, score: stalled.length };
}
function isGrowing(row, over) { return judge(row, over) === true; }

function decorate(r, over) {
  const si = stallInfo(r);
  return { ...r, _stalled: si.stalled, _score: si.score,
           _growing: isGrowing(r, over) };
}

function computeRows() {
  const f = State.filters, over = f.over;
  const q = (f.search || "").trim().toLowerCase();
  let rows = State.base.rows.filter((r) => {
    if (f.sector && r.sector !== f.sector) return false;
    if (q && !(r.ticker.toLowerCase().includes(q) ||
               (r.name || "").toLowerCase().includes(q))) return false;
    const v = judge(r, over);
    if (f.status === "growing" && v !== true) return false;
    if (f.status === "stalled" && v !== false) return false;
    return true;
  }).map((r) => decorate(r, over));

  const sort = f.sort || over;
  rows.sort((a, b) => {
    const av = sort === "stall" ? a._score : (a.returns[sort] ?? -Infinity);
    const bv = sort === "stall" ? b._score : (b.returns[sort] ?? -Infinity);
    return f.direction === "asc" ? av - bv : bv - av;
  });
  return rows;
}

// ---------------- Shared table builders (stocks + watchlist) ----------------
function headHTML(over) {
  const fixed = ["Ticker", "Company", "Sector", "Price"];
  return `<th class="star-h"></th>` +
    fixed.map((h, i) => `<th${i >= 3 ? ' class="num"' : ""}>${h}</th>`).join("") +
    WINDOWS.map((w) => `<th class="num${w === over ? " refcol" : ""}">${w}</th>`).join("") +
    `<th class="num">Verdict</th>` +
    `<th class="num" title="How many of the ${WINDOWS.length} windows are below the line">Down</th>`;
}

function makeRow(r, over) {
  const tr = document.createElement("tr");
  tr.dataset.tk = r.ticker;
  const sc = r._score;
  const badge = sc >= WINDOWS.length ? "s5" : sc >= WINDOWS.length - 1 ? "s4" : "";
  const scTip = `Down over ${sc} of the ${WINDOWS.length} windows`;
  // The window is baked into the pill on purpose: "Down" alone reads like a
  // property of the stock, when it's only ever a verdict about one window.
  const stat = r._growing ? `<span class="pill grow">▲ Up ${over}</span>`
                          : `<span class="pill stall">▼ Down ${over}</span>`;
  const on = isWatched(r.ticker);
  tr.innerHTML =
    `<td class="starcell"><span class="star ${on ? "on" : "off"}" title="Watchlist">${on ? "★" : "☆"}</span></td>` +
    `<td class="tk">${r.ticker}</td><td>${esc(r.name)}</td><td>${esc(r.sector || "")}</td>` +
    `<td class="num">$${Number(r.price).toFixed(2)}</td>` +
    WINDOWS.map((w) => `<td class="num${w === over ? " refcol" : ""}">${pct(r.returns[w])}</td>`).join("") +
    `<td class="num">${stat}</td>` +
    `<td class="num"><span class="badge ${badge}" title="${scTip}">${sc}</span></td>`;
  tr.onclick = () => openDetail(r.ticker);
  tr.querySelector(".star").onclick = (e) => { e.stopPropagation(); toggleWatch(r.ticker); };
  return tr;
}

// ---------------- Stocks view ----------------
function renderStocks() {
  if (!State.base) return;
  const f = State.filters, over = f.over;
  $("headRow").innerHTML = headHTML(over);

  // Populate sector dropdown once.
  const sel = $("sector");
  if (sel.options.length <= 1 && State.base.meta.sectors) {
    State.base.meta.sectors.forEach((s) => sel.add(new Option(s, s)));
    sel.value = f.sector;
  }

  const rows = computeRows();
  const scope = State.base.rows.filter((r) => !f.sector || r.sector === f.sector);
  const grow = scope.filter((r) => judge(r, over) === true).length;
  const stall = scope.filter((r) => judge(r, over) === false).length;

  $("status-line").innerHTML =
    `Showing <b>${rows.length}</b> of ${scope.length} · measured over <b>${over}</b>: ` +
    `<span class="ret-up">${grow} up</span> · <span class="ret-down">${stall} down</span> ` +
    `(${lineLabel(over)}).`;

  const tb = $("rows");
  tb.innerHTML = "";
  State.cursor = -1;
  const frag = document.createDocumentFragment();
  rows.forEach((r) => frag.appendChild(makeRow(r, over)));
  tb.appendChild(frag);
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
  const over = State.wlOver;
  $("wlHead").innerHTML = headHTML(over);
  const tickers = [...State.watchlist];
  const empty = tickers.length === 0;
  $("wlEmpty").classList.toggle("hidden", !empty);
  $("wlGrid").classList.toggle("hidden", empty);

  if (empty || !State.base) { $("wl-status").textContent = ""; $("wlRows").innerHTML = ""; return; }

  const rows = State.base.rows
    .filter((r) => State.watchlist.has(r.ticker))
    .map((r) => decorate(r, over))
    .sort((a, b) => (b.returns[over] ?? -Infinity) - (a.returns[over] ?? -Infinity));

  const grow = rows.filter((r) => judge(r, over) === true).length;
  const down = rows.filter((r) => judge(r, over) === false).length;
  $("wl-status").innerHTML =
    `<b>${rows.length}</b> watched · measured over <b>${over}</b>: ` +
    `<span class="ret-up">${grow} up</span> · <span class="ret-down">${down} down</span> ` +
    `(${lineLabel(over)}).`;

  const tb = $("wlRows");
  tb.innerHTML = "";
  State.cursor = -1;
  const frag = document.createDocumentFragment();
  rows.forEach((r) => frag.appendChild(makeRow(r, over)));
  tb.appendChild(frag);
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

  // Wire clicks -> filter stocks tab by sector.
  const go = (secName) => {
    State.filters.sector = secName;
    State.filters.status = "all";
    $("sector").value = secName;
    saveFilters();
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
function wpct(frac, d = 2) { return frac == null ? "—" : (frac * 100).toFixed(d) + "%"; }

function weightUniverse() {
  const rows = (State.base && State.base.rows) || [];
  const capped = rows.filter((r) => r.market_cap != null && r.market_cap > 0);
  const total = capped.reduce((a, r) => a + r.market_cap, 0);
  return { rows, capped, total };
}

// Weighted trailing return of the current basket over one window (or null).
// Cap-weighted normalizes market caps within the basket; equal weights 1/N.
function basketReturn(over, scheme) {
  const rows = State.base.rows.filter((r) => State.basket.has(r.ticker) && r.returns[over] != null);
  if (!rows.length) return null;
  const capd = rows.filter((r) => r.market_cap != null && r.market_cap > 0);
  if (scheme === "cap" && capd.length) {
    const tot = capd.reduce((a, r) => a + r.market_cap, 0);
    return capd.reduce((a, r) => a + (r.market_cap / tot) * r.returns[over], 0);
  }
  return rows.reduce((a, r) => a + r.returns[over], 0) / rows.length;   // equal (or cap fallback)
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

function coverageVerdict(n, tot, diff, over) {
  if (diff == null) return "";
  const word = Math.abs(diff) < 0.01 ? "tracked SPY almost exactly"
             : diff > 0 ? "beat SPY" : "trailed SPY";
  return `These ${n} names (${wpct(n / tot, 0)} of the index by count) ${word} over ${over}.`;
}

function renderWtSectors(over) {
  const { rows, capped, total } = weightUniverse();
  const mc = {}, cnt = {}, inb = {};
  capped.forEach((r) => { const s = r.sector || "Unknown"; mc[s] = (mc[s] || 0) + r.market_cap; });
  rows.forEach((r) => {
    const s = r.sector || "Unknown";
    cnt[s] = (cnt[s] || 0) + 1;
    if (State.basket.has(r.ticker)) inb[s] = (inb[s] || 0) + 1;
  });
  const secs = Object.entries(mc).map(([s, v]) => ({ sector: s, w: total ? v / total : 0 }))
    .sort((a, b) => b.w - a.w);
  const maxW = Math.max(0.01, ...secs.map((s) => s.w));
  $("wtSectors").innerHTML = secs.map((s) => {
    const inCount = inb[s.sector] || 0, tot = cnt[s.sector] || 0;
    const full = inCount > 0 && inCount === tot, some = inCount > 0 && !full;
    return `<div class="wtsec ${full ? "full" : some ? "some" : ""}" data-sector="${esc(s.sector)}">
      <div class="wtsec-name">${esc(s.sector)} <span class="na">(${inCount}/${tot})</span></div>
      <div class="wtsec-bar"><span class="wtsec-fill" style="width:${(s.w / maxW) * 100}%"></span></div>
      <div class="wtsec-w">${wpct(s.w)}</div></div>`;
  }).join("");
  $("wtSectors").querySelectorAll(".wtsec").forEach((el) =>
    (el.onclick = () => toggleSectorBasket(el.dataset.sector)));
}

function renderWtNames(over) {
  const { capped, total } = weightUniverse();
  const q = ($("wtSearch").value || "").trim().toLowerCase();
  $("wtHead").innerHTML =
    `<th class="star-h"></th><th>Ticker</th><th>Company</th><th>Sector</th>` +
    `<th class="num">Weight</th><th class="num">Price</th><th class="num">${over}</th>`;
  let rows = [...capped].sort((a, b) => b.market_cap - a.market_cap);
  rows = q
    ? rows.filter((r) => r.ticker.toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q))
    : rows.slice(0, 100);
  const tb = $("wtRows");
  tb.innerHTML = "";
  const frag = document.createDocumentFragment();
  rows.forEach((r) => {
    const on = State.basket.has(r.ticker);
    const tr = document.createElement("tr");
    tr.dataset.tk = r.ticker;
    if (on) tr.classList.add("inbasket");
    tr.innerHTML =
      `<td class="starcell"><span class="bchk ${on ? "on" : "off"}">${on ? "✓" : "+"}</span></td>` +
      `<td class="tk">${r.ticker}</td><td>${esc(r.name)}</td><td>${esc(r.sector || "")}</td>` +
      `<td class="num">${wpct(total ? r.market_cap / total : 0)}</td>` +
      `<td class="num">$${Number(r.price).toFixed(2)}</td>` +
      `<td class="num">${pct(r.returns[over])}</td>`;
    tr.onclick = () => toggleBasket(r.ticker);
    frag.appendChild(tr);
  });
  tb.appendChild(frag);
}

function renderWeights() {
  if (!State.base) return;
  const over = State.wtOver, scheme = State.wtScheme;
  const { rows, capped, total } = weightUniverse();

  const hasData = capped.length > 0;
  $("wtEmpty").classList.toggle("hidden", hasData);
  $("wtBody").classList.toggle("hidden", !hasData);
  if (!hasData) { $("wtStatus").textContent = ""; return; }

  // Index totals + concentration.
  const byW = [...capped].sort((a, b) => b.market_cap - a.market_cap);
  const share = (n) => byW.slice(0, n).reduce((a, r) => a + r.market_cap, 0) / total;
  $("wtStatus").innerHTML =
    `Index ≈ <b>${money(total)}</b> across ${capped.length} weighted names · ` +
    `top 10 = <b>${wpct(share(10))}</b> · top 50 = <b>${wpct(share(50))}</b> of the S&P 500. ` +
    `<span class="na">Approx. weights (full market cap, not float-adjusted).</span>`;

  // Basket vs SPY across all windows.
  const nBasket = rows.filter((r) => State.basket.has(r.ticker)).length;
  const basketMc = capped.filter((r) => State.basket.has(r.ticker)).reduce((a, r) => a + r.market_cap, 0);
  const bench = State.base.meta.benchmark_returns || {};
  if (nBasket) {
    const body = WINDOWS.map((w) => {
      const br = basketReturn(w, scheme), sr = bench[w];
      const diff = br != null && sr != null ? br - sr : null;
      return `<tr><td class="wcw">${w}</td><td class="num">${pct(br)}</td>` +
             `<td class="num">${pct(sr)}</td><td class="num">${diff == null ? '<span class="na">—</span>' : pct(diff)}</td></tr>`;
    }).join("");
    $("wtCompare").innerHTML =
      `<table class="wtcmp"><thead><tr><th>Window</th><th class="num">Basket</th>` +
      `<th class="num">SPY</th><th class="num">Diff</th></tr></thead><tbody>${body}</tbody></table>`;
  } else {
    $("wtCompare").innerHTML =
      `<p class="na">Add names below (or toggle a sector) to build a basket, then see how its return compares to SPY.</p>`;
  }

  // Coverage.
  const brOver = nBasket ? basketReturn(over, scheme) : null;
  const srOver = bench[over];
  const dOver = brOver != null && srOver != null ? brOver - srOver : null;
  $("wtCoverage").innerHTML =
    `<div class="kv"><span class="k">Names in basket</span><span>${nBasket} / ${rows.length}</span></div>` +
    `<div class="kv"><span class="k">By count</span><span>${wpct(nBasket / rows.length, 1)}</span></div>` +
    `<div class="kv"><span class="k">By market cap</span><span>${wpct(total ? basketMc / total : 0)}</span></div>` +
    `<div class="kv"><span class="k">Weighting</span><span>${scheme === "cap" ? "Cap-weighted" : "Equal-weighted"}</span></div>` +
    `<div class="kv"><span class="k">Over ${over}: basket vs SPY</span><span>${pct(brOver)} vs ${pct(srOver)}</span></div>` +
    `<div class="kv"><span class="k">Difference</span><span>${dOver == null ? '<span class="na">—</span>' : pct(dOver)}</span></div>` +
    (nBasket ? `<p class="sub2">${coverageVerdict(nBasket, rows.length, dOver, over)}</p>` : "");

  renderWtSectors(over);
  renderWtNames(over);
}

// ---------------- Detail view ----------------
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
      `<a class="ext pblink" href="/company/${encodeURIComponent(ticker)}" target="_blank" rel="noopener">Open standalone ↗</a>` +
      buildProfileHTML(p);
    const back = $("detailBack");
    if (back) back.onclick = () => switchTab("stocks");
    const star = $("detailStar");
    if (star) star.onclick = () => toggleWatch(ticker);
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
  ["status", "over", "sort", "direction", "sector", "ceiling", "search"].forEach((id) => {
    if ($(id) != null) $(id).value = State.filters[id];
  });
  $("secOver").value = State.secOver;
  $("wlOver").value = State.wlOver;
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

  // Filter controls -> re-render client-side (no network).
  ["status", "over", "sort", "direction", "sector", "ceiling"].forEach((id) =>
    $(id).addEventListener("change", () => {
      State.filters[id] = $(id).value;
      saveFilters();
      renderStocks();
    }));
  let searchT;
  $("search").addEventListener("input", () => {
    State.filters.search = $("search").value;
    clearTimeout(searchT);
    searchT = setTimeout(() => { saveFilters(); renderStocks(); }, 150);
  });
  $("secOver").addEventListener("change", () => {
    State.secOver = $("secOver").value; saveFilters(); renderSectors();
  });
  $("wlOver").addEventListener("change", () => {
    State.wlOver = $("wlOver").value; saveFilters(); renderWatchlist();
  });

  // Weights view controls.
  $("wtOver").addEventListener("change", () => {
    State.wtOver = $("wtOver").value; saveFilters(); renderWeights();
  });
  $("wtScheme").addEventListener("change", () => {
    State.wtScheme = $("wtScheme").value; saveFilters(); renderWeights();
  });
  $("wtTopBtn").addEventListener("click", () => {
    const n = Math.max(1, Math.min(500, parseInt($("wtTopN").value, 10) || 50));
    const top = [...weightUniverse().capped].sort((a, b) => b.market_cap - a.market_cap)
      .slice(0, n).map((r) => r.ticker);
    setBasket(top);
  });
  $("wtReset").addEventListener("click", () => setBasket([]));
  let wtSearchT;
  $("wtSearch").addEventListener("input", () => {
    clearTimeout(wtSearchT);
    wtSearchT = setTimeout(() => renderWtNames(State.wtOver), 150);
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
