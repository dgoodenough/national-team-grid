"use strict";

/* National Team Matchup Grid — Scorigami-style heatmap of international football fixtures.
   Vanilla JS + Canvas. Loads pre-built JSON from data/ and renders an N×N grid where each
   cell is a pair of national teams, coloured by how many times they have met.

   Five views share one state object: the grid itself, plus four list views that answer the
   questions the grid can only hint at (what's scheduled, what happened exactly once, who is
   closest to meeting, and how any two teams connect). Everything the user picks lives in the
   URL, so any view can be linked to. */

const YEAR_MIN = 1872;               // Scotland v England, the first international
const BAND = 13;                     // px confederation colour strip at outer edge
const MIN_CELL = 1;                  // px: small enough that 211 columns fit a phone
const CONFEDS = ["AFC", "CAF", "CONCACAF", "CONMEBOL", "OFC", "UEFA"];
const VIEWS = ["grid", "fixtures", "oneoffs", "misses", "path"];
const TAP_LEGIBLE = 18;              // px cell size a tap zooms to when cells are too small
const MOBILE_Q = "(max-width: 720px)";

let MARGIN = 116;                    // px reserved for labels + confederation band

const S = {
  members: [],                       // current FIFA members
  defunct: { members: [], pairs_men: [], pairs_women: [] },
  byId: new Map(),
  confedOrder: [],
  pairs: { men: new Map(), women: new Map() },
  maxCount: { men: 1, women: 1 },
  matches: { men: null, women: null },   // per-meeting detail, lazy-loaded on first click
  upcoming: { men: new Map(), women: new Map() }, // scheduled first meetings (key -> [date, tourn])
  yearsByPair: { men: null, women: null }, // key -> sorted meeting years (slim years_*.json)
  undated: { men: {}, women: {} },   // key -> meetings whose source row has no usable date
  debut: { men: new Map(), women: new Map() },  // team id -> year of its first ever match
  everPlayed: { men: new Set(), women: new Set() },
  meta: {},
  // view options
  view: "grid",
  gender: "men",
  sort: "confed",                    // "confed" | "rank" | "matches" | "alpha"
  showConfeds: new Set(),
  manual: new Set(),
  includeDefunct: false,
  highlightNever: false,
  showUpcoming: false,               // highlight upcoming first meetings in yellow
  today: "",                         // client's current date (YYYY-MM-DD), set on load
  year: null,                        // scrubber: show grid as of this year (null = present)
  maxYear: 2026,
  playing: false,                    // timeline autoplay
  path: { a: null, b: null },        // degrees-of-separation endpoints
  // ordered ids currently displayed
  order: [],
  metByYear: null,                   // prefix sums: how many pairs had met by each year
  // viewport: on-screen cell size (px) + pan offset
  cell: 20, tx: 0, ty: 0,
  hover: null,                       // {r, c} under the mouse
  focus: null,                       // {r, c} under keyboard focus
};

const canvas = document.getElementById("grid");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");
const canvasWrap = document.getElementById("canvas-wrap");
const live = document.getElementById("live");
let DPR = window.devicePixelRatio || 1;
// Per-day cache-buster: data refreshes daily, so re-fetch fresh once a day (cached within the day).
const VBUST = "?d=" + new Date().toISOString().slice(0, 10);
const mqMobile = window.matchMedia(MOBILE_Q);
const mqReduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ---------- small helpers ---------- */

// Every innerHTML in this file interpolates names that came from third-party feeds
// (martj42, FotMob, ESPN). None of it is attacker-controlled today, but it is not ours
// either, and it lands in the DOM daily without a human reading the diff.
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const $ = id => document.getElementById(id);
const pl = (k, word) => (k === 1 ? word : word + "s");
const num = n => n.toLocaleString();

function announce(msg) { if (live) live.textContent = msg; }

/* ---------- theme ---------- */
// getCss memoises, so every theme change has to clear it or the canvas keeps painting
// yesterday's palette.
let _css = {};
function getCss(v) {
  return _css[v] || (_css[v] = getComputedStyle(document.documentElement)
    .getPropertyValue(v).trim());
}
function clearCssCache() { _css = {}; RAMP = null; }

