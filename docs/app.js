"use strict";

/* National Team Matchup Grid — Scorigami-style heatmap of international football fixtures.
   Vanilla JS + Canvas. Loads pre-built JSON from data/ and renders an N×N grid where each
   cell is a pair of national teams, coloured by how many times they have met. */

const CONFED_COLOR = {
  AFC: "#e0524d", CAF: "#37b98a", CONCACAF: "#e6b54a",
  CONMEBOL: "#4f8fd0", OFC: "#b07a52", UEFA: "#9a6ad6",
};
let MARGIN = 116;                    // px reserved for labels + confederation band (set in resize)
const BAND = 13;                     // px confederation colour strip at outer edge

const S = {
  members: [],                       // current FIFA members
  defunct: { members: [], pairs_men: [], pairs_women: [] },
  byId: new Map(),
  confedOrder: [],
  pairs: { men: new Map(), women: new Map() },
  maxCount: { men: 1, women: 1 },
  matches: { men: null, women: null },   // per-meeting detail, lazy-loaded on first click
  upcoming: { men: new Map(), women: new Map() }, // scheduled first meetings (key -> [date, tourn])
  yearsByPair: { men: null, women: null }, // key -> sorted meeting years (built from matches)
  meta: {},
  // view options
  gender: "men",
  sort: "confed",                    // "confed" | "rank" | "alpha"
  showConfeds: new Set(),
  manual: new Set(),
  includeDefunct: false,
  highlightNever: false,
  showUpcoming: false,               // highlight upcoming first meetings in yellow
  today: "",                         // client's current date (YYYY-MM-DD), set on load
  year: null,                        // scrubber: show grid as of this year (null = present)
  maxYear: 2026,
  // ordered ids currently displayed
  order: [],
  // viewport: on-screen cell size (px) + pan offset
  cell: 20, tx: 0, ty: 0,
  hover: null,                       // {r, c}
};

const canvas = document.getElementById("grid");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");
const canvasWrap = document.getElementById("canvas-wrap");
let DPR = window.devicePixelRatio || 1;
// Per-day cache-buster: data refreshes daily, so re-fetch fresh once a day (cached within the day).
const VBUST = "?d=" + new Date().toISOString().slice(0, 10);

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

  document.getElementById("loading").remove();
  buildControls();
  drawLegend();
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

function lookup(a, b) {
  if (a === b) return null;
  const k = a < b ? `${a},${b}` : `${b},${a}`;
  return S.pairs[S.gender].get(k) || null;
}

function present() { return S.year == null || S.year >= S.maxYear; }

function pairKey(a, b) { return a < b ? `${a},${b}` : `${b},${a}`; }

// Number of meetings as of the scrubber year (== total at present).
function countAsOf(a, b) {
  if (a === b) return 0;
  const k = pairKey(a, b);
  if (present()) { const p = S.pairs[S.gender].get(k); return p ? p[0] : 0; }
  const ys = S.yearsByPair[S.gender];
  if (!ys) { const p = S.pairs[S.gender].get(k); return p ? p[0] : 0; }  // not loaded yet
  const arr = ys.get(k);
  if (!arr) return 0;
  let lo = 0, hi = arr.length;                          // count years <= S.year (arr sorted asc)
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= S.year) lo = m + 1; else hi = m; }
  return lo;
}

function upcomingInfo(a, b) { return S.upcoming[S.gender].get(pairKey(a, b)) || null; }

// A scheduled first meeting still in the future (or today) per the client's clock.
function isUpcoming(a, b) { const u = upcomingInfo(a, b); return !!u && u[0] >= S.today; }

// Build per-pair sorted meeting-year arrays from the (lazy-loaded) match detail.
async function ensureYears(gender) {
  if (S.yearsByPair[gender]) return;
  const data = await ensureMatches(gender);
  const m = new Map();
  for (const k in data.pairs) m.set(k, data.pairs[k].map(x => x[0]).filter(y => y != null));
  S.yearsByPair[gender] = m;
}

