"use strict";

/* National Team Matchup Grid — Scorigami-style heatmap of international football fixtures.
   Vanilla JS + Canvas. Loads pre-built JSON from data/ and renders an N×N grid where each
   cell is a pair of national teams, coloured by how many times they have met. */

const CONFED_COLOR = {
  AFC: "#e0524d", CAF: "#37b98a", CONCACAF: "#e6b54a",
  CONMEBOL: "#4f8fd0", OFC: "#b07a52", UEFA: "#9a6ad6",
};
const KEY = 100000;                  // pair-key multiplier (ids stay well below this)
const MARGIN = 116;                  // px reserved for labels + confederation band
const BAND = 13;                     // px confederation colour strip at outer edge

const S = {
  members: [],                       // current FIFA members
  defunct: { members: [], pairs_men: [], pairs_women: [] },
  byId: new Map(),
  confedOrder: [],
  pairs: { men: new Map(), women: new Map() },
  maxCount: { men: 1, women: 1 },
  matches: { men: null, women: null },   // per-meeting detail, lazy-loaded on first click
  meta: {},
  // view options
  gender: "men",
  sort: "confed",                    // "confed" | "rank" | "alpha"
  showConfeds: new Set(),
  manual: new Set(),
  includeDefunct: false,
  highlightNever: false,
  // ordered ids currently displayed
  order: [],
  // viewport: on-screen cell size (px) + pan offset
  cell: 20, tx: 0, ty: 0,
  hover: null,                       // {r, c}
};

const canvas = document.getElementById("grid");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");
let DPR = window.devicePixelRatio || 1;