function preferredTheme() {
  try {
    const saved = localStorage.getItem("ntg-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* private mode / storage blocked */ }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme(theme, persist = true) {
  // The class goes on <html> as well as <body>: the canvas reads its palette with
  // getComputedStyle(document.documentElement), and custom properties set on <body> do not
  // cascade upwards to it. On <body> alone the page would turn light and the grid would
  // keep painting itself in the dark palette.
  const light = theme === "light";
  document.documentElement.classList.toggle("ledger-light", light);
  document.body.classList.toggle("ledger-light", light);
  clearCssCache();
  const btn = $("theme");
  if (btn) {
    btn.innerHTML = theme === "light" ? "&#9790;" : "&#9788;";
    btn.setAttribute("aria-label",
      theme === "light" ? "Switch to the dark theme" : "Switch to the light theme");
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", getCss("--chrome"));
  if (persist) { try { localStorage.setItem("ntg-theme", theme); } catch { /* ignore */ } }
}
const currentTheme = () =>
  document.documentElement.classList.contains("ledger-light") ? "light" : "dark";

/* ---------- colour ---------- */
// The ramp and the confederation palette live in style.css so the stylesheet, the canvas
// and render_hero.py all read the same numbers. Parsed once per theme.
let RAMP = null;
function ramp() {
  if (!RAMP) {
    RAMP = [0, 30, 55, 80, 100].map(stop => [stop / 100, hexToRgb(getCss(`--ramp-${stop}`))]);
  }
  return RAMP;
}
function hexToRgb(hex) {
  const h = (hex || "#000").trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  return [parseInt(full.slice(0, 2), 16) || 0,
          parseInt(full.slice(2, 4), 16) || 0,
          parseInt(full.slice(4, 6), 16) || 0];
}
const confedColor = cf => getCss(`--confed-${String(cf).toLowerCase()}`) || "#888";

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function rampColor(t) {
  const R = ramp();
  for (let i = 1; i < R.length; i++) {
    if (t <= R[i][0]) {
      const [t0, c0] = R[i - 1], [t1, c1] = R[i];
      const f = (t - t0) / (t1 - t0);
      return `rgb(${lerp(c0[0], c1[0], f)},${lerp(c0[1], c1[1], f)},${lerp(c0[2], c1[2], f)})`;
    }
  }
  const last = R[R.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}
function cellColor(count) {
  const never = S.highlightNever ? getCss("--never-hi") : getCss("--never");
  if (!count) return never;
  const t = Math.log1p(count) / Math.log1p(S.maxCount[S.gender]);
  if (S.highlightNever) {            // de-emphasise played cells to spotlight the empties
    const [r0, g0, b0] = hexToRgb(getCss("--paper-2"));
    const [r1, g1, b1] = hexToRgb(getCss("--ink-3"));
    return `rgb(${lerp(r0, r1, t)},${lerp(g0, g1, t)},${lerp(b0, b1, t)})`;
  }
  return rampColor(t);
}

/* ---------- data loading ---------- */
async function load() {
  const [members, mMen, mWomen, defunct, upcoming] = await Promise.all([
    fetch("data/members.json" + VBUST).then(r => r.json()),
    fetch("data/matrix_men.json" + VBUST).then(r => r.json()),
    fetch("data/matrix_women.json" + VBUST).then(r => r.json()),
    fetch("data/defunct.json" + VBUST).then(r => r.json()),
    fetch("data/upcoming.json" + VBUST).then(r => r.json()).catch(() => ({ men: [], women: [] })),
  ]);

  S.members = members.members;
  S.confedOrder = members.confederation_order;
  S.meta = {
    generated: members.generated,
    dataThrough: members.data_through || {},
    rankingMen: members.ranking_men,
    rankingWomen: members.ranking_women,
  };
  S.defunct = defunct;
  for (const m of S.members) S.byId.set(m.id, m);
  for (const m of defunct.members) S.byId.set(m.id, m);

  S.pairs.men = buildPairMap(mMen.pairs, defunct.pairs_men);
  S.pairs.women = buildPairMap(mWomen.pairs, defunct.pairs_women);
  S.maxCount.men = mMen.max_count;
  S.maxCount.women = mWomen.max_count;
  S.showConfeds = new Set(S.confedOrder);

  // Per-team debut year and "has this team ever played anyone", so the grid can tell the
  // three kinds of empty apart: never met, hadn't debuted yet, and never played at all.
  for (const [g, mx] of [["men", mMen], ["women", mWomen]]) {
    for (const src of [mx.pairs, defunct[`pairs_${g}`] || []]) {
      for (const [i, j, , fy] of src) {
        S.everPlayed[g].add(i);
        S.everPlayed[g].add(j);
        const y = fy == null ? YEAR_MIN : fy;
        for (const id of [i, j]) {
          const prev = S.debut[g].get(id);
          if (prev == null || y < prev) S.debut[g].set(id, y);
        }
      }
    }
  }

  for (const g of ["men", "women"]) {
    for (const [i, j, date, tourn] of (upcoming[g] || [])) {
      S.upcoming[g].set(`${i},${j}`, [date, tourn]);
    }
  }
  const d = new Date();   // the machine's current date drives which fixtures are still upcoming
  S.today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // latest played year across both archives drives the scrubber's right end.
  let maxY = 1900;
  for (const mx of [mMen, mWomen]) for (const p of mx.pairs) if (p[4] > maxY) maxY = p[4];
  S.maxYear = maxY;
  S.year = maxY;

  $("loading").remove();
  readUrl();                          // a shared link wins over every default
  buildControls();
  drawLegend();
  applyView(S.view, { focus: false, push: false });
  recompute(true);
}

function buildPairMap(pairs, defunctPairs) {
  // Keyed by "lo,hi" strings (matching matches_*.json). A numeric i*K+j key would collide
  // because defunct ids start at 100000 (e.g. member 1 × defunct 100007 == member 2 × 7).
  const map = new Map();
  for (const [i, j, c, fy, ly] of pairs) map.set(`${i},${j}`, [c, fy, ly]);
  for (const [i, j, c, fy, ly] of defunctPairs) map.set(`${i},${j}`, [c, fy, ly]);
  return map;
}

const isCombined = () => S.gender === "both";
const dataGender = g => (g === "both" ? "men" : g);
function pairKey(a, b) { return a < b ? `${a},${b}` : `${b},${a}`; }
function present() { return S.year == null || S.year >= S.maxYear; }

function lookup(a, b, gender = S.gender) {
  if (a === b) return null;
  return S.pairs[dataGender(gender)].get(pairKey(a, b)) || null;
}

/* Has this pair met, as of the scrubber year?

   This reads only the first-meeting year already in matrix_*.json, so the grid, the
   headline and the combined-view categories never wait on a download. Only the exact
   "N meetings by year Y" in a tooltip needs the per-pair year list. */
function metAsOf(a, b, gender = S.gender) {
  if (a === b) return false;
  const p = S.pairs[dataGender(gender)].get(pairKey(a, b));
  if (!p) return false;
  if (present() || p[1] == null) return true;   // undatable meetings count as always-met
  return p[1] <= S.year;
}

// Exact number of meetings as of the scrubber year. Falls back to the all-time total
// until years_*.json has arrived (the grid is already correct either way).
function countAsOf(a, b, gender = S.gender) {
  if (a === b) return 0;
  const g = dataGender(gender);
  const k = pairKey(a, b);
  const p = S.pairs[g].get(k);
  if (!p) return 0;
  if (present()) return p[0];
  const ys = S.yearsByPair[g];
  if (!ys) return metAsOf(a, b, gender) ? p[0] : 0;
  const arr = ys.get(k);
  if (!arr) return 0;
  let lo = 0, hi = arr.length;                          // count years <= S.year (arr sorted asc)
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= S.year) lo = m + 1; else hi = m; }
  return lo;
}
// True once the exact per-year counts are available for the active dataset.
function countsExact() {
  return present() || (isCombined()
    ? !!(S.yearsByPair.men && S.yearsByPair.women)
    : !!S.yearsByPair[dataGender(S.gender)]);
}

function upcomingInfo(a, b) {
  return isCombined() ? null : S.upcoming[S.gender].get(pairKey(a, b)) || null;
}
// A scheduled first meeting still in the future (or today) per the client's clock.
function isUpcoming(a, b) { const u = upcomingInfo(a, b); return !!u && u[0] >= S.today; }

// Has this team played anyone at all in the active archive? An entire empty row is a
// different fact from "these two have never met", and the site says so.
function hasAnyMatches(id, gender = S.gender) {
  return isCombined()
    ? (S.everPlayed.men.has(id) || S.everPlayed.women.has(id))
    : S.everPlayed[gender].has(id);
}
// Year of a team's first ever match, or null if it has never played.
function debutYear(id, gender = S.gender) {
  if (!isCombined()) return S.debut[gender].get(id) ?? null;
  const a = S.debut.men.get(id), b = S.debut.women.get(id);
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.min(a, b);
}
function notYetDebuted(id) {
  if (present()) return false;
  const y = debutYear(id);
  return y == null ? false : y > S.year;
}

/* The slim per-pair meeting years. Only tooltips and the detail card need this, so it is
   fetched in the background on the first scrub and the grid never blocks on it. */
async function ensureYears(gender) {
  const g = dataGender(gender);
  if (S.yearsByPair[g]) return;
  const data = await fetch(`data/years_${g}.json` + VBUST).then(r => r.json());
  const map = new Map();
  for (const k in data.pairs) {                 // stored delta-encoded; expand to absolute
    const enc = data.pairs[k];
    const years = new Array(enc.length);
    let run = enc[0];
    years[0] = run;
    for (let i = 1; i < enc.length; i++) { run += enc[i]; years[i] = run; }
    map.set(k, years);
  }
  S.yearsByPair[g] = map;
  S.undated[g] = data.undated || {};
}
function ensureYearsForView() {
  return isCombined()
    ? Promise.all([ensureYears("men"), ensureYears("women")])
    : ensureYears(S.gender);
}

/* ---------- ordering ---------- */
function rankOf(m) {
  if (isCombined()) {                            // best (lowest) of the two ranks
    return Math.min(m.mens_rank == null ? Infinity : m.mens_rank,
                    m.womens_rank == null ? Infinity : m.womens_rank);
  }
  const r = S.gender === "men" ? m.mens_rank : m.womens_rank;
  return r == null ? Infinity : r;
}

// Combined view: which datasets a pair has met in, as of the scrubber year.
// Bitmask 1 = men, 2 = women, so 3 = both, 0 = neither.
function metCategory(a, b) {
  return (metAsOf(a, b, "men") ? 1 : 0) | (metAsOf(a, b, "women") ? 2 : 0);
}
function combinedColor(a, b) {
  switch (metCategory(a, b)) {
    case 3: return getCss("--both");
    case 1: return getCss("--men-only");
    case 2: return getCss("--women-only");
    default: return getCss("--never");
  }
}

/* ---------- what's on screen ---------- */
function activePool() {
  let base = S.members.slice();
  if (S.includeDefunct) base = base.concat(S.defunct.members);
  return base;
}

function recompute(fit) {
  closeDetail();
  closePeek();

  // One team manually selected -> show that team's matchups ranked most-to-least played,
  // instead of a useless 1x1 grid. Two or more -> fall back to a normal sub-grid.
  if (S.manual.size === 1 && S.view === "grid") {
    renderTeamFocus([...S.manual][0]);
    canvasWrap.classList.add("focus");
    writeUrl();
    return;
  }
  $("teamfocus").hidden = true;
  canvasWrap.classList.remove("focus");

  const base = activePool();
  const active = S.manual.size
    ? base.filter(m => S.manual.has(m.id))
    : base.filter(m => S.showConfeds.has(m.confed));

  // For the "total matches" sort, tally each active team's meetings against the whole pool
  // (everyone, not just the visible subset), honouring the time scrubber.
  let totals = null;
  if (S.sort === "matches") {
    totals = new Map();
    const genders = isCombined() ? ["men", "women"] : [S.gender];
    for (const m of active) {
      let t = 0;
      for (const o of base) if (o.id !== m.id) for (const g of genders) t += countAsOf(m.id, o.id, g);
      totals.set(m.id, t);
    }
  }

  active.sort((a, b) => {
    if (S.sort === "alpha") return a.name.localeCompare(b.name);
    if (S.sort === "matches") {
      const ta = totals.get(a.id), tb = totals.get(b.id);
      if (ta !== tb) return tb - ta;                 // most matches first
      return a.name.localeCompare(b.name);
    }
    if (S.sort === "rank") {
      const ra = rankOf(a), rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    }
    // confederation, then FIFA rank, then name
    const ca = S.confedOrder.indexOf(a.confed), cb = S.confedOrder.indexOf(b.confed);
    if (ca !== cb) return ca - cb;
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });

  S.order = active.map(m => m.id);
  if (S.focus && S.focus.r >= S.order.length) S.focus = null;
  buildYearIndex();
  if (fit) fitView(); else clampPan();
  updateStats();
  updateLegend();
  draw();
  writeUrl();
}

/* Prefix sums of "how many of the on-screen pairs had met by year Y".

   The headline used to walk all 22,155 pairs on every frame of a timeline drag. The first
   meeting year of every pair is already in matrix_*.json, so one O(n²) pass per view change
   buys an O(1) lookup per scrub frame — and the whole scrubber stops being the expensive
   thing on the page. */
function buildYearIndex() {
  const n = S.order.length;
  const span = S.maxYear - YEAR_MIN + 2;
  const men = new Int32Array(span), women = new Int32Array(span), both = new Int32Array(span);
  const slot = y => Math.max(0, Math.min(span - 1, (y == null ? YEAR_MIN : y) - YEAR_MIN));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = S.order[i], b = S.order[j], k = pairKey(a, b);
      const pm = S.pairs.men.get(k), pw = S.pairs.women.get(k);
      if (pm) men[slot(pm[1])]++;
      if (pw) women[slot(pw[1])]++;
      if (pm && pw) both[slot(Math.max(pm[1] ?? YEAR_MIN, pw[1] ?? YEAR_MIN))]++;
    }
  }
  for (let i = 1; i < span; i++) { men[i] += men[i - 1]; women[i] += women[i - 1]; both[i] += both[i - 1]; }
  S.metByYear = { men, women, both, span, total: n * (n - 1) / 2 };
}
// How many on-screen pairs had met by the scrubber year, per dataset.
function metCounts() {
  const idx = S.metByYear;
  if (!idx) return { men: 0, women: 0, both: 0, total: 0 };
  const at = present() ? idx.span - 1
    : Math.max(0, Math.min(idx.span - 1, S.year - YEAR_MIN));
  return { men: idx.men[at], women: idx.women[at], both: idx.both[at], total: idx.total };
}

/* ---------- viewport ---------- */
function gridArea() { return { w: canvas.clientWidth - MARGIN, h: canvas.clientHeight - MARGIN }; }

/* How much gutter the labels need at this cell size.

   Below 5px no label is drawn at all, so reserving 116px of margin there was pure waste —
   and on a phone it was the reason "Fit" produced a grid wider than the screen it was
   fitting into. The gutter now grows with the cells it has to caption. */
function marginFor(cell) {
  const cap = Math.max(44, Math.min(116, canvas.clientWidth * 0.2));
  if (cell < 5) return BAND + 6;
  return Math.round(Math.min(cap, BAND + 6 + (cell - 5) * 9));
}

function fitView() {
  const n = S.order.length || 1;
  // The margin depends on the cell size and the cell size depends on the margin, so
  // iterate to a fixed point (converges in two or three passes).
  let cell = S.cell;
  for (let i = 0; i < 5; i++) {
    MARGIN = marginFor(cell);
    const { w, h } = gridArea();
    const next = Math.max(MIN_CELL, Math.min(w / n, h / n));
    if (Math.abs(next - cell) < 0.02) { cell = next; break; }
    cell = next;
  }
  S.cell = cell;
  MARGIN = marginFor(cell);
  const { w, h } = gridArea();
  S.tx = Math.max(0, (w - S.cell * n) / 2);
  S.ty = Math.max(0, (h - S.cell * n) / 2);
}

function clampPan() {
  MARGIN = marginFor(S.cell);
  const n = S.order.length;
  const { w, h } = gridArea();
  const gw = S.cell * n, gh = S.cell * n;
  if (gw <= w) S.tx = (w - gw) / 2; else S.tx = Math.min(0, Math.max(w - gw, S.tx));
  if (gh <= h) S.ty = (h - gh) / 2; else S.ty = Math.min(0, Math.max(h - gh, S.ty));
}