/* ---------- ordering ---------- */
function rankOf(m) {
  const r = S.gender === "men" ? m.mens_rank : m.womens_rank;
  return r == null ? Infinity : r;
}

function recompute(fit) {
  closeDetail();

  // One team manually selected -> show that team's matchups ranked most-to-least played,
  // instead of a useless 1x1 grid. Two or more -> fall back to a normal sub-grid.
  if (S.manual.size === 1) {
    renderTeamFocus([...S.manual][0]);
    canvasWrap.classList.add("focus");
    return;
  }
  document.getElementById("teamfocus").hidden = true;
  canvasWrap.classList.remove("focus");

  let base = S.members.slice();
  if (S.includeDefunct) base = base.concat(S.defunct.members);

  let active;
  if (S.manual.size) active = base.filter(m => S.manual.has(m.id));
  else active = base.filter(m => S.showConfeds.has(m.confed));

  active.sort((a, b) => {
    if (S.sort === "alpha") return a.name.localeCompare(b.name);
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
  if (fit) fitView(); else clampPan();
  updateStats();
  const lm = document.getElementById("legend-max");
  if (lm) lm.textContent = `1 → ${S.maxCount[S.gender]}`;
  draw();
}

/* ---------- viewport ---------- */
function gridArea() { return { w: canvas.clientWidth - MARGIN, h: canvas.clientHeight - MARGIN }; }

function fitView() {
  const n = S.order.length || 1;
  const { w, h } = gridArea();
  S.cell = Math.max(2, Math.min(w / n, h / n));
  // centre
  S.tx = Math.max(0, (w - S.cell * n) / 2);
  S.ty = Math.max(0, (h - S.cell * n) / 2);
}

function clampPan() {
  const n = S.order.length;
  const { w, h } = gridArea();
  const gw = S.cell * n, gh = S.cell * n;
  if (gw <= w) S.tx = (w - gw) / 2; else S.tx = Math.min(0, Math.max(w - gw, S.tx));
  if (gh <= h) S.ty = (h - gh) / 2; else S.ty = Math.min(0, Math.max(h - gh, S.ty));
}

/* ---------- colour ---------- */
const RAMP = [
  [0.00, [29, 53, 87]], [0.35, [69, 123, 157]], [0.60, [233, 196, 106]],
  [0.82, [231, 111, 81]], [1.00, [200, 40, 40]],
];
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function rampColor(t) {
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i];
      const f = (t - t0) / (t1 - t0);
      return `rgb(${lerp(c0[0], c1[0], f)},${lerp(c0[1], c1[1], f)},${lerp(c0[2], c1[2], f)})`;
    }
  }
  return "rgb(200,40,40)";
}
function cellColor(count) {
  const never = S.highlightNever
    ? getCss("--never-hi") : getCss("--never");
  if (!count) return never;
  const t = Math.log1p(count) / Math.log1p(S.maxCount[S.gender]);
  if (S.highlightNever) {            // de-emphasise played cells to spotlight the empties
    const g = lerp(58, 174, t);
    return `rgb(${g},${g + 6},${g + 14})`;
  }
  return rampColor(t);
}
let _css = {};
function getCss(v) { return _css[v] || (_css[v] = getComputedStyle(document.documentElement).getPropertyValue(v).trim()); }

