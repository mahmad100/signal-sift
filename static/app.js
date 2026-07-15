// Signal Sift SPA. Fetches the full universe ONCE, caches it in localStorage,
// and does all filtering / sorting / sector math client-side so clicking a stock
// never drops your place or re-pulls data. Shares chart helpers (buildProfileHTML,
// esc, cls, num, money…) with company.js, which loads first.
const $ = (id) => document.getElementById(id);
let WINDOWS = ["1D", "1W", "1M", "3M", "6M", "9M", "1Y", "2Y", "3Y", "4Y", "5Y"];

// Bump when the cached payload shape changes; stale local caches self-purge.
// Keep in step with the server schema stamps in company.py / fundamentals.py.
const APP_SCHEMA = "4";
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
  active: "stocks",
  detailTicker: null,
  detailCache: {},            // ticker -> profile (also mirrored to localStorage)
  watchlist: new Set(),       // starred tickers
};

function loadWatchlist() {
  try { State.watchlist = new Set(JSON.parse(localStorage.getItem("ss-watchlist")) || []); }
  catch (e) { State.watchlist = new Set(); }
}
function saveWatchlist() {
  localStorage.setItem("ss-watchlist", JSON.stringify([...State.watchlist]));
}
const isWatched = (t) => State.watchlist.has(t);

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
}
function loadFilters() {
  try {
    Object.assign(State.filters, JSON.parse(localStorage.getItem("ss-filters")) || {});
    State.secOver = localStorage.getItem("ss-secover") || "1Y";
    State.wlOver = localStorage.getItem("ss-wlover") || "1Y";
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
    },
    ts: Date.now(),
  };
  WINDOWS = data.windows || WINDOWS;
  saveBase();
}

// ---------------- Client-side classification ----------------
const ceilNum = () => parseFloat(State.filters.ceiling);
function stallInfo(row, ceil) {
  const stalled = WINDOWS.filter((w) => row.returns[w] != null && row.returns[w] <= ceil);
  return { stalled, score: stalled.length };
}
function isGrowing(row, over, ceil) {
  const v = row.returns[over];
  return v != null && v > ceil;
}

function decorate(r, over, ceil) {
  const si = stallInfo(r, ceil);
  return { ...r, _stalled: si.stalled, _score: si.score,
           _growing: isGrowing(r, over, ceil) };
}

function computeRows() {
  const f = State.filters, ceil = ceilNum(), over = f.over;
  const q = (f.search || "").trim().toLowerCase();
  let rows = State.base.rows.filter((r) => {
    if (f.sector && r.sector !== f.sector) return false;
    if (q && !(r.ticker.toLowerCase().includes(q) ||
               (r.name || "").toLowerCase().includes(q))) return false;
    const grow = isGrowing(r, over, ceil);
    if (f.status === "growing" && !grow) return false;
    if (f.status === "stalled" && (r.returns[over] == null || grow)) return false;
    return true;
  }).map((r) => decorate(r, over, ceil));

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
    `<th class="num">Status</th><th class="num">Stall</th>`;
}