/* ---------- rendering ---------- */
function resize() {
  DPR = window.devicePixelRatio || 1;
  canvas.width = Math.floor(canvas.clientWidth * DPR);
  canvas.height = Math.floor(canvas.clientHeight * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  MARGIN = marginFor(S.cell);
}

function draw() {
  if (S.view !== "grid") return;
  // Keep the backing store matched to the element's CSS size. If the layout shifts after the
  // last resize() — e.g. the headline grows when data loads, or a scrollbar appears — the
  // canvas ends up shorter than its backing store and the uncleared strip shows stale pixels
  // ("artifacts at the bottom") that persist across redraws/zooms. Re-sync if mismatched.
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(canvas.clientWidth * dpr) ||
      canvas.height !== Math.floor(canvas.clientHeight * dpr)) {
    resize();
  }
  const n = S.order.length;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = getCss("--bg");
  ctx.fillRect(0, 0, W, H);
  if (!n) return;

  const cell = S.cell;
  const ox = MARGIN + S.tx, oy = MARGIN + S.ty;     // grid origin on screen
  const { w: gw, h: gh } = gridArea();

  const c0 = Math.max(0, Math.floor((MARGIN - ox) / cell));
  const c1 = Math.min(n, Math.ceil((W - ox) / cell));
  const r0 = Math.max(0, Math.floor((MARGIN - oy) / cell));
  const r1 = Math.min(n, Math.ceil((H - oy) / cell));

  // cells
  ctx.save();
  ctx.beginPath();
  ctx.rect(MARGIN, MARGIN, gw, gh);
  ctx.clip();
  const diag = getCss("--diag");
  const upcomingCol = getCss("--upcoming");
  const nodataCol = getCss("--nodata");
  const predebutCol = getCss("--predebut");
  const atPresent = present();
  const combined = isCombined();
  const span = Math.ceil(cell) + (cell > 7 ? 0 : 1);
  // Precompute the per-row facts so the inner loop stays a lookup, not a function call.
  const rowSilent = [], rowPre = [];
  for (let r = r0; r < r1; r++) {
    rowSilent[r] = !hasAnyMatches(S.order[r]);
    rowPre[r] = notYetDebuted(S.order[r]);
  }
  const colSilent = [], colPre = [];
  for (let c = c0; c < c1; c++) {
    colSilent[c] = !hasAnyMatches(S.order[c]);
    colPre[c] = notYetDebuted(S.order[c]);
  }
  for (let r = r0; r < r1; r++) {
    const a = S.order[r];
    const y = oy + r * cell;
    for (let c = c0; c < c1; c++) {
      const b = S.order[c];
      let col;
      if (a === b) {
        col = diag;
      } else if (combined) {
        const cat = metCategory(a, b);
        col = cat ? combinedColor(a, b)
          : (rowSilent[r] || colSilent[c]) ? nodataCol
            : (rowPre[r] || colPre[c]) ? predebutCol
              : getCss("--never");
      } else if (metAsOf(a, b)) {
        col = cellColor(countAsOf(a, b));
      } else if (S.showUpcoming && atPresent && isUpcoming(a, b)) {
        col = upcomingCol;
      } else if (rowSilent[r] || colSilent[c]) {
        // Not "these two have never met" — one of them has never played anyone at all.
        col = nodataCol;
      } else if (rowPre[r] || colPre[c]) {
        col = predebutCol;                    // hadn't debuted yet at the scrubbed year
      } else {
        col = cellColor(0);
      }
      ctx.fillStyle = col;
      ctx.fillRect(Math.floor(ox + c * cell), Math.floor(y), span, span);
    }
  }
  // outline the grid extent so paper-white "never" cells read as part of the grid
  ctx.strokeStyle = getCss("--grid-strong");
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + .5, oy + .5, n * cell - 1, n * cell - 1);
  // hover crosshair
  const cross = S.hover || S.focus;
  if (cross) {
    ctx.fillStyle = getCss("--crosshair");
    ctx.fillRect(MARGIN, oy + cross.r * cell, gw, cell);
    ctx.fillRect(ox + cross.c * cell, MARGIN, cell, gh);
  }
  // keyboard focus gets a hard outline as well — a wash is not a focus indicator
  if (S.focus) {
    ctx.strokeStyle = getCss("--pos");
    ctx.lineWidth = 2;
    ctx.strokeRect(ox + S.focus.c * cell - 1, oy + S.focus.r * cell - 1,
                   Math.max(4, cell + 2), Math.max(4, cell + 2));
  }
  ctx.restore();

  /* Where the labels and confederation strips live.

     They belong in the margin when the grid is bigger than the viewport and being panned,
     but glued to the grid's own edge when a fitted grid is centred with space around it —
     otherwise the strips float off on their own at the far left of the canvas. Taking the
     max of the two gives the pinned behaviour while panning and the glued behaviour while
     fitted, with no special case. */
  const gutterX = Math.max(MARGIN, Math.min(ox, MARGIN + gw));
  const gutterY = Math.max(MARGIN, Math.min(oy, MARGIN + gh));

  if (S.sort === "confed") drawSeparators(n, ox, oy, cell, gw, gh);
  drawLabels(n, ox, oy, cell, r0, r1, c0, c1, gutterX, gutterY);
  drawBands(ox, oy, cell, gutterX, gutterY);

  // mask the margin corners cleanly
  ctx.fillStyle = getCss("--bg");
  ctx.fillRect(0, 0, gutterX, gutterY);
}

function confedRuns() {
  // contiguous [start, end, confed] runs over S.order
  const runs = [];
  for (let i = 0; i < S.order.length; i++) {
    const cf = S.byId.get(S.order[i]).confed;
    const last = runs[runs.length - 1];
    if (last && last.confed === cf) last.end = i;
    else runs.push({ start: i, end: i, confed: cf });
  }
  return runs;
}

function drawSeparators(n, ox, oy, cell, gw, gh) {
  ctx.strokeStyle = getCss("--line");
  ctx.lineWidth = 1;
  // Clamped to the grid's own extent so the rules never run on past its edges.
  const x0 = Math.max(MARGIN, ox), x1 = Math.min(MARGIN + gw, ox + n * cell);
  const y0 = Math.max(MARGIN, oy), y1 = Math.min(MARGIN + gh, oy + n * cell);
  for (const run of confedRuns()) {
    if (run.start === 0) continue;
    const x = ox + run.start * cell, y = oy + run.start * cell;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + .5, y0); ctx.lineTo(Math.round(x) + .5, y1);
    ctx.moveTo(x0, Math.round(y) + .5); ctx.lineTo(x1, Math.round(y) + .5);
    ctx.stroke();
  }
}

// Flags are drawn only when the cells are big enough to have earned the space. Canvas
// emoji rendering is solid on macOS/iOS/Android/Linux; Windows falls back to the letter
// pair, which is why the three-letter FIFA code stays the primary label everywhere.
function shortLabel(m, cell) {
  const flag = cell >= 20 && m.flag ? m.flag + " " : "";
  if (cell >= 46) return flag + m.name;
  if (m.code) return flag + m.code;
  return flag + (m.name.length > 6 ? m.name.slice(0, 6) : m.name);
}

function drawLabels(n, ox, oy, cell, r0, r1, c0, c1, gutterX, gutterY) {
  if (cell < 5) return;
  // Thin the labels so their on-screen spacing stays legible (>= ~14px) at any zoom —
  // otherwise codes pile on top of each other into gibberish at low zoom.
  const step = Math.max(1, Math.round(14 / cell));
  const fs = Math.min(13, Math.max(8, cell - 3));
  ctx.font = `${fs}px -apple-system, "Segoe UI", sans-serif`;

  // Keep labels clear of the confederation colour band (the outer BAND-px strip).
  const edge = gutterX - BAND - 4;         // inner edge of the row band
  const edgeTop = gutterY - BAND - 4;      // inner edge of the column band
  const maxLen = Math.max(12, MARGIN - BAND - 8);
  const ink = getCss("--ink"), dim = getCss("--ink-dim"), silent = getCss("--nodata-line");
  const labelColor = m => m.defunct ? dim : (hasAnyMatches(m.id) ? ink : silent);

  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let r = r0; r < r1; r++) {
    if (r % step) continue;
    const m = S.byId.get(S.order[r]);
    ctx.fillStyle = labelColor(m);
    ctx.fillText(shortLabel(m, cell), edge, oy + r * cell + cell / 2, maxLen);
  }
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (let c = c0; c < c1; c++) {
    if (c % step) continue;
    const m = S.byId.get(S.order[c]);
    const x = ox + c * cell + cell / 2;
    ctx.save();
    ctx.translate(x, edgeTop); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = labelColor(m);
    ctx.fillText(shortLabel(m, cell), 0, 0, maxLen);
    ctx.restore();
  }
}

function drawBands(ox, oy, cell, gutterX, gutterY) {
  const { w: gw, h: gh } = gridArea();
  const right = MARGIN + gw, bottom = MARGIN + gh;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "700 10px -apple-system, sans-serif";
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const bandInk = getCss("--band-strip-ink");
  for (const run of confedRuns()) {
    const col = confedColor(run.confed);
    const a = run.start * cell, len = (run.end - run.start + 1) * cell;
    ctx.fillStyle = col;
    ctx.fillRect(ox + a, gutterY - BAND, len, BAND);          // top strip
    ctx.fillRect(gutterX - BAND, oy + a, BAND, len);          // left strip
    // Label, stuck to the visible portion of the run (only when there's room).
    const visW = Math.min(ox + a + len, right) - Math.max(ox + a, MARGIN);
    const visH = Math.min(oy + a + len, bottom) - Math.max(oy + a, MARGIN);
    ctx.fillStyle = bandInk;
    if (visW > 26) {
      const cx = clamp(ox + a + len / 2, MARGIN + 12, right - 12);
      ctx.fillText(run.confed, cx, gutterY - BAND / 2 - .5);
    }
    if (visH > 26) {
      const cy = clamp(oy + a + len / 2, MARGIN + 12, bottom - 12);
      ctx.save();
      ctx.translate(gutterX - BAND / 2, cy); ctx.rotate(-Math.PI / 2);
      ctx.fillText(run.confed, 0, .5);
      ctx.restore();
    }
  }
}

function drawLegend() {
  const lc = $("legend-canvas");
  const g = lc.getContext("2d");
  const w = lc.width, h = lc.height;
  for (let x = 0; x < w; x++) {
    g.fillStyle = rampColor(x / (w - 1));
    g.fillRect(x, 0, 1, h);
  }
}

// Tick marks under the ramp. It is log-scaled from 1 to ~183, so without gradations there
// is no way to tell a five-meeting green from a fifty-meeting one.
function drawLegendTicks() {
  const host = $("legend-ticks");
  if (!host) return;
  const max = S.maxCount[dataGender(S.gender)];
  const stops = [1, 3, 10, 30, 100, 300, 1000].filter(v => v < max).concat([max]);
  const denom = Math.log1p(max);
  host.innerHTML = stops.map(v => {
    const pct = 100 * Math.log1p(v) / denom;
    const nudge = pct < 6 ? "left:0;transform:none" : pct > 94 ? "right:0;left:auto;transform:none"
      : `left:${pct.toFixed(2)}%`;
    return `<span class="tick" style="${nudge}">${v}</span>`;
  }).join("");
}

// Swap the meetings-ramp legend for the 4-category key in combined view (and vice versa).
function updateLegend() {
  const rampBox = $("legend-ramp"), comb = $("legend-combined");
  if (rampBox && comb) { rampBox.hidden = isCombined(); comb.hidden = !isCombined(); }
  const lm = $("legend-max");
  if (lm && !isCombined()) lm.textContent = `1 → ${S.maxCount[S.gender]}`;
  drawLegend();
  drawLegendTicks();
}