/* ---------- rendering ---------- */
function resize() {
  DPR = window.devicePixelRatio || 1;
  canvas.width = Math.floor(canvas.clientWidth * DPR);
  canvas.height = Math.floor(canvas.clientHeight * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // Smaller label margin on narrow screens so the grid isn't dominated by it.
  MARGIN = Math.round(Math.max(56, Math.min(116, canvas.clientWidth * 0.2)));
}

function draw() {
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
  const atPresent = present();
  const span = Math.ceil(cell) + (cell > 7 ? 0 : 1);
  for (let r = r0; r < r1; r++) {
    const a = S.order[r];
    const y = oy + r * cell;
    for (let c = c0; c < c1; c++) {
      const b = S.order[c];
      let col;
      if (a === b) col = diag;
      else {
        const cnt = countAsOf(a, b);
        if (!cnt && S.showUpcoming && atPresent && isUpcoming(a, b)) col = upcomingCol;
        else col = cellColor(cnt);
      }
      ctx.fillStyle = col;
      ctx.fillRect(Math.floor(ox + c * cell), Math.floor(y), span, span);
    }
  }
  // hover crosshair
  if (S.hover) {
    ctx.fillStyle = "rgba(255,255,255,.08)";
    ctx.fillRect(MARGIN, oy + S.hover.r * cell, gw, cell);
    ctx.fillRect(ox + S.hover.c * cell, MARGIN, cell, gh);
  }
  ctx.restore();

  if (S.sort === "confed") drawSeparators(n, ox, oy, cell, gw, gh, r0, r1, c0, c1);
  drawLabels(n, ox, oy, cell, r0, r1, c0, c1);
  drawBands(n, ox, oy, cell);

  // mask the margin corners cleanly
  ctx.fillStyle = getCss("--bg");
  ctx.fillRect(0, 0, MARGIN, MARGIN);
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

function drawSeparators(n, ox, oy, cell, gw, gh, r0, r1, c0, c1) {
  ctx.strokeStyle = getCss("--line");
  ctx.lineWidth = 1;
  for (const run of confedRuns()) {
    if (run.start === 0) continue;
    const x = ox + run.start * cell, y = oy + run.start * cell;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + .5, MARGIN); ctx.lineTo(Math.round(x) + .5, MARGIN + gh);
    ctx.moveTo(MARGIN, Math.round(y) + .5); ctx.lineTo(MARGIN + gw, Math.round(y) + .5);
    ctx.stroke();
  }
}

function shortLabel(m, cell) {
  if (cell >= 46) return m.name;
  if (m.code) return m.code;
  return m.name.length > 6 ? m.name.slice(0, 6) : m.name;
}

function drawLabels(n, ox, oy, cell, r0, r1, c0, c1) {
  if (cell < 5) return;
  // Thin the labels so their on-screen spacing stays legible (>= ~14px) at any zoom —
  // otherwise codes pile on top of each other into gibberish at low zoom.
  const step = Math.max(1, Math.round(14 / cell));
  const fs = Math.min(13, Math.max(8, cell - 3));
  ctx.font = `${fs}px -apple-system, "Segoe UI", sans-serif`;

  // Keep labels clear of the confederation colour band (the outer BAND-px strip).
  const edge = MARGIN - BAND - 4;          // inner edge of the band
  const maxLen = MARGIN - BAND - 8;        // max label width inside the margin

  // rows (left margin, right-aligned up to the band)
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let r = r0; r < r1; r++) {
    if (r % step) continue;
    const m = S.byId.get(S.order[r]);
    ctx.fillStyle = m.defunct ? getCss("--ink-dim") : getCss("--ink");
    ctx.fillText(shortLabel(m, cell), edge, oy + r * cell + cell / 2, maxLen);
  }
  // cols (top margin, rotated, starting at the band edge)
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (let c = c0; c < c1; c++) {
    if (c % step) continue;
    const m = S.byId.get(S.order[c]);
    const x = ox + c * cell + cell / 2;
    ctx.save();
    ctx.translate(x, edge); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = m.defunct ? getCss("--ink-dim") : getCss("--ink");
    ctx.fillText(shortLabel(m, cell), 0, 0, maxLen);
    ctx.restore();
  }
}