function makeRow(r, over) {
  const tr = document.createElement("tr");
  tr.dataset.tk = r.ticker;
  const sc = r._score;
  const badge = sc >= WINDOWS.length ? "s5" : sc >= WINDOWS.length - 1 ? "s4" : "";
  const stat = r._growing ? `<span class="pill grow">▲ Growing</span>`
                          : `<span class="pill stall">▼ Stalled</span>`;
  const on = isWatched(r.ticker);
  tr.innerHTML =
    `<td class="starcell"><span class="star ${on ? "on" : "off"}" title="Watchlist">${on ? "★" : "☆"}</span></td>` +
    `<td class="tk">${r.ticker}</td><td>${esc(r.name)}</td><td>${esc(r.sector || "")}</td>` +
    `<td class="num">$${Number(r.price).toFixed(2)}</td>` +
    WINDOWS.map((w) => `<td class="num${w === over ? " refcol" : ""}">${pct(r.returns[w])}</td>`).join("") +
    `<td class="num">${stat}</td><td class="num"><span class="badge ${badge}">${sc}</span></td>`;
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
  const ceil = ceilNum();
  const scope = State.base.rows.filter((r) => !f.sector || r.sector === f.sector);
  const grow = scope.filter((r) => isGrowing(r, over, ceil)).length;
  const stall = scope.filter((r) => r.returns[over] != null && !isGrowing(r, over, ceil)).length;

  $("status-line").innerHTML =
    `Showing <b>${rows.length}</b> of ${scope.length} · over ${over}: ` +
    `<span class="ret-up">${grow} growing</span> · <span class="ret-down">${stall} stalled</span> ` +
    `(line ${(ceil * 100).toFixed(0)}%).`;

  const tb = $("rows");
  tb.innerHTML = "";
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
  const over = State.wlOver, ceil = ceilNum();
  $("wlHead").innerHTML = headHTML(over);
  const tickers = [...State.watchlist];
  const empty = tickers.length === 0;
  $("wlEmpty").classList.toggle("hidden", !empty);
  $("wlGrid").classList.toggle("hidden", empty);

  if (empty || !State.base) { $("wl-status").textContent = ""; $("wlRows").innerHTML = ""; return; }

  const rows = State.base.rows
    .filter((r) => State.watchlist.has(r.ticker))
    .map((r) => decorate(r, over, ceil))
    .sort((a, b) => (b.returns[over] ?? -Infinity) - (a.returns[over] ?? -Infinity));

  const grow = rows.filter((r) => r._growing).length;
  $("wl-status").innerHTML =
    `<b>${rows.length}</b> watched · over ${over}: ` +
    `<span class="ret-up">${grow} growing</span> · <span class="ret-down">${rows.length - grow} stalled</span>.`;

  const tb = $("wlRows");
  tb.innerHTML = "";
  const frag = document.createDocumentFragment();
  rows.forEach((r) => frag.appendChild(makeRow(r, over)));
  tb.appendChild(frag);
}

// ---------------- Sectors view ----------------
function computeSectors(over, ceil) {
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
    const growing = refs.filter((v) => v > ceil).length;
    const ranked = [...rows].sort((a, b) => (a.returns[over] ?? -Infinity) - (b.returns[over] ?? -Infinity));
    return {
      sector, count: rows.length, medByWin,
      medOver: median(refs), growing, stalled: refs.length - growing,
      pctGrowing: refs.length ? growing / refs.length : null,
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
  const over = State.secOver, ceil = ceilNum();
  const { sectors, benchOver } = computeSectors(over, ceil);

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
    `<span class="secmid">◀ stalled · median ${over} · growing ▶${benchOver != null ? " · SPY " : ""}${benchOver != null ? pct(benchOver) : ""}</span>` +
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

// ---------------- Tabs ----------------
function switchTab(name) {
  State.active = name;
  ["stocks", "watchlist", "sectors", "detail"].forEach((v) => {
    $("view-" + v).classList.toggle("hidden", v !== name);
  });
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name));
  if (name === "sectors") renderSectors();
  if (name === "watchlist") renderWatchlist();
}

// ---------------- Boot + events ----------------
function syncControlsFromState() {
  ["status", "over", "sort", "direction", "sector", "ceiling", "search"].forEach((id) => {
    if ($(id) != null) $(id).value = State.filters[id];
  });
  $("secOver").value = State.secOver;
  $("wlOver").value = State.wlOver;
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

async function boot() {
  purgeStaleCaches();
  loadFilters();
  loadWatchlist();
  updateWatchCount();
  syncControlsFromState();

  const cached = loadBase();
  if (cached && cached.rows) {
    State.base = cached;
    WINDOWS = cached.meta.windows || WINDOWS;
    setMeta();
    renderStocks();
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

  // Refresh: force server re-pull + drop all local caches.
  $("refresh").addEventListener("click", async () => {
    $("refresh").disabled = true;
    $("refresh").textContent = "↻ Refreshing…";
    $("status-line").textContent = "Re-pulling all prices from Yahoo (this can take a minute)…";
    clearDetailCache();
    try {
      await fetchBase(true);
      setMeta();
      renderStocks();
      if (State.active === "sectors") renderSectors();
    } finally {
      $("refresh").disabled = false;
      $("refresh").textContent = "↻ Refresh data";
    }
  });
}

boot();