/* ---------- interaction ---------- */
function cellAt(mx, my) {
  if (mx < MARGIN || my < MARGIN) return null;
  const c = Math.floor((mx - MARGIN - S.tx) / S.cell);
  const r = Math.floor((my - MARGIN - S.ty) / S.cell);
  if (r < 0 || c < 0 || r >= S.order.length || c >= S.order.length) return null;
  return { r, c };
}

// One description of a pairing, reused by the tooltip, the peek card and the screen reader.
function pairSummary(aId, bId) {
  const A = S.byId.get(aId), B = S.byId.get(bId);
  if (!A || !B) return { title: "", lines: [] };
  if (A.id === B.id) {
    return { title: A.name, lines: [`${A.confed}${A.defunct ? " · defunct" : ""}`], self: true };
  }
  const asOf = present() ? "" : ` by ${S.year}`;
  const title = `${A.name} v ${B.name}`;
  if (isCombined()) {
    const mc = countAsOf(A.id, B.id, "men"), wc = countAsOf(A.id, B.id, "women");
    const say = (label, c) => `${label}: ${c ? `${c} ${pl(c, "meeting")}${asOf}` : `never played${asOf}`}`;
    return { title, lines: [say("Men's", mc), say("Women's", wc)] };
  }
  const met = metAsOf(A.id, B.id);
  const p = lookup(A.id, B.id);
  if (met) {
    const cnt = countAsOf(A.id, B.id);
    const approx = countsExact() ? "" : "~";
    const range = present() ? `${p[1]}–${p[2]}` : `since ${p[1]}`;
    return { title, lines: [`${approx}${cnt} ${pl(cnt, "meeting")}${asOf}`, range] };
  }
  const up = upcomingInfo(A.id, B.id);
  if (up && present()) {
    return {
      title,
      lines: [up[0] >= S.today ? "first meeting coming up" : "first meeting — result pending",
              `${up[0]} · ${up[1]}`],
      upcoming: true,
    };
  }
  // Distinguish the three empties in words as well as in colour.
  for (const t of [A, B]) {
    if (!hasAnyMatches(t.id)) {
      return { title, lines: [`${t.name} has never played a ${genderWord()} international`],
               silent: true };
    }
  }
  if (!present()) {
    for (const t of [A, B]) {
      const y = debutYear(t.id);
      if (y != null && y > S.year) {
        return { title, lines: [`${t.name} had not debuted by ${S.year}`, `first match ${y}`],
                 predebut: true };
      }
    }
  }
  return { title, lines: [`never played${asOf}`, `${genderWord()} internationals`] };
}
const genderWord = () => (isCombined() ? "senior" : S.gender === "men" ? "men's" : "women's");

function summaryHtml(sum) {
  const cls = sum.upcoming ? "up" : sum.silent ? "silent" : sum.predebut ? "pre" : "n";
  return `<div class="vs">${esc(sum.title)}</div>`
    + `<div class="${cls}">${esc(sum.lines[0] || "")}</div>`
    + (sum.lines[1] ? `<div class="dim">${esc(sum.lines[1])}</div>` : "");
}

function showTooltip(rc, mx, my) {
  tooltip.innerHTML = summaryHtml(pairSummary(S.order[rc.r], S.order[rc.c]));
  tooltip.hidden = false;
  const pad = 14;
  let x = mx + pad, y = my + pad;
  const rect = tooltip.getBoundingClientRect();
  if (x + rect.width > canvas.clientWidth) x = mx - rect.width - pad;
  if (y + rect.height > canvas.clientHeight) y = my - rect.height - pad;
  tooltip.style.left = Math.max(4, x) + "px";
  tooltip.style.top = Math.max(4, y) + "px";
}

/* The peek card: touch's answer to hover.

   A tap used to go straight to the full head-to-head, which on a phone-sized grid meant
   committing to whichever of nine candidate cells the finger happened to cover. Now a tap
   shows what it landed on and offers to open it — and if the cells are too small to aim at,
   the same tap zooms in first so the next one is accurate. */
function closePeek() { const el = $("peek"); if (el) el.hidden = true; }

function showPeek(rc, px, py) {
  const el = $("peek");
  if (!el) return;
  const aId = S.order[rc.r], bId = S.order[rc.c];
  const sum = pairSummary(aId, bId);
  el.innerHTML = summaryHtml(sum)
    + `<div class="peek-act">`
    + (sum.self ? "" : `<button type="button" class="peek-open">See all meetings</button>`)
    + `<button type="button" class="peek-close" aria-label="Dismiss">Close</button></div>`;
  el.hidden = false;
  const open = el.querySelector(".peek-open");
  if (open) open.onclick = () => { closePeek(); openPair(aId, bId); };
  el.querySelector(".peek-close").onclick = closePeek;

  const rect = el.getBoundingClientRect();
  const W = canvas.clientWidth, H = canvas.clientHeight;
  let x = Math.min(Math.max(8, px - rect.width / 2), W - rect.width - 8);
  let y = py + 18;
  if (y + rect.height > H - 8) y = Math.max(8, py - rect.height - 18);
  el.style.left = x + "px";
  el.style.top = y + "px";
  announce(`${sum.title}. ${sum.lines.join(". ")}`);
}

function zoomAt(px, py, newCell) {  // px,py = canvas-relative coords of the fixed point
  newCell = Math.max(MIN_CELL, Math.min(80, newCell));
  const before = MARGIN;
  const k = newCell / S.cell;
  const mx = px - before, my = py - before;
  S.tx = mx - (mx - S.tx) * k;
  S.ty = my - (my - S.ty) * k;
  S.cell = newCell;
  // The label gutter grows with the cells; keep the point under the cursor put.
  MARGIN = marginFor(S.cell);
  S.tx -= (MARGIN - before);
  S.ty -= (MARGIN - before);
  clampPan();
  draw();
}
function zoomBy(factor) {
  zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, S.cell * factor);
}

function setupInteraction() {
  // Pointer Events unify mouse + touch: 1 pointer = pan/tap, 2 pointers = pinch-zoom.
  const pts = new Map();            // active pointers: id -> {x, y}
  let mode = null;                  // "pan" | "pinch"
  let downX = 0, downY = 0, moved = false, longPress = null, longFired = false;
  let pinchDist = 0, pinchCell = 0;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const cancelLong = () => { if (longPress) { clearTimeout(longPress); longPress = null; } };

  canvas.addEventListener("pointerdown", e => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      mode = "pan"; downX = e.clientX; downY = e.clientY; moved = false; longFired = false;
      canvas.classList.add("panning");
      if (e.pointerType !== "mouse") {
        // Long-press previews in place, without the zoom a tap would do.
        const r = canvas.getBoundingClientRect();
        const lx = e.clientX - r.left, ly = e.clientY - r.top;
        longPress = setTimeout(() => {
          const rc = cellAt(lx, ly);
          if (rc && !moved) { longFired = true; showPeek(rc, lx, ly); }
        }, 450);
      }
    } else if (pts.size === 2) {
      cancelLong();
      mode = "pinch";
      const [a, b] = [...pts.values()];
      pinchDist = dist(a, b) || 1; pinchCell = S.cell;
    }
  });

  canvas.addEventListener("pointermove", e => {
    const r = canvas.getBoundingClientRect();
    if (!pts.has(e.pointerId)) {                 // hover (mouse only — no button held)
      if (e.pointerType === "mouse") {
        const rc = cellAt(e.clientX - r.left, e.clientY - r.top);
        S.hover = rc;
        if (rc) showTooltip(rc, e.clientX - r.left, e.clientY - r.top); else tooltip.hidden = true;
        draw();
      }
      return;
    }
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (mode === "pinch" && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      zoomAt(cx, cy, pinchCell * (dist(a, b) / pinchDist));
    } else if (mode === "pan") {
      S.tx += e.clientX - prev.x; S.ty += e.clientY - prev.y;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) >= 5) { moved = true; cancelLong(); }
      clampPan(); S.hover = null; tooltip.hidden = true; draw();
    }
  });

  function endPointer(e) {
    cancelLong();
    if (pts.has(e.pointerId)) {
      if (mode === "pan" && pts.size === 1 && !moved && !longFired) {
        const r = canvas.getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        if (e.pointerType === "mouse") {
          const rc = cellAt(px, py);              // a precise device: open it directly
          if (rc) { S.focus = rc; openDetail(rc); } else { closeDetail(); closePeek(); }
        } else {
          // Touch: aim first, commit second. Zoom in if the target is smaller than a fingertip.
          if (S.cell < TAP_LEGIBLE) {
            zoomAt(px, py, TAP_LEGIBLE);
          }
          const rc = cellAt(px, py);
          if (rc) { S.focus = rc; showPeek(rc, px, py); draw(); } else { closePeek(); }
        }
      }
      pts.delete(e.pointerId);
    }
    if (pts.size === 0) { mode = null; canvas.classList.remove("panning"); }
    else if (pts.size === 1) {                  // a finger lifted after a pinch
      mode = "pan"; const p = [...pts.values()][0];
      downX = p.x; downY = p.y; moved = true;   // don't treat the lift as a tap
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", e => {
    if (e.pointerType === "mouse") { S.hover = null; tooltip.hidden = true; draw(); }
  });

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, S.cell * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  setupKeyboard();
}

/* Keyboard access to the grid.

   A canvas is invisible to a keyboard and to a screen reader unless you build the
   navigation yourself: arrow keys walk the cells, the live region reads out whatever the
   focus lands on, and Enter opens the same head-to-head a click would. */
function setupKeyboard() {
  canvas.addEventListener("focus", () => {
    if (!S.focus && S.order.length) {
      S.focus = { r: 0, c: Math.min(1, S.order.length - 1) };
      scrollFocusIntoView();
      announceFocus();
    }
    draw();
  });
  canvas.addEventListener("blur", () => { draw(); });

  canvas.addEventListener("keydown", e => {
    const n = S.order.length;
    if (!n) return;
    const f = S.focus || { r: 0, c: 0 };
    let handled = true;
    switch (e.key) {
      case "ArrowUp": f.r = Math.max(0, f.r - 1); break;
      case "ArrowDown": f.r = Math.min(n - 1, f.r + 1); break;
      case "ArrowLeft": f.c = Math.max(0, f.c - 1); break;
      case "ArrowRight": f.c = Math.min(n - 1, f.c + 1); break;
      case "Home": f.c = 0; break;
      case "End": f.c = n - 1; break;
      case "PageUp": f.r = Math.max(0, f.r - 10); break;
      case "PageDown": f.r = Math.min(n - 1, f.r + 10); break;
      case "Enter": case " ":
        S.focus = f; openDetail(f); break;
      case "+": case "=": zoomBy(1.4); break;
      case "-": case "_": zoomBy(1 / 1.4); break;
      case "f": case "F": fitView(); draw(); break;
      case "Escape": closeDetail(); closePeek(); break;
      default: handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End"
        || e.key.startsWith("Page")) {
      S.focus = f;
      scrollFocusIntoView();
      announceFocus();
    }
    draw();
  });
}