function drawBands(n, ox, oy, cell) {
  const { w: gw, h: gh } = gridArea();
  const right = MARGIN + gw, bottom = MARGIN + gh;
  const runs = confedRuns();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "700 10px -apple-system, sans-serif";
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  for (const run of runs) {
    const col = CONFED_COLOR[run.confed] || "#888";
    const a = run.start * cell, len = (run.end - run.start + 1) * cell;
    ctx.fillStyle = col;
    ctx.fillRect(ox + a, MARGIN - BAND, len, BAND);          // top strip
    ctx.fillRect(MARGIN - BAND, oy + a, BAND, len);          // left strip
    // Label, stuck to the visible portion of the run (only when there's room).
    const visW = Math.min(ox + a + len, right) - Math.max(ox + a, MARGIN);
    const visH = Math.min(oy + a + len, bottom) - Math.max(oy + a, MARGIN);
    ctx.fillStyle = "#0e1016";
    if (visW > 26) {
      const cx = clamp(ox + a + len / 2, MARGIN + 12, right - 12);
      ctx.fillText(run.confed, cx, MARGIN - BAND / 2 - .5);
    }
    if (visH > 26) {
      const cy = clamp(oy + a + len / 2, MARGIN + 12, bottom - 12);
      ctx.save();
      ctx.translate(MARGIN - BAND / 2, cy); ctx.rotate(-Math.PI / 2);
      ctx.fillText(run.confed, 0, .5);
      ctx.restore();
    }
  }
}

function drawLegend() {
  const lc = document.getElementById("legend-canvas");
  const g = lc.getContext("2d");
  const w = lc.width, h = lc.height;
  for (let x = 0; x < w; x++) {
    g.fillStyle = rampColor(x / (w - 1));
    g.fillRect(x, 0, 1, h);
  }
}

/* ---------- interaction ---------- */
function cellAt(mx, my) {
  if (mx < MARGIN || my < MARGIN) return null;
  const c = Math.floor((mx - MARGIN - S.tx) / S.cell);
  const r = Math.floor((my - MARGIN - S.ty) / S.cell);
  if (r < 0 || c < 0 || r >= S.order.length || c >= S.order.length) return null;
  return { r, c };
}

function showTooltip(cellRC, mx, my) {
  const A = S.byId.get(S.order[cellRC.r]);
  const B = S.byId.get(S.order[cellRC.c]);
  let body;
  if (A.id === B.id) {
    body = `<div class="vs">${A.name}</div><div class="dim">${A.confed}${A.defunct ? " · defunct" : ""}</div>`;
  } else {
    const cnt = countAsOf(A.id, B.id);
    const asOf = present() ? "" : ` by ${S.year}`;
    const up = upcomingInfo(A.id, B.id);
    let meetings;
    if (cnt) {
      const p = lookup(A.id, B.id);
      meetings = `<span class="n">${cnt}</span> meeting${cnt === 1 ? "" : "s"}${asOf}`
        + `<div class="dim">${present() ? `${p[1]}–${p[2]}` : `since ${p[1]}`} · ${S.gender}'s</div>`;
    } else if (up && present()) {
      const future = up[0] >= S.today;
      meetings = `<span class="n" style="color:var(--upcoming)">`
        + `${future ? "first meeting coming up" : "first meeting — result pending"}</span>`
        + `<div class="dim">${up[0]} · ${up[1]}</div>`;
    } else {
      meetings = `<span class="n">never played${asOf}</span><div class="dim">${S.gender}'s internationals</div>`;
    }
    body = `<div class="vs">${A.name} <span class="dim">v</span> ${B.name}</div>${meetings}`;
  }
  tooltip.innerHTML = body;
  tooltip.hidden = false;
  const pad = 14;
  let x = mx + pad, y = my + pad;
  const rect = tooltip.getBoundingClientRect();
  if (x + rect.width > canvas.clientWidth) x = mx - rect.width - pad;
  if (y + rect.height > canvas.clientHeight) y = my - rect.height - pad;
  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
}

function zoomAt(px, py, newCell) {  // px,py = canvas-relative coords of the fixed point
  newCell = Math.max(2, Math.min(80, newCell));
  const k = newCell / S.cell;
  const mx = px - MARGIN, my = py - MARGIN;
  S.tx = mx - (mx - S.tx) * k;
  S.ty = my - (my - S.ty) * k;
  S.cell = newCell;
  clampPan();
  draw();
}