/* ---------- data loading ---------- */
async function load() {
  const [members, mMen, mWomen, defunct] = await Promise.all([
    fetch("data/members.json").then(r => r.json()),
    fetch("data/matrix_men.json").then(r => r.json()),
    fetch("data/matrix_women.json").then(r => r.json()),
    fetch("data/defunct.json").then(r => r.json()),
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

  document.getElementById("loading").remove();
  buildControls();
  drawLegend();
  recompute(true);
}

function buildPairMap(pairs, defunctPairs) {
  const map = new Map();
  for (const [i, j, c, fy, ly] of pairs) map.set(i * KEY + j, [c, fy, ly]);
  for (const [i, j, c, fy, ly] of defunctPairs) map.set(i * KEY + j, [c, fy, ly]);
  return map;
}

function lookup(a, b) {
  if (a === b) return null;
  const k = a < b ? a * KEY + b : b * KEY + a;
  return S.pairs[S.gender].get(k) || null;
}

/* ---------- ordering ---------- */
function rankOf(m) {
  const r = S.gender === "men" ? m.mens_rank : m.womens_rank;
  return r == null ? Infinity : r;
}

function recompute(fit) {
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
  closeDetail();                 // a view change can make the open card's pair stale
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
}

function draw() {
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
  const span = Math.ceil(cell) + (cell > 7 ? 0 : 1);
  for (let r = r0; r < r1; r++) {
    const a = S.order[r];
    const y = oy + r * cell;
    for (let c = c0; c < c1; c++) {
      const b = S.order[c];
      let col;
      if (a === b) col = diag;
      else { const p = lookup(a, b); col = cellColor(p ? p[0] : 0); }
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
    const p = lookup(A.id, B.id);
    const meetings = p
      ? `<span class="n">${p[0]}</span> meeting${p[0] === 1 ? "" : "s"}<div class="dim">${p[1]}–${p[2]} · ${S.gender}'s</div>`
      : `<span class="n">never played</span><div class="dim">${S.gender}'s internationals</div>`;
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

function setupInteraction() {
  let dragging = false, downX = 0, downY = 0, lastX = 0, lastY = 0;

  canvas.addEventListener("mousedown", e => {
    dragging = true; downX = lastX = e.clientX; downY = lastY = e.clientY;
    canvas.classList.add("panning");
  });
  window.addEventListener("mouseup", e => {
    if (dragging && Math.hypot(e.clientX - downX, e.clientY - downY) < 4) {
      // treat as a click, not a pan -> open match detail for that cell
      const r = canvas.getBoundingClientRect();
      const rc = cellAt(e.clientX - r.left, e.clientY - r.top);
      if (rc) openDetail(rc); else closeDetail();
    }
    dragging = false; canvas.classList.remove("panning");
  });
  window.addEventListener("mousemove", e => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (dragging) {
      S.tx += e.clientX - lastX; S.ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      clampPan();
      S.hover = null; tooltip.hidden = true;
      draw();
      return;
    }
    const rc = cellAt(mx, my);
    S.hover = rc;
    if (rc) { showTooltip(rc, mx, my); } else { tooltip.hidden = true; }
    draw();
  });
  canvas.addEventListener("mouseleave", () => { S.hover = null; tooltip.hidden = true; draw(); });

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left - MARGIN, my = e.clientY - r.top - MARGIN;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const newCell = Math.max(2, Math.min(80, S.cell * factor));
    const k = newCell / S.cell;
    // keep the point under the cursor fixed
    S.tx = mx - (mx - S.tx) * k;
    S.ty = my - (my - S.ty) * k;
    S.cell = newCell;
    clampPan();
    draw();
  }, { passive: false });
}

/* ---------- match-detail card (lazy-loaded) ---------- */
async function ensureMatches(gender) {
  if (!S.matches[gender]) {
    S.matches[gender] = await fetch(`data/matches_${gender}.json`).then(r => r.json());
  }
  return S.matches[gender];
}

function closeDetail() { document.getElementById("detail").hidden = true; }

function openDetail(rc) {
  const A = S.byId.get(S.order[rc.r]);
  const B = S.byId.get(S.order[rc.c]);
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
  let w = 0, d = 0, l = 0, gf = 0, ga = 0;
  const rows = [];
  for (let i = list.length - 1; i >= 0; i--) {          // newest first
    const [yr, glo, ghi, ti] = list[i];
    const sa = aIsLo ? glo : ghi, sb = aIsLo ? ghi : glo;
    gf += sa; ga += sb;
    const res = sa > sb ? "w" : sa < sb ? "l" : "d";
    if (res === "w") w++; else if (res === "l") l++; else d++;
    rows.push(`<div class="mr ${res}"><span class="yr">${yr}</span>`
      + `<span class="sc">${sa}–${sb}</span>`
      + `<span class="tn" title="${T[ti] || ""}">${T[ti] || ""}</span></div>`);
  }
  db.innerHTML =
    `<div class="sum"><b>${list.length}</b> meeting${list.length === 1 ? "" : "s"} · `
    + `<span class="w">${w}W</span> <span class="d">${d}D</span> <span class="l">${l}L</span> · `
    + `<span class="gd">${gf}–${ga}</span> <span class="dim">(${A.name})</span></div>`
    + `<div class="mlist">${rows.join("")}</div>`;
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
  document.getElementById("opt-defunct").onchange = e => { S.includeDefunct = e.target.checked; buildTeamList(); recompute(true); };

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
}

function zoomBy(factor) {
  const { w, h } = gridArea();
  const cx = w / 2, cy = h / 2;            // zoom about the viewport centre
  const newCell = Math.max(2, Math.min(80, S.cell * factor));
  const k = newCell / S.cell;
  S.tx = cx - (cx - S.tx) * k;
  S.ty = cy - (cy - S.ty) * k;
  S.cell = newCell;
  clampPan();
  draw();
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

/* ---------- stats ---------- */
function updateStats() {
  const n = S.order.length;
  const total = n * (n - 1) / 2;
  let met = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (lookup(S.order[i], S.order[j])) met++;
  const never = total - met;
  const pct = total ? (100 * met / total) : 0;
  const scope = (S.manual.size || S.showConfeds.size < S.confedOrder.length) ? "in this view" : "";
  document.getElementById("headline").innerHTML =
    `<span class="big">${never.toLocaleString()}</span>`
    + `<span class="rest"><b>${S.gender === "men" ? "men's" : "women's"}</b> matchups have `
    + `<b>never</b> been played ${scope} — just <b>${pct.toFixed(1)}%</b> of the `
    + `${total.toLocaleString()} possible pairings have ever happened.</span>`;
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