// Keep the keyboard focus on screen, panning the viewport if it has walked off the edge.
function scrollFocusIntoView() {
  if (!S.focus) return;
  const { w, h } = gridArea();
  const x = S.tx + S.focus.c * S.cell, y = S.ty + S.focus.r * S.cell;
  const pad = S.cell * 2;
  if (x < pad) S.tx += pad - x;
  if (x + S.cell > w - pad) S.tx -= (x + S.cell) - (w - pad);
  if (y < pad) S.ty += pad - y;
  if (y + S.cell > h - pad) S.ty -= (y + S.cell) - (h - pad);
  clampPan();
}
function announceFocus() {
  if (!S.focus) return;
  const sum = pairSummary(S.order[S.focus.r], S.order[S.focus.c]);
  announce(`${sum.title}. ${sum.lines.join(". ")}`);
}

/* ---------- match-detail card (lazy-loaded) ---------- */
async function ensureMatches(gender) {
  const g = dataGender(gender);
  if (!S.matches[g]) {
    S.matches[g] = await fetch(`data/matches_${g}.json` + VBUST).then(r => r.json());
  }
  return S.matches[g];
}

let _detailReturnFocus = null;
function closeDetail() {
  const card = $("detail");
  if (!card || card.hidden) return;
  card.hidden = true;
  // Send focus back where it came from; losing it into the void is its own accessibility bug.
  const back = _detailReturnFocus;
  _detailReturnFocus = null;
  if (back && document.contains(back)) { try { back.focus(); } catch { /* ignore */ } }
}

function openDetail(rc) { openPair(S.order[rc.r], S.order[rc.c]); }

function openPair(aId, bId) {
  const A = S.byId.get(aId);
  const B = S.byId.get(bId);
  const card = $("detail");
  if (!A || !B || A.id === B.id) { closeDetail(); return; }
  if (!_detailReturnFocus) {
    _detailReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
  }
  card.hidden = false;
  card.innerHTML =
    `<div class="dh"><div class="dt">${esc(teamLabel(A))} <span class="vs">vs</span> `
    + `${esc(teamLabel(B))}</div>
     <button type="button" class="dx" aria-label="Close" title="Close">&times;</button></div>
     <div class="db dim">Loading match history…</div>`;
  const closeBtn = card.querySelector(".dx");
  closeBtn.onclick = closeDetail;
  closeBtn.focus();
  // token guards against a slow fetch resolving after the user clicked elsewhere
  const token = (card.dataset.token = String(Date.now()) + Math.random());
  const fail = () => {
    const db = card.querySelector(".db");
    if (db && card.dataset.token === token) db.textContent = "Couldn't load match details.";
  };
  const genders = isCombined() ? ["men", "women"] : [dataGender(S.gender)];
  Promise.all(genders.map(ensureMatches))
    .then(datasets => {
      if (card.dataset.token !== token) return;
      const db = card.querySelector(".db");
      if (!db) return;
      db.classList.remove("dim");
      db.innerHTML = genders.length === 1
        ? historyHtml(A, B, datasets[0], genders[0]).html
        : genders.map((g, i) =>
            `<div class="det-gender"><span class="det-label" `
            + `style="color:var(--${g}-only)">${g === "men" ? "Men's" : "Women's"}</span>`
            + `${historyHtml(A, B, datasets[i], g).html}</div>`).join("");
      announce(`${A.name} versus ${B.name}. ${db.textContent.trim().slice(0, 160)}`);
    })
    .catch(fail);
}

const teamLabel = m => (m.flag ? m.flag + " " : "") + m.name;

/* One gender's head-to-head: summary line + newest-first meeting rows.
   The detail card and the combined card are the same renderer; they used to be two copies
   of the same thirty lines. */
function historyHtml(A, B, data, gender) {
  const lo = Math.min(A.id, B.id), hi = Math.max(A.id, B.id);
  const list = data.pairs[`${lo},${hi}`] || [];
  const T = data.tournaments;
  const gLabel = gender === "women" ? " (women's)" : gender === "men" ? " (men's)" : "";
  if (!list.length) {
    return { count: 0, html: `<div class="never">Never played${esc(gLabel)}.</div>` };
  }
  const aIsLo = A.id === lo;
  let w = 0, d = 0, l = 0, gf = 0, ga = 0, unknown = 0;
  const rows = [];
  for (let i = list.length - 1; i >= 0; i--) {          // newest first
    const [yr, glo, ghi, ti] = list[i];
    const known = glo != null && ghi != null;
    const sa = aIsLo ? glo : ghi, sb = aIsLo ? ghi : glo;
    let res = "u";
    if (known) {
      gf += sa; ga += sb;
      res = sa > sb ? "w" : sa < sb ? "l" : "d";
      if (res === "w") w++; else if (res === "l") l++; else d++;
    } else { unknown++; }
    const tn = esc(T[ti] || "");
    rows.push(`<div class="mr ${res}"><span class="yr">${yr == null ? "?" : yr}</span>`
      + `<span class="sc">${known ? `${sa}–${sb}` : "—"}</span>`
      + `<span class="tn" title="${tn}">${tn}</span></div>`);
  }
  const html =
    `<div class="sum"><b>${list.length}</b> ${pl(list.length, "meeting")} · `
    + `<span class="w">${w}W</span> <span class="d">${d}D</span> <span class="l">${l}L</span>`
    + (unknown ? ` <span class="dim">+${unknown}?</span>` : "") + ` · `
    + `<span class="gd">${gf}–${ga}</span> <span class="dim">(${esc(A.name)})</span></div>`
    + `<div class="mlist">${rows.join("")}</div>`;
  return { count: list.length, html };
}

/* ---------- single-team focus (one team manually selected) ---------- */
function renderTeamFocus(teamId) {
  const team = S.byId.get(teamId);
  const panel = $("teamfocus");
  if (!team) { panel.hidden = true; return; }
  const combined = isCombined();

  let pool = S.members.filter(m => m.id !== teamId);
  if (S.includeDefunct) pool = pool.concat(S.defunct.members.filter(m => m.id !== teamId));

  const rows = pool.map(o => {
    const pm = lookup(teamId, o.id, "men"), pw = lookup(teamId, o.id, "women");
    const mc = pm ? pm[0] : 0, wc = pw ? pw[0] : 0;
    if (combined) {
      return { o, mc, wc, total: mc + wc, cat: (mc > 0 ? 1 : 0) | (wc > 0 ? 2 : 0),
               last: Math.max(pm ? pm[2] : 0, pw ? pw[2] : 0) || null };
    }
    const p = lookup(teamId, o.id);
    const n = p ? p[0] : 0;
    return { o, mc, wc, total: n, cat: n ? 1 : 0, last: p ? p[2] : null };
  }).sort((a, b) => b.total - a.total || a.o.name.localeCompare(b.o.name));

  const played = rows.filter(r => r.cat);
  const never = rows.filter(r => !r.cat);
  const maxC = played.length ? played[0].total : 1;
  const catColor = c => c === 3 ? getCss("--both") : c === 1 ? getCss("--men-only")
    : c === 2 ? getCss("--women-only") : getCss("--grid-strong");

  const row = r => {
    const dot = combined ? catColor(r.cat) : confedColor(r.o.confed);
    const title = combined
      ? `men's: ${r.mc || "never"} · women's: ${r.wc || "never"}`
      : `${r.o.confed}${r.total ? ` · ${r.total} ${pl(r.total, "meeting")}` : " · never met"}`;
    return `<button type="button" class="tf-row${r.total ? "" : " none"}" data-opp="${r.o.id}" `
      + `title="${esc(title)}">`
      + `<span class="tf-dot" style="background:${esc(dot)}"></span>`
      + `<span class="tf-name">${esc(teamLabel(r.o))}</span>`
      + `<span class="tf-bar"><span style="width:${Math.round(100 * r.total / maxC)}%"></span></span>`
      + `<span class="tf-n">${r.total || "—"}</span>`
      + `<span class="tf-last">${r.last || ""}</span></button>`;
  };

  const gLabel = genderWord();
  const head = combined
    ? `<div class="tf-title">${esc(teamLabel(team))} — opponents by game played in</div>
       <div class="tf-sum"><b style="color:var(--both)">${played.filter(r => r.cat === 3).length}</b> both ·
         <b style="color:var(--men-only)">${played.filter(r => r.cat === 1).length}</b> men's-only ·
         <b style="color:var(--women-only)">${played.filter(r => r.cat === 2).length}</b> women's-only ·
         <b class="never">${never.length}</b> neither</div>`
    : `<div class="tf-title">${esc(teamLabel(team))} — matchups, most to least played</div>
       <div class="tf-sum">Played <b>${played.length}</b> of ${rows.length} opponents ·
         <b class="never">${never.length}</b> never met · ${esc(gLabel)}</div>`;

  const neverLabel = combined ? "Never met in either" : "Never played";
  panel.innerHTML =
    `<div class="tf-head">${head}</div>`
    + `<div class="tf-list">${played.map(row).join("")}`
    + (never.length ? `<div class="tf-sep">${neverLabel} (${never.length})</div>` : "")
    + `${never.map(row).join("")}</div>`;
  panel.onclick = e => {
    const b = e.target.closest(".tf-row");
    if (b) openPair(teamId, +b.dataset.opp);
  };
  panel.hidden = false;

  const headline = $("headline");
  headline.classList.toggle("combined", combined);
  headline.classList.remove("allplayed");
  if (combined) {
    const both = played.filter(r => r.cat === 3).length;
    headline.innerHTML = `<span class="big">${both}</span>`
      + `<span class="rest">opponents <b>${esc(team.name)}</b> has met in <b>both</b> games — `
      + `${played.filter(r => r.cat === 1).length} men's-only, `
      + `${played.filter(r => r.cat === 2).length} women's-only, ${never.length} never met.</span>`;
  } else if (!played.length) {
    headline.innerHTML = `<span class="big">0</span>`
      + `<span class="rest"><b>${esc(team.name)}</b> has never played a <b>${esc(gLabel)}</b> `
      + `international against anyone.</span>`;
  } else {
    headline.innerHTML = `<span class="big">${never.length}</span>`
      + `<span class="rest">opponents <b>${esc(team.name)}</b> has never played `
      + `(${esc(gLabel)}) — they've met <b>${played.length}</b> of ${rows.length} possible.</span>`;
  }
}

/* ---------- the played graph: adjacency, common opponents, shortest paths ---------- */
/* 211 nodes and ~6,500 edges, so the whole graph fits in a handful of bitset words per
   team. Common-opponent counts for all 15,635 never-played pairs come out in a few ms. */