function setupInteraction() {
  // Pointer Events unify mouse + touch: 1 pointer = pan/tap, 2 pointers = pinch-zoom.
  const pts = new Map();            // active pointers: id -> {x, y}
  let mode = null;                  // "pan" | "pinch"
  let downX = 0, downY = 0, moved = false;
  let pinchDist = 0, pinchCell = 0;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  canvas.addEventListener("pointerdown", e => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      mode = "pan"; downX = e.clientX; downY = e.clientY; moved = false;
      canvas.classList.add("panning");
    } else if (pts.size === 2) {
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
      if (Math.hypot(e.clientX - downX, e.clientY - downY) >= 5) moved = true;
      clampPan(); S.hover = null; tooltip.hidden = true; draw();
    }
  });

  function endPointer(e) {
    if (pts.has(e.pointerId)) {
      if (mode === "pan" && pts.size === 1 && !moved) {   // a tap/click -> open detail
        const r = canvas.getBoundingClientRect();
        const rc = cellAt(e.clientX - r.left, e.clientY - r.top);
        if (rc) openDetail(rc); else closeDetail();
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
}

/* ---------- match-detail card (lazy-loaded) ---------- */
async function ensureMatches(gender) {
  if (!S.matches[gender]) {
    S.matches[gender] = await fetch(`data/matches_${gender}.json` + VBUST).then(r => r.json());
  }
  return S.matches[gender];
}

function closeDetail() { document.getElementById("detail").hidden = true; }

function openDetail(rc) { openPair(S.order[rc.r], S.order[rc.c]); }

function openPair(aId, bId) {
  const A = S.byId.get(aId);
  const B = S.byId.get(bId);
  const card = document.getElementById("detail");
  if (!A || !B || A.id === B.id) { closeDetail(); return; }
  const gender = S.gender;
  card.hidden = false;
  card.innerHTML =
    `<div class="dh"><div class="dt">${A.name} <span class="vs">vs</span> ${B.name}</div>
     <button class="dx" aria-label="Close" title="Close">&times;</button></div>
     <div class="db dim">Loading match history…</div>`;
  card.querySelector(".dx").onclick = closeDetail;
  // token guards against a slow fetch resolving after the user clicked elsewhere
  const token = (card.dataset.token = String(Date.now()));
  ensureMatches(gender)
    .then(data => { if (card.dataset.token === token) renderDetailBody(card, A, B, data, gender); })
    .catch(() => {
      const db = card.querySelector(".db");
      if (db && card.dataset.token === token) db.textContent = "Couldn't load match details.";
    });
}

function renderDetailBody(card, A, B, data, gender) {
  const lo = Math.min(A.id, B.id), hi = Math.max(A.id, B.id);
  const list = data.pairs[`${lo},${hi}`] || [];
  const T = data.tournaments;
  const db = card.querySelector(".db");
  if (!db) return;
  db.classList.remove("dim");
  if (!list.length) {
    db.innerHTML = `<div class="never">Never played${gender === "women" ? " (women's)" : ""}.</div>`;
    return;
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
    rows.push(`<div class="mr ${res}"><span class="yr">${yr == null ? "?" : yr}</span>`
      + `<span class="sc">${known ? `${sa}–${sb}` : "—"}</span>`
      + `<span class="tn" title="${T[ti] || ""}">${T[ti] || ""}</span></div>`);
  }
  db.innerHTML =
    `<div class="sum"><b>${list.length}</b> meeting${list.length === 1 ? "" : "s"} · `
    + `<span class="w">${w}W</span> <span class="d">${d}D</span> <span class="l">${l}L</span>`
    + (unknown ? ` <span class="dim">+${unknown}?</span>` : "") + ` · `
    + `<span class="gd">${gf}–${ga}</span> <span class="dim">(${A.name})</span></div>`
    + `<div class="mlist">${rows.join("")}</div>`;
}

/* ---------- single-team focus (one team manually selected) ---------- */
function renderTeamFocus(teamId) {
  const team = S.byId.get(teamId);
  const panel = document.getElementById("teamfocus");
  if (!team) { panel.hidden = true; return; }

  let pool = S.members.filter(m => m.id !== teamId);
  if (S.includeDefunct) pool = pool.concat(S.defunct.members.filter(m => m.id !== teamId));
  const rows = pool.map(o => {
    const p = lookup(teamId, o.id);
    return { o, count: p ? p[0] : 0, last: p ? p[2] : null };
  }).sort((a, b) => b.count - a.count || a.o.name.localeCompare(b.o.name));

  const played = rows.filter(r => r.count > 0);
  const never = rows.filter(r => r.count === 0);
  const maxC = played.length ? played[0].count : 1;
  const gLabel = S.gender === "men" ? "men's" : "women's";

  const row = r =>
    `<button class="tf-row${r.count ? "" : " none"}" data-opp="${r.o.id}">`
    + `<span class="tf-dot" style="background:${CONFED_COLOR[r.o.confed] || "#888"}"></span>`
    + `<span class="tf-name">${r.o.name}</span>`
    + `<span class="tf-bar"><span style="width:${Math.round(100 * r.count / maxC)}%"></span></span>`
    + `<span class="tf-n">${r.count || "—"}</span>`
    + `<span class="tf-last">${r.last || ""}</span></button>`;

  panel.innerHTML =
    `<div class="tf-head">
       <div class="tf-title">${team.name} — matchups, most to least played</div>
       <div class="tf-sum">Played <b>${played.length}</b> of ${rows.length} opponents ·
         <b class="never">${never.length}</b> never met · ${gLabel}</div>
     </div>
     <div class="tf-list">${played.map(row).join("")}`
    + (never.length ? `<div class="tf-sep">Never played (${never.length})</div>` : "")
    + `${never.map(row).join("")}</div>`;
  panel.onclick = e => {
    const b = e.target.closest(".tf-row");
    if (b) openPair(teamId, +b.dataset.opp);
  };
  panel.hidden = false;

  document.getElementById("headline").innerHTML =
    `<span class="big">${never.length}</span>`
    + `<span class="rest">opponents <b>${team.name}</b> has never played `
    + `(${gLabel}) — they've met <b>${played.length}</b> of ${rows.length} possible.</span>`;
}

/* On mobile the controls sit below the grid, so move the timeline scrubber up into the stage
   (right under the headline, above the grid) so you can scrub and see the grid change at once. */
const _mqMobile = window.matchMedia("(max-width: 720px)");
let _timelineHome = null;
function placeTimeline() {
  const timeline = document.getElementById("timeline");
  if (!timeline) return;
  if (!_timelineHome) _timelineHome = { parent: timeline.parentNode, next: timeline.nextSibling };
  if (_mqMobile.matches) document.getElementById("timeline-slot").appendChild(timeline);
  else _timelineHome.parent.insertBefore(timeline, _timelineHome.next);
}

/* ---------- controls ---------- */
function buildControls() {
  // gender
  document.querySelectorAll("#gender button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#gender button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      S.gender = btn.dataset.gender;
      buildTeamList();           // refresh the rank shown per gender
      updateUpcomingCount();
      renderUpcomingList();
      if (!present()) ensureYears(S.gender).then(draw);
      recompute(false);
    });
  });

  // sort
  document.getElementById("sort").addEventListener("change", e => {
    S.sort = e.target.value;
    recompute(true);
  });

  // confederation checkboxes
  const counts = {};
  for (const m of S.members) counts[m.confed] = (counts[m.confed] || 0) + 1;
  const cl = document.getElementById("confed-list");
  cl.innerHTML = "";
  for (const cf of S.confedOrder) {
    const lab = document.createElement("label");
    lab.innerHTML = `<span class="dot" style="background:${CONFED_COLOR[cf]}"></span>
      <input type="checkbox" checked data-confed="${cf}"> ${cf}
      <span class="cnt">${counts[cf] || 0}</span>`;
    cl.appendChild(lab);
  }
  cl.addEventListener("change", e => {
    const cb = e.target.closest("input"); if (!cb) return;
    if (cb.checked) S.showConfeds.add(cb.dataset.confed);
    else S.showConfeds.delete(cb.dataset.confed);
    recompute(true);
  });
  document.getElementById("confed-all").onclick = () => toggleConfeds(true);
  document.getElementById("confed-none").onclick = () => toggleConfeds(false);

  // options
  document.getElementById("opt-highlight").onchange = e => { S.highlightNever = e.target.checked; draw(); };
  document.getElementById("opt-upcoming").onchange = e => { S.showUpcoming = e.target.checked; draw(); };
  document.getElementById("opt-defunct").onchange = e => { S.includeDefunct = e.target.checked; buildTeamList(); recompute(true); };
  updateUpcomingCount();
  renderUpcomingList();

  // timeline scrubber
  const scrub = document.getElementById("year-scrub");
  scrub.min = 1872; scrub.max = S.maxYear; scrub.value = S.maxYear;
  setYearLabel();
  scrub.addEventListener("input", e => {
    S.year = +e.target.value;
    setYearLabel();
    if (!present() && !S.yearsByPair[S.gender]) {       // lazy-load per-pair years on first scrub
      document.getElementById("year-label").textContent = S.year + " · loading…";
      ensureYears(S.gender).then(() => { setYearLabel(); updateStats(); draw(); });
    }
    updateStats(); draw();
  });

  // manual team list
  document.getElementById("manual-clear").onclick = () => {
    S.manual.clear();
    document.querySelectorAll("#team-list input").forEach(i => i.checked = false);
    recompute(true);
  };
  document.getElementById("team-search").addEventListener("input", buildTeamList);
  buildTeamList();

  // zoom controls (viewpane)
  document.getElementById("zoom-in").onclick = () => zoomBy(1.4);
  document.getElementById("zoom-out").onclick = () => zoomBy(1 / 1.4);
  document.getElementById("zoom-fit").onclick = () => { fitView(); draw(); };

  // meta / provenance
  const dt = S.meta.dataThrough || {};
  const fmt = iso => iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short" }) : "?";
  document.getElementById("meta").innerHTML =
    `${S.members.length} current FIFA members · matches through <b>${fmt(dt.men)}</b> (men) / `
    + `<b>${fmt(dt.women)}</b> (women) · rankings ${S.meta.rankingMen || "—"}, `
    + `${S.meta.rankingWomen || "—"}.`;
  document.getElementById("legend-max").textContent = `1 → ${S.maxCount[S.gender]}`;

  placeTimeline();
  _mqMobile.addEventListener("change", () => { placeTimeline(); resize(); clampPan(); draw(); });
}

function zoomBy(factor) {
  zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, S.cell * factor);
}

function toggleConfeds(on) {
  S.showConfeds = on ? new Set(S.confedOrder) : new Set();
  document.querySelectorAll('#confed-list input').forEach(i => i.checked = on);
  recompute(true);
}

function buildTeamList() {
  const q = document.getElementById("team-search").value.trim().toLowerCase();
  const list = document.getElementById("team-list");
  let pool = S.members.slice();
  if (S.includeDefunct) pool = pool.concat(S.defunct.members);
  pool.sort((a, b) => a.name.localeCompare(b.name));
  list.innerHTML = "";
  for (const m of pool) {
    if (q && !m.name.toLowerCase().includes(q)) continue;
    const lab = document.createElement("label");
    const r = S.gender === "men" ? m.mens_rank : m.womens_rank;
    const rk = r ? `#${r}` : (m.defunct ? "defunct" : "unranked");
    lab.innerHTML = `<input type="checkbox" data-id="${m.id}" ${S.manual.has(m.id) ? "checked" : ""}>
      ${m.name} <span class="rk">${m.confed} ${rk}</span>`;
    list.appendChild(lab);
  }
  list.onchange = e => {
    const cb = e.target.closest("input"); if (!cb) return;
    const id = +cb.dataset.id;
    if (cb.checked) S.manual.add(id); else S.manual.delete(id);
    recompute(true);
  };
}