let _graphCache = null;
function graph(gender = dataGender(S.gender)) {
  if (_graphCache && _graphCache.gender === gender && _graphCache.defunct === S.includeDefunct) {
    return _graphCache;
  }
  const teams = activePool();
  const ids = teams.map(m => m.id);
  const pos = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length, W = Math.ceil(n / 32);
  const bits = new Uint32Array(n * W);
  const adj = ids.map(() => []);
  for (const key of S.pairs[gender].keys()) {
    const comma = key.indexOf(",");
    const a = pos.get(+key.slice(0, comma)), b = pos.get(+key.slice(comma + 1));
    if (a === undefined || b === undefined) continue;
    bits[a * W + (b >> 5)] |= (1 << (b & 31));
    bits[b * W + (a >> 5)] |= (1 << (a & 31));
    adj[a].push(b); adj[b].push(a);
  }
  _graphCache = { gender, defunct: S.includeDefunct, ids, pos, n, W, bits, adj };
  return _graphCache;
}
function popcount(v) {
  v = v - ((v >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}
function commonOpponents(g, a, b) {
  let total = 0;
  for (let w = 0; w < g.W; w++) total += popcount(g.bits[a * g.W + w] & g.bits[b * g.W + w]);
  return total;
}
// Shortest chain of actual matches from one team to another.
function shortestPath(g, fromId, toId) {
  const s = g.pos.get(fromId), t = g.pos.get(toId);
  if (s === undefined || t === undefined) return null;
  if (s === t) return [fromId];
  const prev = new Int32Array(g.n).fill(-1);
  const seen = new Uint8Array(g.n);
  seen[s] = 1;
  let frontier = [s];
  while (frontier.length) {
    const next = [];
    for (const u of frontier) {
      for (const v of g.adj[u]) {
        if (seen[v]) continue;
        seen[v] = 1; prev[v] = u;
        if (v === t) {
          const path = [];
          for (let k = t; k !== -1; k = prev[k]) path.push(g.ids[k]);
          return path.reverse();
        }
        next.push(v);
      }
    }
    frontier = next;
  }
  return null;
}

/* ---------- list views ---------- */
function daysUntil(iso) {
  const d = new Date(iso + "T00:00:00"), now = new Date(S.today + "T00:00:00");
  return Math.round((d - now) / 86400000);
}
function countdown(iso) {
  const n = daysUntil(iso);
  if (n < 0) return { text: `${-n}d ago`, cls: "past" };
  if (n === 0) return { text: "today", cls: "now" };
  if (n === 1) return { text: "tomorrow", cls: "now" };
  if (n < 31) return { text: `in ${n} days`, cls: "soon" };
  if (n < 365) return { text: `in ${Math.round(n / 30)} months`, cls: "" };
  return { text: `in ${(n / 365).toFixed(1)} years`, cls: "" };
}
const fmtDate = iso =>
  new Date(iso + "T00:00:00").toLocaleDateString(undefined,
    { year: "numeric", month: "short", day: "numeric" });

function pairRowHtml(aId, bId, right, cls = "") {
  const A = S.byId.get(aId), B = S.byId.get(bId);
  if (!A || !B) return "";
  // The "v" travels with the second team, so a row that wraps on a narrow screen breaks
  // as "Montserrat" / "v Turks and Caicos Islands" instead of stranding the separator.
  return `<button type="button" class="lv-row ${cls}" data-a="${aId}" data-b="${bId}">`
    + `<span class="lv-teams"><span class="lv-t">${esc(teamLabel(A))}</span>`
    + `<span class="lv-t"><span class="lv-v">v</span> ${esc(teamLabel(B))}</span></span>`
    + `<span class="lv-right">${right}</span></button>`;
}
function wireRows(host) {
  host.onclick = e => {
    const b = e.target.closest(".lv-row");
    if (b) openPair(+b.dataset.a, +b.dataset.b);
  };
}

/* Fixtures — the feed. Every pair of nations with a date on the calendar and no history. */
function renderFixtures() {
  const host = $("view-fixtures");
  const cut = new Date(S.today + "T00:00:00"); cut.setDate(cut.getDate() - 14);
  const cutoff = cut.toISOString().slice(0, 10);
  const groups = [];
  for (const g of ["men", "women"]) {
    const items = [];
    for (const [key, [date, tourn]] of S.upcoming[g]) {
      if (date < cutoff) continue;                 // drop stale / abandoned fixtures
      const [lo, hi] = key.split(",").map(Number);
      if (!S.byId.has(lo) || !S.byId.has(hi)) continue;
      items.push({ lo, hi, date, tourn, future: date >= S.today });
    }
    items.sort((a, b) => a.date.localeCompare(b.date));
    if (items.length) groups.push({ g, items });
  }

  const total = groups.reduce((n, gr) => n + gr.items.filter(i => i.future).length, 0);
  if (!total && !groups.length) {
    host.innerHTML = `<div class="lv-empty"><p>No first-ever meetings are on the calendar
      right now.</p><p class="hint">Fixtures come from martj42's advance listings and ESPN's
      scoreboard, up to two years out.</p></div>`;
    return;
  }

  host.innerHTML =
    `<div class="lv-head">
       <h2>Never met. Scheduled to.</h2>
       <p>Every pairing below would be a first meeting in ${esc(S.meta.dataThrough.men ? "the history of the game" : "the record")} —
          two national teams that have never played each other, with a date.
          <a href="feed.xml">Subscribe by RSS</a> or <a href="feed.json">JSON</a>.</p>
     </div>`
    + groups.map(gr =>
      `<div class="lv-group"><h3>${gr.g === "men" ? "Men's" : "Women's"}
         <span class="hint">${gr.items.filter(i => i.future).length} upcoming</span></h3>`
      + gr.items.map(it => {
        const cd = countdown(it.date);
        return pairRowHtml(it.lo, it.hi,
          `<span class="lv-when ${cd.cls}">${esc(cd.text)}</span>`
          + `<span class="lv-sub">${esc(fmtDate(it.date))} · ${esc(it.tourn)}</span>`,
          it.future ? "" : "pending");
      }).join("")
      + `</div>`).join("");
  wireRows(host);
}

/* One-offs — pairs that met exactly once and never again. */
function renderOneOffs() {
  const host = $("view-oneoffs");
  const g = dataGender(S.gender);
  const rows = [];
  for (const [key, [count, fy]] of S.pairs[g]) {
    if (count !== 1) continue;
    const [lo, hi] = key.split(",").map(Number);
    if (!S.byId.has(lo) || !S.byId.has(hi)) continue;
    rows.push({ lo, hi, year: fy });
  }
  rows.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
  const shown = rows.slice(0, 300);

  host.innerHTML =
    `<div class="lv-head">
       <h2>Played once. Never again.</h2>
       <p><b>${num(rows.length)}</b> ${esc(genderWord())} ${pl(rows.length, "pairing")} have met
          exactly once in the whole history of the fixture list — oldest first, so the top of
          this list is the longest either side has gone without a rematch.</p>
     </div>`
    + `<div class="lv-group">`
    + shown.map(r => pairRowHtml(r.lo, r.hi,
        `<span class="lv-when">${r.year ?? "?"}</span>`
        + `<span class="lv-sub">${esc(yearsAgo(r.year))}</span>`)).join("")
    + `</div>`
    + (rows.length > shown.length
      ? `<p class="lv-more">Showing the ${shown.length} oldest of ${num(rows.length)}.</p>` : "");
  wireRows(host);
}
function yearsAgo(year) {
  if (year == null) return "";
  const n = new Date().getFullYear() - year;
  return n <= 0 ? "this year" : `${n} ${pl(n, "year")} ago`;
}

/* Near misses — never played, but they keep almost meeting.
   Ranked by shared opponents, which is a real graph measure rather than a hunch: two teams
   with fifty opponents in common and no meeting between them are genuinely circling. */
function renderMisses() {
  const host = $("view-misses");
  const g = graph();
  const gender = dataGender(S.gender);
  const out = [];
  for (let a = 0; a < g.n; a++) {
    for (let b = a + 1; b < g.n; b++) {
      const aId = g.ids[a], bId = g.ids[b];
      if (S.pairs[gender].has(pairKey(aId, bId))) continue;   // they have met
      const shared = commonOpponents(g, a, b);
      if (shared < 8) continue;
      const A = S.byId.get(aId), B = S.byId.get(bId);
      out.push({ aId, bId, shared, same: A.confed === B.confed });
    }
  }
  // Ranked on the number the row actually shows. A hidden bonus for same-confederation
  // pairs made the visible column read as unsorted (73, 68, 67, 64, 73 …), which looks
  // like a bug however defensible the weighting is; confederation is the tie-break and
  // is on the row for the reader to weigh themselves.
  out.sort((x, y) => y.shared - x.shared
    || (y.same ? 1 : 0) - (x.same ? 1 : 0)
    || S.byId.get(x.aId).name.localeCompare(S.byId.get(y.aId).name));
  const shown = out.slice(0, 120);

  host.innerHTML =
    `<div class="lv-head">
       <h2>Closest to happening.</h2>
       <p>Pairs that have <b>never</b> played each other, ranked by how many opponents they
          <i>have</i> in common. Nothing here is scheduled — this is the list of fixtures that
          keep not happening. ${esc(genderWord())} archive.</p>
     </div><div class="lv-group">`
    + shown.map(r => pairRowHtml(r.aId, r.bId,
        `<span class="lv-when">${r.shared}</span>`
        + `<span class="lv-sub">shared opponents${r.same
          ? ` · both ${esc(S.byId.get(r.aId).confed)}` : ""}</span>`)).join("")
    + `</div>`;
  wireRows(host);
}

/* Connect — the shortest chain of real matches between any two teams. */
function renderPath() {
  const host = $("view-path");
  const pool = activePool().slice().sort((a, b) => a.name.localeCompare(b.name));
  const g = graph();
  if (S.path.a == null || !g.pos.has(S.path.a)) {
    S.path.a = (pool.find(m => m.name === "Tonga") || pool[0]).id;
  }
  if (S.path.b == null || !g.pos.has(S.path.b)) {
    S.path.b = (pool.find(m => m.name === "Brazil") || pool[pool.length - 1]).id;
  }
  const opts = sel => pool.map(m =>
    `<option value="${m.id}"${m.id === sel ? " selected" : ""}>${esc(m.name)}</option>`).join("");

  const path = shortestPath(g, S.path.a, S.path.b);
  let body;
  if (!path) {
    body = `<div class="lv-empty"><p>No chain of matches connects these two in the
      ${esc(genderWord())} archive — at least one of them has never played anyone.</p></div>`;
  } else if (path.length === 1) {
    body = `<div class="lv-empty"><p>Pick two different teams.</p></div>`;
  } else {
    const hops = [];
    for (let i = 0; i < path.length - 1; i++) {
      const p = lookup(path[i], path[i + 1]);
      hops.push(pairRowHtml(path[i], path[i + 1],
        `<span class="lv-when">${p ? p[0] : 0}</span>`
        + `<span class="lv-sub">${pl(p ? p[0] : 0, "meeting")}${p && p[2] ? ` · last ${p[2]}` : ""}</span>`));
    }
    const degrees = path.length - 1;
    body = `<p class="path-sum"><b>${degrees}</b> ${pl(degrees, "degree")} of separation.</p>`
      + `<div class="lv-group">${hops.join("")}</div>`;
  }

  host.innerHTML =
    `<div class="lv-head">
       <h2>How far apart are any two teams?</h2>
       <p>The shortest chain of matches that have actually been played, from one national
          team to another.</p>
       <div class="path-pick">
         <label class="sr-only" for="path-a">From</label>
         <select id="path-a">${opts(S.path.a)}</select>
         <span class="path-arrow">→</span>
         <label class="sr-only" for="path-b">To</label>
         <select id="path-b">${opts(S.path.b)}</select>
       </div>
     </div>${body}`;
  wireRows(host);
  $("path-a").onchange = e => { S.path.a = +e.target.value; renderPath(); updateHeadline(); writeUrl(); };
  $("path-b").onchange = e => { S.path.b = +e.target.value; renderPath(); updateHeadline(); writeUrl(); };
}

/* ---------- headline ---------- */
function updateStats() { updateHeadline(); }

function updateHeadline() {
  const headline = $("headline");
  headline.classList.remove("allplayed", "combined");
  if (S.view === "fixtures") return headlineFixtures(headline);
  if (S.view === "oneoffs") return headlineOneOffs(headline);
  if (S.view === "misses") return headlineMisses(headline);
  if (S.view === "path") return headlinePath(headline);
  if (S.manual.size === 1) return;                 // team focus writes its own
  return isCombined() ? headlineCombined(headline) : headlineGrid(headline);
}

function headlineGrid(headline) {
  const { total } = metCounts();
  const met = S.gender === "men" ? metCounts().men : metCounts().women;
  const never = total - met;
  const g = genderWord();
  const filter = (S.manual.size || S.showConfeds.size < S.confedOrder.length) ? " in this view" : "";
  const scope = present() ? filter : `${filter} by ${S.year}`;

  if (total === 0) {                       // fewer than two teams to compare
    headline.innerHTML = `<span class="big">—</span>`
      + `<span class="rest">Pick at least two teams or confederations to compare.</span>`;
  } else if (never === 0) {                 // every possible matchup has happened
    headline.classList.add("allplayed");
    headline.innerHTML = `<span class="big">100%</span>`
      + `<span class="rest">every one of the ${num(total)} possible <b>${esc(g)}</b> `
      + `${pl(total, "matchup")}${esc(scope)} has been played — no unplayed pairings here.</span>`;
  } else {
    const pct = 100 * met / total;
    headline.innerHTML = `<span class="big">${num(never)}</span>`
      + `<span class="rest"><b>${esc(g)}</b> ${pl(never, "matchup")} ${never === 1 ? "has" : "have"} `
      + `<b>never</b> been played${esc(scope)} — just <b>${pct.toFixed(1)}%</b> of the `
      + `${num(total)} possible ${pl(total, "pairing")} `
      + `${total === 1 ? "has" : "have"} ever happened.</span>`;
  }
}

function headlineCombined(headline) {
  const c = metCounts();
  headline.classList.add("combined");
  if (c.total === 0) {
    headline.innerHTML = `<span class="big">—</span>`
      + `<span class="rest">Pick at least two teams or confederations to compare.</span>`;
    return;
  }
  const menOnly = c.men - c.both, womenOnly = c.women - c.both;
  const neither = c.total - c.both - menOnly - womenOnly;
  const filter = (S.manual.size || S.showConfeds.size < S.confedOrder.length) ? " in this view" : "";
  const scope = present() ? filter : `${filter} as of ${S.year}`;
  headline.innerHTML =
    `<span class="big">${num(c.both)}</span>`
    + `<span class="rest">${pl(c.both, "pairing")} ${c.both === 1 ? "has" : "have"} met in `
    + `<b>both</b> the men's and women's game${esc(scope)} — `
    + `<b style="color:var(--men-only)">${num(menOnly)}</b> men's-only, `
    + `<b style="color:var(--women-only)">${num(womenOnly)}</b> women's-only, `
    + `${num(neither)} in neither, of ${num(c.total)} possible.</span>`;
}

function headlineFixtures(headline) {
  let soonest = null, n = 0;
  for (const g of ["men", "women"]) {
    for (const [, [date]] of S.upcoming[g]) {
      if (date < S.today) continue;
      n++;
      if (!soonest || date < soonest) soonest = date;
    }
  }
  if (!n) {
    headline.innerHTML = `<span class="big">0</span>`
      + `<span class="rest">first-ever meetings are on the calendar right now.</span>`;
    return;
  }
  const cd = countdown(soonest);
  headline.innerHTML = `<span class="big">${n}</span>`
    + `<span class="rest">${pl(n, "pairing")} that ${n === 1 ? "has" : "have"} <b>never</b> met `
    + `${n === 1 ? "is" : "are"} scheduled to — the next one <b>${esc(cd.text)}</b>.</span>`;
}

function headlineOneOffs(headline) {
  const g = dataGender(S.gender);
  let n = 0, oldest = null;
  for (const [, [count, fy]] of S.pairs[g]) {
    if (count !== 1) continue;
    n++;
    if (fy != null && (oldest == null || fy < oldest)) oldest = fy;
  }
  headline.innerHTML = `<span class="big">${num(n)}</span>`
    + `<span class="rest"><b>${esc(genderWord())}</b> ${pl(n, "pairing")} have played `
    + `<b>exactly once</b>${oldest ? ` — the oldest still-unrepeated fixture was in <b>${oldest}</b>` : ""}.</span>`;
}

function headlineMisses(headline) {
  headline.innerHTML = `<span class="big">?</span>`
    + `<span class="rest">Pairs that have <b>never</b> met, ranked by how many opponents they `
    + `already share.</span>`;
  const host = $("view-misses");
  const first = host && host.querySelector(".lv-row .lv-when");
  if (first) {
    headline.innerHTML = `<span class="big">${esc(first.textContent)}</span>`
      + `<span class="rest">opponents in common — and still no meeting between them. `
      + `The ${esc(genderWord())} fixtures that keep not happening.</span>`;
  }
}

function headlinePath(headline) {
  const g = graph();
  const path = (S.path.a != null && S.path.b != null)
    ? shortestPath(g, S.path.a, S.path.b) : null;
  const A = S.byId.get(S.path.a), B = S.byId.get(S.path.b);
  if (!path || path.length < 2 || !A || !B) {
    headline.innerHTML = `<span class="big">—</span>`
      + `<span class="rest">Pick two teams to connect through matches actually played.</span>`;
    return;
  }
  const d = path.length - 1;
  headline.classList.add("allplayed");
  headline.innerHTML = `<span class="big">${d}</span>`
    + `<span class="rest">${pl(d, "degree")} of separation between <b>${esc(A.name)}</b> and `
    + `<b>${esc(B.name)}</b> in the ${esc(genderWord())} record.</span>`;
}

/* ---------- views ---------- */
function defaultView() {
  const anyFixtures = S.upcoming.men.size + S.upcoming.women.size > 0;
  // On a phone the 211-column grid is something you deliberately zoom into, not a landing
  // page. Lead with the feed — unless there is nothing in it.
  return (mqMobile.matches && anyFixtures) ? "fixtures" : "grid";
}

function applyView(view, { push = true, focus = true } = {}) {
  if (!VIEWS.includes(view)) view = "grid";
  S.view = view;
  for (const v of VIEWS) {
    const el = $(`view-${v}`);
    if (el) el.hidden = v !== view;
  }
  document.querySelectorAll("#views button").forEach(b => {
    const on = b.dataset.view === view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  document.body.dataset.view = view;
  // Timeline, legend and the grid-only toggles belong to the grid.
  const gridOnly = view === "grid";
  const timeline = $("timeline");
  if (timeline) timeline.hidden = !gridOnly;
  const legend = $("legend");
  if (legend) legend.hidden = !gridOnly;
  for (const id of ["opt-highlight", "opt-upcoming"]) {
    const el = $(id);
    if (el) el.hidden = !gridOnly;
  }
  if (view === "fixtures") renderFixtures();
  if (view === "oneoffs") renderOneOffs();
  if (view === "misses") renderMisses();
  if (view === "path") renderPath();
  if (gridOnly) { resize(); clampPan(); draw(); }
  updateHeadline();
  if (focus) {
    const tab = document.querySelector(`#views button[data-view="${view}"]`);
    if (tab) tab.focus();
  }
  if (push) writeUrl();
}

/* ---------- URL state ----------
   Every choice on the page is in the query string, so a view can be linked, bookmarked and
   screenshotted with its caption intact. replaceState, not pushState: scrubbing a year
   should not bury the back button under two hundred history entries. */
let _urlTimer = null;
function writeUrl() {
  clearTimeout(_urlTimer);
  _urlTimer = setTimeout(() => {
    const p = new URLSearchParams();
    if (S.view !== "grid") p.set("view", S.view);
    if (S.gender !== "men") p.set("g", S.gender);
    if (S.sort !== "confed") p.set("sort", S.sort);
    if (S.showConfeds.size < S.confedOrder.length) {
      p.set("confed", [...S.showConfeds].join(",") || "none");
    }
    if (S.manual.size) p.set("teams", [...S.manual].join(","));
    if (!present()) p.set("year", String(S.year));
    if (S.highlightNever) p.set("never", "1");
    if (S.showUpcoming) p.set("up", "1");
    if (S.includeDefunct) p.set("defunct", "1");
    if (S.view === "path" && S.path.a != null && S.path.b != null) {
      p.set("path", `${S.path.a},${S.path.b}`);
    }
    const qs = p.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }, 200);
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  const ids = key => (p.get(key) || "").split(",").map(Number).filter(Number.isFinite);

  const g = p.get("g");
  if (g === "men" || g === "women" || g === "both") S.gender = g;
  const sort = p.get("sort");
  if (["confed", "rank", "matches", "alpha"].includes(sort)) S.sort = sort;
  if (p.has("confed")) {
    const raw = p.get("confed");
    S.showConfeds = new Set(raw === "none" ? []
      : raw.split(",").filter(c => S.confedOrder.includes(c)));
  }
  if (p.has("teams")) S.manual = new Set(ids("teams").filter(id => S.byId.has(id)));
  S.includeDefunct = p.get("defunct") === "1";
  S.highlightNever = p.get("never") === "1";
  S.showUpcoming = p.get("up") === "1";
  const year = Number(p.get("year"));
  if (Number.isFinite(year) && year >= YEAR_MIN && year <= S.maxYear) S.year = year;
  if (p.has("path")) {
    const [a, b] = ids("path");
    if (S.byId.has(a)) S.path.a = a;
    if (S.byId.has(b)) S.path.b = b;
  }
  S.view = VIEWS.includes(p.get("view")) ? p.get("view") : defaultView();
  // ?pair=lo,hi deep-links straight to a head-to-head (the feed's links use it).
  const pair = ids("pair");
  if (pair.length === 2 && S.byId.has(pair[0]) && S.byId.has(pair[1])) {
    setTimeout(() => openPair(pair[0], pair[1]), 0);
  }
}

/* ---------- timeline ---------- */
function setYearLabel() {
  const el = $("year-label");
  if (el) el.textContent = present() ? `present (${S.maxYear})` : `${S.year}`;
}
function setYear(y, { redraw = true } = {}) {
  S.year = Math.max(YEAR_MIN, Math.min(S.maxYear, y));
  const scrub = $("year-scrub");
  if (scrub && +scrub.value !== S.year) scrub.value = String(S.year);
  setYearLabel();
  updateStats();
  if (redraw) draw();
  writeUrl();
  // Exact per-year counts are only needed by tooltips; fetch them in the background so
  // the grid never waits on a download to move.
  if (!present() && !countsExact()) ensureYearsForView().then(() => { if (S.hover) draw(); });
}

let _playRaf = null, _playLast = 0;
function stopPlay() {
  S.playing = false;
  if (_playRaf) cancelAnimationFrame(_playRaf);
  _playRaf = null;
  const btn = $("year-play");
  if (btn) { btn.innerHTML = "&#9654;"; btn.setAttribute("aria-label", "Play the timeline"); }
}
function togglePlay() {
  if (S.playing) return stopPlay();
  S.playing = true;
  const btn = $("year-play");
  if (btn) { btn.innerHTML = "&#10073;&#10073;"; btn.setAttribute("aria-label", "Pause the timeline"); }
  if (present()) setYear(YEAR_MIN, { redraw: false });
  _playLast = 0;
  const step = ts => {
    if (!S.playing) return;
    if (!_playLast) _playLast = ts;
    // ~14 years a second: slow enough to watch a confederation appear, quick enough that
    // 150 years takes about ten seconds.
    const years = Math.floor((ts - _playLast) / 70);
    if (years) {
      _playLast = ts;
      const next = S.year + years;
      if (next >= S.maxYear) { setYear(S.maxYear); return stopPlay(); }
      setYear(next);
    }
    _playRaf = requestAnimationFrame(step);
  };
  _playRaf = requestAnimationFrame(step);
}

/* On mobile the controls sit below the grid, so move the timeline scrubber up into the stage
   (right under the headline, above the grid) so you can scrub and see the grid change at once. */
let _timelineHome = null;
function placeTimeline() {
  const timeline = $("timeline");
  if (!timeline) return;
  if (!_timelineHome) _timelineHome = { parent: timeline.parentNode, next: timeline.nextSibling };
  if (mqMobile.matches) $("timeline-slot").appendChild(timeline);
  else _timelineHome.parent.insertBefore(timeline, _timelineHome.next);
}

/* ---------- controls ---------- */
// A roving-tabindex tab strip: one stop in the tab order, arrow keys between the options.
function wireTabs(container, onPick) {
  const buttons = [...container.querySelectorAll("button")];
  buttons.forEach((btn, i) => {
    btn.addEventListener("click", () => onPick(btn));
    btn.addEventListener("keydown", e => {
      const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      const next = buttons[(i + delta + buttons.length) % buttons.length];
      next.focus();
      onPick(next);
    });
  });
}

function setGender(gender) {
  S.gender = gender;
  document.querySelectorAll("#gender button").forEach(b => {
    const on = b.dataset.gender === gender;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  // The never/upcoming highlights are single-dataset concepts; combined has its own key.
  for (const id of ["opt-highlight", "opt-upcoming"]) {
    const el = $(id);
    if (el) el.disabled = isCombined();
  }
  _graphCache = null;
  buildTeamList();           // refresh the rank shown per gender
  updateUpcomingCount();
  updateLegend();
  if (S.view !== "grid") applyView(S.view, { push: false, focus: false });
  recompute(false);
}

function buildControls() {
  wireTabs($("gender"), btn => setGender(btn.dataset.gender));
  wireTabs($("views"), btn => applyView(btn.dataset.view));
  setGender(S.gender);

  const sortSel = $("sort");
  sortSel.value = S.sort;
  sortSel.addEventListener("change", e => { S.sort = e.target.value; recompute(true); });

  // confederation checkboxes
  const counts = {};
  for (const m of S.members) counts[m.confed] = (counts[m.confed] || 0) + 1;
  const cl = $("confed-list");
  cl.innerHTML = "";
  for (const cf of S.confedOrder) {
    const lab = document.createElement("label");
    lab.innerHTML = `<span class="dot" style="background:${esc(confedColor(cf))}"></span>
      <input type="checkbox" ${S.showConfeds.has(cf) ? "checked" : ""} data-confed="${esc(cf)}"> ${esc(cf)}
      <span class="cnt">${counts[cf] || 0}</span>`;
    cl.appendChild(lab);
  }
  cl.addEventListener("change", e => {
    const cb = e.target.closest("input"); if (!cb) return;
    if (cb.checked) S.showConfeds.add(cb.dataset.confed);
    else S.showConfeds.delete(cb.dataset.confed);
    _graphCache = null;
    recompute(true);
  });
  $("confed-all").onclick = () => toggleConfeds(true);
  $("confed-none").onclick = () => toggleConfeds(false);

  // stage toolbar toggles
  const toggle = (id, get, set) => {
    const el = $(id);
    el.setAttribute("aria-pressed", get() ? "true" : "false");
    el.classList.toggle("on", get());
    el.onclick = () => {
      set(!get());
      el.setAttribute("aria-pressed", get() ? "true" : "false");
      el.classList.toggle("on", get());
      draw();
      writeUrl();
    };
  };
  toggle("opt-highlight", () => S.highlightNever, v => { S.highlightNever = v; });
  toggle("opt-upcoming", () => S.showUpcoming, v => { S.showUpcoming = v; });

  $("opt-defunct").checked = S.includeDefunct;
  $("opt-defunct").onchange = e => {
    S.includeDefunct = e.target.checked;
    _graphCache = null;
    buildTeamList();
    recompute(true);
  };
  updateUpcomingCount();

  // theme
  $("theme").onclick = () => {
    applyTheme(currentTheme() === "light" ? "dark" : "light");
    updateLegend();
    draw();
  };

  // share
  const shareBtn = $("share");
  shareBtn.onclick = async () => {
    const url = location.href;
    try {
      if (navigator.share && mqMobile.matches) {
        await navigator.share({ title: document.title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      const was = shareBtn.textContent;
      shareBtn.textContent = "Copied";
      announce("Link copied to the clipboard.");
      setTimeout(() => { shareBtn.textContent = was; }, 1600);
    } catch {
      // Clipboard denied (or share dismissed): the URL bar already holds the same link.
      announce("Copy the address bar to share this view.");
    }
  };

  // timeline scrubber
  const scrub = $("year-scrub");
  scrub.min = YEAR_MIN; scrub.max = S.maxYear;
  scrub.value = String(present() ? S.maxYear : S.year);
  setYearLabel();
  scrub.addEventListener("input", e => { stopPlay(); setYear(+e.target.value); });
  const play = $("year-play");
  play.onclick = togglePlay;
  if (mqReduceMotion.matches) play.title = "Play the timeline (motion is reduced in your settings)";

  // manual team list
  $("manual-clear").onclick = () => {
    S.manual.clear();
    document.querySelectorAll("#team-list input").forEach(i => { i.checked = false; });
    recompute(true);
  };
  $("team-search").addEventListener("input", buildTeamList);
  buildTeamList();

  // zoom controls (viewpane)
  $("zoom-in").onclick = () => zoomBy(1.4);
  $("zoom-out").onclick = () => zoomBy(1 / 1.4);
  $("zoom-fit").onclick = () => { fitView(); draw(); };

  // meta / provenance
  const dt = S.meta.dataThrough || {};
  const fmt = iso => iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short" }) : "?";
  $("meta").innerHTML =
    `${S.members.length} current FIFA members · matches through <b>${esc(fmt(dt.men))}</b> (men) / `
    + `<b>${esc(fmt(dt.women))}</b> (women) · rankings ${esc(S.meta.rankingMen || "—")}, `
    + `${esc(S.meta.rankingWomen || "—")}.`;

  placeTimeline();
  mqMobile.addEventListener("change", () => {
    placeTimeline(); resize(); clampPan(); draw();
  });
}

function toggleConfeds(on) {
  S.showConfeds = on ? new Set(S.confedOrder) : new Set();
  document.querySelectorAll("#confed-list input").forEach(i => { i.checked = on; });
  _graphCache = null;
  recompute(true);
}

function buildTeamList() {
  const q = $("team-search").value.trim().toLowerCase();
  const list = $("team-list");
  let pool = S.members.slice();
  if (S.includeDefunct) pool = pool.concat(S.defunct.members);
  pool.sort((a, b) => a.name.localeCompare(b.name));
  list.innerHTML = "";
  for (const m of pool) {
    if (q && !m.name.toLowerCase().includes(q)) continue;
    const lab = document.createElement("label");
    const r = isCombined() ? rankOf(m) : (S.gender === "men" ? m.mens_rank : m.womens_rank);
    const rk = (r && r !== Infinity) ? `#${r}` : (m.defunct ? "defunct" : "unranked");
    lab.innerHTML = `<input type="checkbox" data-id="${m.id}" ${S.manual.has(m.id) ? "checked" : ""}>
      ${esc(teamLabel(m))} <span class="rk">${esc(m.confed)} ${esc(rk)}</span>`;
    list.appendChild(lab);
  }
  list.onchange = e => {
    const cb = e.target.closest("input"); if (!cb) return;
    const id = +cb.dataset.id;
    if (cb.checked) S.manual.add(id); else S.manual.delete(id);
    if (S.view !== "grid") applyView("grid", { focus: false });
    recompute(true);
  };
}

function updateUpcomingCount() {
  const el = $("upcoming-count");
  if (!el) return;
  if (isCombined()) { el.textContent = ""; return; }
  const n = [...S.upcoming[S.gender].values()].filter(([d]) => d >= S.today).length;
  el.textContent = n ? `${n}` : "";
  const pip = $("views-fixtures-pip");
  if (pip) {
    const all = ["men", "women"].reduce((t, g) =>
      t + [...S.upcoming[g].values()].filter(([d]) => d >= S.today).length, 0);
    pip.textContent = all ? String(all) : "";
    pip.hidden = !all;
  }
}

/* ---------- boot ---------- */
applyTheme(preferredTheme(), false);
window.addEventListener("keydown", e => {
  if (e.key === "Escape") { closeDetail(); closePeek(); }
});
window.addEventListener("resize", () => { resize(); clampPan(); draw(); });
window.addEventListener("popstate", () => {
  readUrl();
  setGender(S.gender);
  applyView(S.view, { push: false, focus: false });
  recompute(true);
});
resize();
setupInteraction();
load().catch(err => {
  const el = $("loading");
  if (el) el.textContent = "Failed to load data: " + err.message;
  console.error(err);
});