function setYearLabel() {
  const el = document.getElementById("year-label");
  if (el) el.textContent = present() ? `present (${S.maxYear})` : `${S.year}`;
}

function updateUpcomingCount() {
  const el = document.getElementById("upcoming-count");
  if (el) { const n = S.upcoming[S.gender].size; el.textContent = n ? `(${n})` : "(none)"; }
}

function fmtDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Scrollable list of upcoming first meetings, classified by the client's date: future fixtures
// are "upcoming"; ones whose date has just passed (data not yet refreshed) show "pending".
function renderUpcomingList() {
  const section = document.getElementById("upcoming-section");
  const list = document.getElementById("upcoming-list");
  if (!section) return;
  const cut = new Date(S.today + "T00:00:00"); cut.setDate(cut.getDate() - 14);
  const cutoff = cut.toISOString().slice(0, 10);
  const items = [];
  for (const [key, [date, tourn]] of S.upcoming[S.gender]) {
    if (date < cutoff) continue;                 // drop stale / abandoned fixtures
    const [lo, hi] = key.split(",").map(Number);
    items.push({ lo, hi, date, tourn, future: date >= S.today });
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  if (!items.length) { section.hidden = true; return; }
  section.hidden = false;
  const nFuture = items.filter(i => i.future).length;
  document.getElementById("upcoming-list-count").textContent = nFuture ? `(${nFuture})` : "";
  list.innerHTML = items.map(it => {
    const A = S.byId.get(it.lo), B = S.byId.get(it.hi);
    return `<button class="up-row${it.future ? "" : " pending"}" data-a="${it.lo}" data-b="${it.hi}"`
      + ` title="${it.tourn} · ${it.date}">`
      + `<span class="up-date">${fmtDate(it.date)}</span>`
      + `<span class="up-teams">${A.name} <span class="dim">v</span> ${B.name}`
      + `${it.future ? "" : ' <span class="dim">· pending</span>'}</span></button>`;
  }).join("");
  list.onclick = e => { const b = e.target.closest(".up-row"); if (b) openPair(+b.dataset.a, +b.dataset.b); };
}

/* ---------- stats ---------- */
function updateStats() {
  const n = S.order.length;
  const total = n * (n - 1) / 2;
  let met = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (countAsOf(S.order[i], S.order[j])) met++;
  const never = total - met;
  const g = S.gender === "men" ? "men's" : "women's";
  const filter = (S.manual.size || S.showConfeds.size < S.confedOrder.length) ? " in this view" : "";
  const scope = present() ? filter : `${filter} by ${S.year}`;
  const headline = document.getElementById("headline");
  const pl = (k, w) => (k === 1 ? w : w + "s");

  let html;
  if (total === 0) {                       // fewer than two teams to compare
    headline.classList.remove("allplayed");
    html = `<span class="big">—</span>`
      + `<span class="rest">Pick at least two teams or confederations to compare.</span>`;
  } else if (never === 0) {                 // every possible matchup has happened
    headline.classList.add("allplayed");
    html = `<span class="big">100%</span>`
      + `<span class="rest">every one of the ${total.toLocaleString()} possible <b>${g}</b> `
      + `${pl(total, "matchup")}${scope} has been played — no unplayed pairings here.</span>`;
  } else {
    headline.classList.remove("allplayed");
    const pct = 100 * met / total;
    html = `<span class="big">${never.toLocaleString()}</span>`
      + `<span class="rest"><b>${g}</b> ${pl(never, "matchup")} ${never === 1 ? "has" : "have"} `
      + `<b>never</b> been played${scope} — just <b>${pct.toFixed(1)}%</b> of the `
      + `${total.toLocaleString()} possible ${pl(total, "pairing")} `
      + `${total === 1 ? "has" : "have"} ever happened.</span>`;
  }
  headline.innerHTML = html;
}

/* ---------- boot ---------- */
window.addEventListener("keydown", e => { if (e.key === "Escape") closeDetail(); });
window.addEventListener("resize", () => { resize(); clampPan(); draw(); });
resize();
setupInteraction();
load().catch(err => {
  document.getElementById("loading").textContent = "Failed to load data: " + err.message;
  console.error(err);
});
