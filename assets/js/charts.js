// charts.js - every chart on the site, plus the code that puts them on a page.
//
// A page asks for a chart by id:   <div class="plot" data-chart="a1"></div>   and calls mountAll().
// To move a chart between pages (workbench <-> project), move its <figure> block; to drop one, delete it.
//
// The story uses one picture throughout: weekday down the side, time of day across, colour for the measure.
// That is the "week grid" (b1, c1; c4 and e2 are in the appendix). Other charts are Vega-Lite specs too (the grammar of graphics),
// except the network diagram (c2), which is D3.
//
// Two things are measured, and they are never mixed up:
//   crowding  how busy a station is, as a share of the busiest it has been since July 2019 (TfL's own index, from Wi-Fi data)
//   supply    trains running (trains with a live arrival prediction)
// Demand (how many people want to travel) is not observed. Crowding is what demand and supply produce together.
import { getJSON, rows, dec8, palette, mix, LNAME, LINE_COLOURS } from "./tube.js";

const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LINES = Object.keys(LNAME).filter((l) => l !== "waterloo-city");   // too small to say anything on its own
const STATUS_LABEL = ["Good service", "Minor delays", "Severe delays or reduced service", "Part suspended or part closed", "Suspended or closed", "Closed for the night"];
const HOUR_EXPR = "(datum.value < 10 ? '0' : '') + datum.value + ':00'";
const DAYTYPES = ["Weekday", "Saturday", "Sunday"];
const pad = (n) => String(n).padStart(2, "0");
const lineName = `${JSON.stringify(LNAME)}[datum.value]`;
const hhmm = (tod) => `${pad(Math.floor(tod / 4))}:${pad((tod % 4) * 15)}`;

// ================================================================ data
const cache = new Map();
const data = (name) => { if (!cache.has(name)) cache.set(name, LOADERS[name]()); return cache.get(name); };
function dayInfo(date) {
  const d = new Date(date + "T12:00:00Z"), dow = d.getUTCDay();
  const mon = new Date(d.getTime() - ((dow + 6) % 7) * 86400000);
  return { dow, dname: DOW[dow], daytype: dow === 0 ? "Sunday" : dow === 6 ? "Saturday" : "Weekday", week: mon.toISOString().slice(0, 10) };
}
function stamp(t) { const h = +t.slice(11, 13), m = +t.slice(14, 16); return { date: t.slice(0, 10), hour: h + m / 60, hl: `${pad(h)}:${pad(m)}`, ...dayInfo(t.slice(0, 10)) }; }
const plusMinutes = (t, mins) => new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10), +t.slice(11, 13), +t.slice(14, 16) + mins)).toISOString().slice(0, 16);
const groupBy = (arr, key) => { const m = new Map(); for (const x of arr) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y), i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const num = (v, d = 0) => (v === null || v === undefined ? "n/a" : v.toFixed(d));

const LOADERS = {
  async system() {
    const sys = await getJSON("processed/system.json");
    const daily = rows(sys.daily).map((d) => ({ ...d, ...dayInfo(d.date), partial: d.n < 56 }));
    const partial = new Set(daily.filter((d) => d.partial).map((d) => d.date)), usable = new Set(daily.filter((d) => d.n >= 8).map((d) => d.date));
    const slots = rows(sys.slots).map((s) => ({ ...s, ...stamp(s.t) })).filter((s) => usable.has(s.date)).map((s) => ({ ...s, partial: partial.has(s.date) }));
    return { slots, daily, partial, usable, generated: sys.generated };
  },
  async lines() {
    const S = await data("system"), l = await getJSON("processed/lines.json");
    return rows(l.lines).map((r) => ({ ...r, ...stamp(r.t), t2: plusMinutes(r.t, 60), partial: S.partial.has(r.t.slice(0, 10)) })).filter((r) => S.usable.has(r.date));
  },
  async weekly() { return rows((await getJSON("processed/weekly.json")).weekly); },
  async typical() {
    const t = await getJSON("processed/typical.json"), a = dec8(t.ty);
    return { stations: t.stations, idx: new Map(t.stations.map((id, i) => [id, i])), get: (i, d, q) => { const v = a[i * 672 + d * 96 + q]; return v === -128 ? null : v; } };
  },
  async stations() { return rows((await getJSON("processed/stations.json")).stations); },
  async strain() { const s = await getJSON("processed/strain.json"); return { stations: rows(s.stations).filter((x) => x.ok), lines: rows(s.lines) }; },
  async events() { const e = await getJSON("processed/events.json"); return { list: rows(e.events), counts: e.counts, offsets: e.offsets, groups: e.groups, days: e.days }; },
  async strained() { return getJSON("processed/strained.json"); },
  async typicalSupply() { const t = await getJSON("processed/typical_supply.json"), a = dec8(t.tp); return { stations: t.stations, idx: new Map(t.stations.map((id, i) => [id, i])), get: (i, d, q) => { const v = a[i * 672 + d * 96 + q]; return v === -128 ? null : v; } }; },
  async closures() { return rows((await getJSON("processed/closures.json")).closures); },
  async lifts() { const l = await getJSON("processed/lifts.json"); return { episodes: rows(l.episodes), summary: l.summary, from: l.from, to: l.to }; },
  async reliability() { const r = await getJSON("processed/reliability.json"); return { groups: r.groups, rows: rows(r.rows), days: r.days }; },
  async controls() { return rows((await getJSON("processed/controls.json")).controls); },
  async network() { return getJSON("assets/data/network.json"); },
  async boroughs() {
    const gj = await getJSON("assets/data/boroughs.geojson");   // d3 wants clockwise outer rings
    const flip = (g) => (g.type === "Polygon" ? { ...g, coordinates: g.coordinates.map((r) => [...r].reverse()) } : { ...g, coordinates: g.coordinates.map((p) => p.map((r) => [...r].reverse())) });
    return { ...gj, features: gj.features.map((f) => ({ ...f, geometry: flip(f.geometry) })) };
  },
  async recent() {
    const r = await getJSON("processed/recent.json"), ns = r.ns, rel = dec8(r.rel), sup = dec8(r.sup), code = dec8(r.code), lstat = dec8(r.lstat);
    const base = Date.UTC(+r.t0.slice(0, 4), +r.t0.slice(5, 7) - 1, +r.t0.slice(8, 10), +r.t0.slice(11, 13), +r.t0.slice(14, 16));
    const info = (s) => { const d = new Date(base + s * 900000), h = d.getUTCHours(), m = d.getUTCMinutes();
      return { date: d.toISOString().slice(0, 10), h, m, tod: h * 4 + m / 15, hour: h + m / 60, dow: d.getUTCDay(), dname: DOW[d.getUTCDay()], label: `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${pad(h)}:${pad(m)}` }; };
    const val = (a, k) => (a[k] === -128 ? null : a[k]);
    const dates = [], first = new Map();
    for (let s = 0; s < ns; s++) { const d = info(s).date; if (!first.has(d)) { first.set(d, s); dates.push(d); } }
    return { ns, stations: r.stations, lines: r.lines, idx: new Map(r.stations.map((id, i) => [id, i])), info, dates,
             slotOf: (date, tod) => { const s0 = first.get(date); if (s0 === undefined) return null; for (let s = s0; s < ns && info(s).date === date; s++) if (info(s).tod === tod) return s; return null; },
             rel: (i, s) => val(rel, i * ns + s), sup: (i, s) => val(sup, i * ns + s), closure: (i, s) => code[i * ns + s] % 3, lift: (i, s) => Math.floor(code[i * ns + s] / 3),
             lstat: (l, s) => val(lstat, l * ns + s) };
  },
};

// ================================================================ shared pieces
function config(c) {
  return { font: "Atkinson Hyperlegible, system-ui, sans-serif", view: { stroke: null },
    axis: { labelColor: c.ink2, titleColor: c.ink2, domainColor: c.rule, tickColor: c.rule, gridColor: c.rule, labelFontSize: 12, titleFontSize: 12, titleFontWeight: 400, titlePadding: 8 },
    legend: { labelColor: c.ink2, titleColor: c.ink2, labelFontSize: 12, titleFontSize: 12, titleFontWeight: 400 },
    title: { color: c.ink, fontSize: 13, fontWeight: "bold", anchor: "start", offset: 8 },
    header: { labelColor: c.ink, labelFontSize: 13, labelFontWeight: "bold", titleColor: c.ink2 } };
}
const hourAxis = (values = [6, 9, 12, 15, 18, 21, 24]) => ({ title: null, values, labelExpr: HOUR_EXPR, grid: false });
const hourX = (extra = {}) => ({ field: "hour", type: "quantitative", scale: { domain: [5, 24], nice: false }, axis: hourAxis(), ...extra });
const gradientLegend = (title) => ({ title, orient: "bottom", direction: "horizontal", gradientLength: 280, titleLimit: 760 });
const statusColours = (c) => [c.usual, mix(c.usual, c.ink, 0.28), mix(c.usual, c.ink, 0.52), mix(c.usual, c.ink, 0.76), c.ink, mix(c.bg, c.rule, 0.6)];
const CAUSE_COLOURS = (c) => ({ "Fire alert": "#B5483A", "Overcrowding control": c.busy, "Staff unavailable": c.supply, "Equipment fault": "#6C8EAD", "Lift fault": "#3A9C8F", "Planned works": mix(c.usual, c.ink3, 0.6), Other: c.nodata });

function shell(el, n = 1) {
  el.textContent = "";
  const ctl = document.createElement("div"); ctl.className = "controls";
  const areas = Array.from({ length: n }, () => { const a = document.createElement("div"); a.className = "area"; return a; });
  const after = document.createElement("p"); after.className = "note";
  el.append(ctl, ...areas, after);
  return { ctl, area: areas[0], areas, after };
}
async function embed(target, spec, c) {
  const full = { $schema: "https://vega.github.io/schema/vega-lite/v6.json", background: "transparent", config: config(c), ...spec };
  target.textContent = "";
  return vegaEmbed(target, full, { actions: false, renderer: "svg", tooltip: { theme: "light" } });
}
const select = (label, options, value, on) => {
  const l = document.createElement("label"), s = document.createElement("select");
  options.forEach(([v, t]) => { const o = new Option(t, v); o.selected = String(v) === String(value); s.add(o); });
  s.onchange = () => on(s.value); l.append(label + " ", s); return l;
};
const button = (text, on) => { const b = document.createElement("button"); b.textContent = text; b.onclick = on; return b; };
const slider = (min, max, value, on) => { const i = document.createElement("input"); i.type = "range"; i.min = min; i.max = max; i.value = value; i.oninput = () => on(+i.value); return i; };
const stamped = (text) => { const s = document.createElement("span"); s.className = "stamp"; s.textContent = text; return s; };
const STATE = {};
const lineOptions = (all = "All lines") => [["all", all], ...LINES.map((l) => [l, LNAME[l]])];

// ---- maps
function fitMercator(coords, w, h, pad_ = 0.04) {
  const my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)), lons = coords.map((p) => p[0]), lats = coords.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...lons), Math.max(...lons), my(Math.min(...lats)), my(Math.max(...lats))];
  const scale = Math.min(w / (((x1 - x0) * Math.PI) / 180), h / (y1 - y0)) * (1 - pad_), cy = (y0 + y1) / 2;
  return { type: "mercator", scale, center: [(x0 + x1) / 2, (2 * Math.atan(Math.exp(cy)) - Math.PI / 2) * (180 / Math.PI)], translate: [w / 2, h / 2] };
}
function geoPoints(gj) { const out = []; const walk = (a) => { if (typeof a[0] === "number") out.push(a); else a.forEach(walk); }; gj.features.forEach((f) => walk(f.geometry.coordinates)); return out; }
const boroughLayer = (gj, c) => ({ data: { values: gj, format: { property: "features" } }, mark: { type: "geoshape", fill: mix(c.usual, c.bg, 0.5), stroke: c.rule, strokeWidth: 0.7 } });
// the lines of the network drawn on a map; the highlighted line is coloured, the rest are faint
function lineLayer(D, c, highlight) {
  const ll = new Map(D.stations.map((s) => [s.naptan, [s.lon, s.lat]])), segs = [];
  D.network.edges.forEach(([a, b, l]) => { const p = ll.get(a), q = ll.get(b); if (!p || !q) return;
    const on = highlight && highlight !== "all" && l === highlight;
    segs.push({ lon1: p[0], lat1: p[1], lon2: q[0], lat2: q[1], col: on ? LINE_COLOURS[l] : mix(c.rule, c.ink3, 0.5), w: on ? 3.2 : 1.1, order: on ? 1 : 0 }); });
  segs.sort((x, y) => x.order - y.order);
  return { data: { values: segs }, mark: { type: "rule" }, encoding: { longitude: { field: "lon1", type: "quantitative" }, latitude: { field: "lat1", type: "quantitative" }, longitude2: { field: "lon2" }, latitude2: { field: "lat2" },
    color: { field: "col", type: "nominal", scale: null }, strokeWidth: { field: "w", type: "quantitative", scale: null } } };
}

// ---- tooltip for D3
const tip = (() => { const d = document.createElement("div"); d.className = "tip"; document.body.append(d); return d; })();
function showTip(ev, html) { tip.innerHTML = html; tip.style.display = "block"; const r = tip.getBoundingClientRect(); let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14; if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14; tip.style.left = x + "px"; tip.style.top = y + "px"; }
const hideTip = () => { tip.style.display = "none"; };
addEventListener("scroll", hideTip, { passive: true });





// ================================================================ the week grid
// One picture: weekday down, time of day across, colour for the measure. Each picture is scaled to itself: 100 is its own busiest
// quarter-hour of the typical week. That answers "within a week, when is it busiest?", not "is this week busier than last?".
// Every cell is a median across days (all the Tuesdays at 08:45, say), so it settles as weeks accumulate and one-off events wash out.
const checkbox = (label, checked, on) => { const l = document.createElement("label"), i = document.createElement("input"); i.type = "checkbox"; i.checked = checked; i.onchange = () => on(i.checked); l.append(i, " " + label); return l; };
function heat(cells, c, W, m) {
  const grid = []; for (const d of WEEK) for (let h = 5; h < 24; h += 0.25) grid.push({ dname: d, hour: h, hour2: h + 0.25 });
  const y = { field: "dname", type: "ordinal", sort: WEEK, axis: { title: null, domain: false, ticks: false } };
  const scale = { range: [c.usual, c[m.key]], interpolate: "lab", zero: true, clamp: true, ...(m.domain ? { domain: m.domain, nice: false } : { nice: true }) };
  const tt = [{ field: "dname", title: "Day" }, { field: "hl", title: "From" }, { field: "v", title: m.name, format: m.fmt }, ...(m.rawName ? [{ field: "raw", title: m.rawName, format: m.rawFmt }] : []), { field: "n", title: "Days behind this cell" }];
  return { ...(m.heading ? { title: m.heading } : {}), width: W, height: 210, autosize: { type: "fit", contains: "padding" }, layer: [
    { data: { values: grid }, mark: "rect", encoding: { x: hourX(), x2: { field: "hour2" }, y, color: { value: c.nodata }, opacity: { value: 0.35 } } },
    { data: { values: cells }, mark: "rect", encoding: { x: hourX(), x2: { field: "hour2" }, y, color: { field: "v", type: "quantitative", scale, legend: gradientLegend(m.title) }, tooltip: tt } }] };
}
function normCells(rowsIn, valueOf, nOf = () => null) {
  const raw = rowsIn.map((r) => ({ r, v: valueOf(r) })).filter((x) => x.v !== null && x.v !== undefined && Number.isFinite(x.v) && x.r.tod / 4 >= 5), mx = raw.length ? Math.max(...raw.map((x) => x.v)) : 1;
  return { cells: raw.map(({ r, v }) => ({ dname: WEEK[r.dow], hour: r.tod / 4, hour2: r.tod / 4 + 0.25, hl: hhmm(r.tod), v: mx > 0 ? (v / mx) * 100 : 0, raw: v, n: nOf(r) })), mx };
}


// C1. When is my station busy? The same grid for one station, for crowding or for trains, with an optional second station.
async function stationHeat(el, c, W, D) {
  const { ctl, areas, after } = shell(el, 2), T = D.typical, P = D.typicalSupply, names = new Map(D.stations.map((s) => [s.naptan, s.name]));
  const list = T.stations.map((id) => [id, names.get(id) || id]).sort((a, b) => a[1].localeCompare(b[1]));
  const st = STATE.c1 || (STATE.c1 = { id: (list.find((s) => s[1] === "Oxford Circus") || list[0])[0], id2: "", m: "c" });
  const cellsOf = (id) => { const src = st.m === "c" ? T : P, i = src.idx.get(id), rs = []; for (let d = 0; d < 7; d++) for (let q = 20; q < 96; q++) { const v = i === undefined ? null : src.get(i, d, q); if (v !== null) rs.push({ dow: d, tod: q, v }); } return normCells(rs, (r) => r.v); };
  const peakText = (id) => { const { cells, mx } = cellsOf(id); if (!cells.length) return `${names.get(id)}: no data yet.`; const top = [...cells].sort((a, b) => b.v - a.v)[0];
    return `${names.get(id)}: busiest ${top.dname} ${top.hl} (${st.m === "c" ? `${mx.toFixed(0)}% of its record` : `${mx.toFixed(0)} trains an hour`}).`; };
  const paint = async () => {
    const lines = [];
    for (const [k, id] of [[0, st.id], [1, st.id2]]) {
      if (!id) { areas[k].textContent = ""; continue; }
      const { cells } = cellsOf(id);
      await embed(areas[k], heat(cells, c, W, { key: st.m === "c" ? "busy" : "supply", domain: [0, 100], fmt: ".0f", name: st.m === "c" ? "Crowding (0-100)" : "Trains per hour (0-100)", heading: names.get(id),
        title: st.m === "c" ? "Crowding, 100 = this station's busiest quarter-hour of the typical week" : "Trains per hour past the station (all lines, both directions), 100 = its busiest quarter-hour of the typical week" }), c);
      lines.push(peakText(id));
    }
    after.textContent = lines.join(" ") + " Each cell is a median across days. Each station is scaled to itself, so the picture shows when it is busiest, not whether it is busier than another station. Cells fill in as weeks accumulate.";
  };
  ctl.append(select("Measure", [["c", "Crowding"], ["tp", "Trains per hour"]], st.m, (v) => { st.m = v; paint(); }), select("Station", list, st.id, (v) => { st.id = v; paint(); }), select("Compare with", [["", "No second station"], ...list], st.id2, (v) => { st.id2 = v; paint(); }));
  await paint();
}


// C3. How long will I wait? Any station, line and direction, optionally against any other. One plot; pick a day, weekdays or the weekend.
// Fifteen-minute bins; every day gives one wait per bin, so the band is the day-to-day variation and appears as days accumulate.
async function drawWaits(el, c, W, D) {
  const { ctl, area, after } = shell(el), list = [...D.stations].sort((a, b) => a.name.localeCompare(b.name)), nm = new Map(D.stations.map((s) => [s.naptan, s.name]));
  const st = STATE.c3 || (STATE.c3 = { a: { id: (list.find((s) => s.name === "Oxford Circus") || list[0]).naptan, line: "victoria", dir: null }, b: { id: "", line: null, dir: null }, day: "wd" });
  const redraw = () => drawWaits(el, c, W, D);
  const load = async (id) => { try { const j = await getJSON(`processed/waits/${id}.json`), keys = Object.keys(j.groups); return { g: j.groups, towards: j.towards || {}, keys }; } catch (e) { return null; } };
  const A = await load(st.a.id), B = st.b.id ? await load(st.b.id) : null;
  if (!A) { area.innerHTML = '<p class="err-msg">No waits recorded for this station yet.</p>'; return; }
  const fix = (S, X) => { let lines = [...new Set(X.keys.map((k) => k.split("|")[0]))]; if (lines.length > 1) lines = lines.filter((l) => l !== "waterloo-city"); if (!lines.includes(S.line)) S.line = lines[0];
    const dirs = [...new Set(X.keys.filter((k) => k.startsWith(S.line + "|")).map((k) => k.split("|")[1]))]; if (!dirs.includes(S.dir)) S.dir = dirs[0]; return { lines, dirs }; };
  const label = (X, S, d) => X.towards[`${S.line}|${d}`] || `TfL "${d}" direction (heading not worked out)`;
  const fa = fix(st.a, A), DAYS_ = [["wd", "Weekdays (Mon-Fri)"], ["we", "Weekend (Sat-Sun)"], ...["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d, i) => [String(i), d])];
  ctl.append(select("Day", DAYS_, st.day, (v) => { st.day = v; redraw(); }), select("Station", list.map((s) => [s.naptan, s.name]), st.a.id, (v) => { st.a = { id: v, line: st.a.line, dir: null }; redraw(); }),
             select("Line", fa.lines.map((l) => [l, LNAME[l]]), st.a.line, (v) => { st.a.line = v; st.a.dir = null; redraw(); }), select("Trains heading", fa.dirs.map((d) => [d, label(A, st.a, d)]), st.a.dir, (v) => { st.a.dir = v; redraw(); }));
  ctl.append(document.createElement("br"));
  ctl.append(select("Compare with", [["", "No second station"], ...list.map((s) => [s.naptan, s.name])], st.b.id, (v) => { st.b = { id: v, line: null, dir: null }; redraw(); }));
  let fb = null; if (B) { fb = fix(st.b, B);
    ctl.append(select("Line", fb.lines.map((l) => [l, LNAME[l]]), st.b.line, (v) => { st.b.line = v; st.b.dir = null; redraw(); }), select("Trains heading", fb.dirs.map((d) => [d, label(B, st.b, d)]), st.b.dir, (v) => { st.b.dir = v; redraw(); })); }
  const series = [{ X: A, S: st.a, who: `${nm.get(st.a.id)}: ${LNAME[st.a.line]}, ${label(A, st.a, st.a.dir)}` }, ...(B && fb ? [{ X: B, S: st.b, who: `${nm.get(st.b.id)}: ${LNAME[st.b.line]}, ${label(B, st.b, st.b.dir)}` }] : [])];
  const bins = [], pts = [];
  series.forEach(({ X, S, who }) => { const g = X.g[`${S.line}|${S.dir}|${st.day}`]; if (!g) return;
    g.n.forEach((n, i) => { if (n === null) return; const hour = (24 + i) / 4; bins.push({ who, hour, n, p10: g.a[i], p50: g.m[i], p90: g.b[i] }); (g.v[i] || []).forEach((v) => pts.push({ who, hour, v })); }); });
  let colA = LINE_COLOURS[st.a.line], colB = LINE_COLOURS[st.b.line] || c.ink;
  if (series.length > 1 && colA === colB) colB = mix(colB, "#000000", 0.5);
  const who = series.map((s) => s.who), hx = { field: "hour", type: "quantitative", scale: { domain: [6, 24], nice: false }, axis: hourAxis([6, 9, 12, 15, 18, 21, 24]) };
  const col = { field: "who", type: "nominal", scale: { domain: who, range: [colA, colB] }, legend: who.length > 1 ? { title: null, orient: "top", labelLimit: 640, columns: 1 } : null }, dash = { field: "who", type: "nominal", scale: { domain: who, range: [[1, 0], [6, 3]] }, legend: null };
  const y = { type: "quantitative", scale: { domain: [0, 15], clamp: true }, axis: { title: "Minutes until the next train", values: [0, 5, 10, 15] } }, tt = [{ field: "who", title: "Series" }, { field: "hour", title: "Hour", format: ".2f" }, { field: "p50", title: "Median wait (min)", format: ".1f" }, { field: "n", title: "Days behind this point" }];
  if (!bins.length) { area.innerHTML = '<p class="err-msg">No data yet for this choice.</p>'; return; }
  await embed(area, { width: W - 110, height: 270, layer: [
    { data: { values: bins.filter((r) => r.n >= 2) }, mark: { type: "area", opacity: 0.16 }, encoding: { x: hx, y: { ...y, field: "p10" }, y2: { field: "p90" }, color: { ...col, legend: null } } },
    { data: { values: pts }, mark: { type: "point", filled: true, size: 28, opacity: 0.5 }, encoding: { x: hx, y: { ...y, field: "v" }, color: { ...col, legend: null } } },
    { data: { values: bins }, mark: { type: "line", strokeWidth: 2.8 }, encoding: { x: hx, y: { ...y, field: "p50" }, color: col, strokeDash: dash } },
    { data: { values: bins }, mark: { type: "point", opacity: 0, size: 90 }, encoding: { x: hx, y: { ...y, field: "p50" }, tooltip: tt } }] }, c);
  const nmax = Math.max(0, ...bins.map((r) => r.n)), dl = DAYS_.find((d) => d[0] === st.day)[1].toLowerCase();
  after.textContent = `Showing ${dl}. Line: the median wait at that quarter-hour across days. Dots: each day's wait, shown while a quarter-hour has fewer than 5 days of data. Band: the full range of days seen while a quarter-hour has fewer than 10 days (so every dot sits inside it), then the middle 80% of days from 10 days on; it narrows as days accumulate and outliers stop dominating (the best-covered quarter-hour has ${nmax} day${nmax === 1 ? "" : "s"} so far). Colours are the lines' own. Fixed 0 to 15 minutes, from 06:00. Waits are live predictions, not timetable promises.`;
}


// Side by side when there is room: the map on the left, the bars (out of 100%) on the right.
function sideBySide(after, left, right, W) {
  const wide = W >= 900, gap = 20;
  if (wide) { const row = document.createElement("div"); row.className = "sbs"; row.append(left, right); after.before(row); }
  return { wide, mapW: wide ? Math.floor((W - gap) * 0.58) : W - 40, barW: wide ? Math.floor((W - gap) * 0.42) - 120 : W - 200 };
}

// B5. What kind of station is each one? The bars say how each line's stations split (out of 100%), the map says where. Search for a station, or show one type.
async function stationTypes(el, c, W, D) {
  const { ctl, areas, after } = shell(el, 2), [a1, a2] = areas, st = STATE.b5 || (STATE.b5 = { line: "all", type: "all", q: "" });
  const TYPES = ["Commuter: sharp rush hours, quiet weekends", "All-day: steady through the day", "Weekend visitors: busier at weekends"], SHORT = ["Commuter", "All-day", "Weekend visitors"];
  const colours = [c.quiet, c.nodata, "#3A9C8F"];
  const typed = D.stations.filter((s) => s.mid > 0 && s.wk > 0 && s.n >= 100).map((s) => {
    const we = [s.sat, s.sun].filter((v) => v !== null), wkend = we.length ? mean(we) / s.wk : null, peaky = Math.max(s.am ?? 0, s.pm ?? 0) / s.mid;
    return { ...s, peaky, wkend, type: wkend !== null && wkend >= 1.1 ? TYPES[2] : peaky >= 1.8 && (wkend === null || wkend < 0.9) ? TYPES[0] : TYPES[1] };
  });
  const counts = TYPES.map((t) => typed.filter((s) => s.type === t).length), lab = SHORT.map((t, i) => `${t} (${counts[i]} stations)`), L = (s) => lab[TYPES.indexOf(s.type)];
  const onLineOf = (s, l) => s.lines.split(";").includes(l);
  const rowsL = []; LINES.forEach((l) => { const ss = typed.filter((s) => onLineOf(s, l)); TYPES.forEach((t, i) => rowsL.push({ line: l, type: lab[i], n: ss.filter((s) => s.type === t).length, pct: ss.length ? (ss.filter((s) => s.type === t).length / ss.length) * 100 : 0 })); });
  const order = [...LINES].sort((x, y) => rowsL.filter((r) => r.line === y && r.type === lab[0]).reduce((s, r) => s + r.pct, 0) - rowsL.filter((r) => r.line === x && r.type === lab[0]).reduce((s, r) => s + r.pct, 0));
  const { wide, mapW, barW } = sideBySide(after, a2, a1, W), sx = await data("stations");
  await embed(a1, { title: { text: "Plot 2b: how each line's stations split", anchor: "start", fontSize: 13 }, width: barW, height: 330, data: { values: rowsL }, mark: "bar", encoding: {
    x: { field: "line", type: "nominal", sort: order, axis: { title: null, domain: false, ticks: false, labelAngle: -40, labelLimit: 130, labelExpr: lineName } },
    y: { field: "pct", type: "quantitative", stack: "zero", scale: { domain: [0, 100] }, axis: { title: "% of the line's stations", values: [0, 25, 50, 75, 100] } },
    color: { field: "type", type: "nominal", scale: { domain: lab, range: colours }, legend: { title: null, orient: "bottom", columns: 1, labelLimit: 420 } }, order: { field: "type", type: "nominal" },
    tooltip: [{ field: "line", title: "Line" }, { field: "type", title: "Type" }, { field: "n", title: "Stations" }, { field: "pct", title: "% of the line's stations", format: ".0f" }] } }, c);
  const paint = async () => {
    const h = Math.round(Math.min(mapW * 0.8, 600)), proj = fitMercator(geoPoints(D.boroughs), mapW, h), on = st.line, want = SHORT.indexOf(st.type) >= 0 ? TYPES[SHORT.indexOf(st.type)] : null;
    const base = typed.filter((s) => on === "all" || onLineOf(s, on)).map((s) => ({ ...s, label: L(s) })), shown = base.filter((s) => !want || s.type === want), faded = base.filter((s) => want && s.type !== want);
    const hit = st.q ? typed.filter((s) => s.name.toLowerCase() === st.q.toLowerCase()).map((s) => ({ ...s, label: L(s) })) : [];
    const geo = { longitude: { field: "lon", type: "quantitative" }, latitude: { field: "lat", type: "quantitative" } };
    await embed(a2, { title: { text: "Plot 2: where each station sits", anchor: "start", fontSize: 13 }, width: mapW, height: h, projection: proj, layer: [boroughLayer(D.boroughs, c), lineLayer({ stations: sx, network: D.network }, c, on),
      { data: { values: faded }, mark: { type: "circle", size: 22, opacity: 0.35, color: c.nodata }, encoding: geo },
      { data: { values: shown }, mark: { type: "circle", size: 95, opacity: 0.88, stroke: c.panel, strokeWidth: 0.8 }, encoding: { ...geo, color: { field: "label", type: "nominal", scale: { domain: lab, range: colours }, legend: null },
        tooltip: [{ field: "name", title: "Station" }, { field: "label", title: "Type" }, { field: "peaky", title: "Rush-hour peak over midday", format: ".1f" }, { field: "wkend", title: "Weekend over weekday", format: ".2f" }] } },
      { data: { values: hit }, mark: { type: "circle", size: 380, filled: false, stroke: c.ink, strokeWidth: 2.5 }, encoding: geo },
      { data: { values: hit }, mark: { type: "text", dy: -14, fontWeight: "bold", fontSize: 13, color: c.ink }, encoding: { ...geo, text: { field: "name" } } }] }, c);
    const bits = [`Showing ${shown.length} stations${want ? ` of the type "${SHORT[SHORT.indexOf(st.type)].toLowerCase()}"` : ""}${on === "all" ? "" : ` on the ${LNAME[on]} line`}.`];
    if (st.q && !hit.length) bits.push(`"${st.q}" is not a station with a typical week yet.`);
    if (hit.length) bits.push(`${hit[0].name}: ${SHORT[TYPES.indexOf(hit[0].type)].toLowerCase()} (rush-hour peak ${hit[0].peaky.toFixed(1)} times midday; weekends ${hit[0].wkend === null ? "n/a" : (hit[0].wkend * 100).toFixed(0) + "% of weekdays"}).`);
    note.textContent = bits.join(" ");
  };
  const note = document.createElement("p"); note.className = "note"; after.before(note);
  const btns = [["all", "All types"], ...SHORT.map((s) => [s, s])].map(([v, t]) => { const b = button(t, () => { st.type = v; btns.forEach((x) => x.setAttribute("aria-pressed", x.dataset.v === v)); paint(); }); b.dataset.v = v; b.setAttribute("aria-pressed", st.type === v); return b; });
  const find = document.createElement("label"), inp = document.createElement("input"), dl = document.createElement("datalist"); inp.type = "search"; inp.placeholder = "Type a station name"; inp.value = st.q; inp.setAttribute("list", "b5-stations"); dl.id = "b5-stations";
  typed.map((s) => s.name).sort().forEach((n) => { const o = document.createElement("option"); o.value = n; dl.append(o); }); inp.oninput = () => { st.q = inp.value.trim(); paint(); }; find.append("Find a station ", inp, dl);
  const span = document.createElement("span"); span.append("Show: ", ...btns);
  ctl.append(find, span, select("Line", lineOptions("All lines"), st.line, (v) => { st.line = v; paint(); }));
  await paint();
  after.textContent = "Rule of thumb, from each station's own typical week: a commuter station has a rush-hour peak at least 1.8 times its midday level and weekends below 90% of weekdays; a weekend-visitor station is at least 10% busier at weekends; the rest are all-day. The weekend figures use the weekends collected so far, so they will firm up. The bars are out of 100%: how each line's stations split by type (interchanges count for every line that serves them).";
}

// ================================================================ D. When it goes wrong
const SEVTXT = { 1: "minor delays", 2: "severe delays or reduced service", 3: "part suspended or part closed", 4: "suspended or closed" };

// D1. The most strained moments, for the whole network or one line, over today / this week / this month / all time.
// Crowding and supply are built like the week grids (100 = the station's, or the line's, busiest quarter-hour of the typical week).
// The critical zone is where crowding is among the highest 10% of all station moments and supply among the lowest 10%.
async function strainMoment(el, c, W, D) {
  const { ctl, area, after } = shell(el), S = D.strained, N = D.network, usual = new Map(D.strain.stations.map((s) => [s.naptan, s])), st = STATE.d1 || (STATE.d1 = { scope: "all", period: "week", rank: 0, byLine: false });
  const PERIODS = [["today", "Today"], ["week", "This week (last 7 days)"], ["month", "This month (last 30 days)"], ["all", "All time"]];
  const redraw = () => strainMoment(el, c, W, D), idx = new Map(S.stations.map((id, i) => [id, i])), linesOf = (d) => { const l = d.lines.filter((x) => x !== "waterloo-city"); return l.length ? l : d.lines; };
  const fmtT = (t) => { const d = dayInfo(t.slice(0, 10)); return `${d.dname} ${+t.slice(8, 10)} ${MON[+t.slice(5, 7) - 1]} ${t.slice(11)}`; };
  const read = (id) => { const m = S.moments[id], ci = dec8(m.ci), si = dec8(m.si), cl = dec8(m.cl), crit = [];
    N.stations.forEach((d) => { const i = idx.get(d.id), x = si[i], y = ci[i]; if (x === -128 || y === -128 || cl[i] === 1) return; if (y >= S.c_thr && x <= S.s_thr && (st.scope === "all" || d.lines.includes(st.scope))) crit.push(d); }); return { m, ci, si, cl, crit }; };
  const ids = S.picks[st.scope][st.period]; if (st.rank >= ids.length) st.rank = 0;
  if (!ids.length) { ctl.append(select("Line", lineOptions("Whole network"), st.scope, (v) => { st.scope = v; st.rank = 0; redraw(); }), select("Over", PERIODS, st.period, (v) => { st.period = v; st.rank = 0; redraw(); })); area.innerHTML = '<p class="err-msg">No data for that period.</p>'; return; }
  const all = ids.map(read);
  ctl.append(select("Line", lineOptions("Whole network"), st.scope, (v) => { st.scope = v; st.rank = 0; redraw(); }), select("Over", PERIODS, st.period, (v) => { st.period = v; st.rank = 0; redraw(); }),
             select("Moment", all.map((r, k) => [k, `${k + 1}. ${fmtT(r.m.t)}: ${r.crit.length} station${r.crit.length === 1 ? "" : "s"} in the critical zone`]), st.rank, (v) => { st.rank = +v; redraw(); }),
             checkbox("Colour every station by its line", st.byLine, (v) => { st.byLine = v; redraw(); }));
  const { m, ci, si, cl, crit } = all[st.rank], pts = [];
  N.stations.forEach((d) => { const i = idx.get(d.id), x = si[i], y = ci[i]; if (x === -128 || y === -128 || cl[i] === 1) return; const onScope = st.scope === "all" || d.lines.includes(st.scope), isCrit = y >= S.c_thr && x <= S.s_thr, primary = linesOf(d)[0];
    const colour = st.byLine ? LINE_COLOURS[primary] : st.scope !== "all" && onScope ? LINE_COLOURS[st.scope] : c.ink3;
    pts.push({ name: d.name, ln: d.lines.map((l) => LNAME[l] || l).join(", "), x, y, col: colour, size: st.byLine || (st.scope !== "all" && onScope) ? 85 : 42, op: onScope ? 0.92 : 0.3, ring: isCrit && onScope ? c.ink : "none", shape: cl[i] === 2 ? "diamond" : "circle", state: cl[i] === 2 ? "exit only (entry restricted)" : "open", usual: (() => { const s = usual.get(d.id); return s ? `${s.sl.toFixed(0)} h/week supply-led, ${s.dl.toFixed(0)} h/week demand-led` : "n/a"; })() }); });
  const xmax = Math.max(110, ...pts.map((p) => p.x)) + 5, ymax = Math.max(110, ...pts.map((p) => p.y)) + 5, X = { type: "quantitative", scale: { domain: [0, xmax], nice: false } }, Y = { type: "quantitative", scale: { domain: [0, ymax], nice: false } };
  await embed(area, { width: W - 70, height: Math.min(430, Math.round(W * 0.47)), autosize: { type: "fit", contains: "padding" }, layer: [
    { data: { values: [{ x0: 0, x1: S.s_thr, y0: S.c_thr, y1: ymax }] }, mark: { type: "rect", fill: mix(c.panel, c.busy, 0.16), stroke: c.ink, strokeDash: [5, 4], strokeWidth: 1.5 }, encoding: { x: { ...X, field: "x0", axis: { title: "Supply: trains on the station's lines, 100 = the most those lines run in a typical week", values: [0, 20, 40, 60, 80, 100] } }, x2: { field: "x1" }, y: { ...Y, field: "y0", axis: { title: "Crowding, 100 = the station's busiest quarter-hour of a typical week", values: [0, 20, 40, 60, 80, 100] } }, y2: { field: "y1" } } },
    { data: { values: [{ x: 2, y: ymax - 3, t: "Critical zone" }] }, mark: { type: "text", align: "left", baseline: "top", fontWeight: "bold", fontSize: 12, color: c.ink }, encoding: { x: { ...X, field: "x" }, y: { ...Y, field: "y" }, text: { field: "t" } } },
    { data: { values: pts }, mark: { type: "point", filled: true, strokeWidth: 1.6 }, encoding: { x: { ...X, field: "x" }, y: { ...Y, field: "y" }, color: { field: "col", type: "nominal", scale: null }, stroke: { field: "ring", type: "nominal", scale: null }, size: { field: "size", type: "quantitative", scale: null }, opacity: { field: "op", type: "quantitative", scale: null }, shape: { field: "shape", type: "nominal", scale: null },
      tooltip: [{ field: "name", title: "Station" }, { field: "ln", title: "Lines" }, { field: "y", title: "Crowding (0-100)" }, { field: "x", title: "Supply (0-100)" }, { field: "state", title: "Entry" }, { field: "usual", title: "Usual strain (Plot 6)" }] } }] }, c);
  const jump = document.createElement("div"); jump.className = "ctl"; jump.append("What usually follows these disruptions (Appendix B)? ");
  m.lines.filter(([, , g]) => g >= 2).forEach(([ln, sv, g]) => jump.append(button(`${LNAME[ln]} line: ${SEVTXT[sv]} \u2192`, async () => { STATE.d3 = { line: ln, sel: { sev: sv >= 3 ? 3 : sv, grp: g } }; await redrawChart("appB"); document.querySelector('[data-chart="appB"]').scrollIntoView({ behavior: "smooth", block: "start" }); })));
  if (jump.children.length) after.before(jump);
  const scope = st.scope === "all" ? "the whole network" : `the ${LNAME[st.scope]} line`, period = st.period === "all" ? "in all the data" : "over " + PERIODS.find((p) => p[0] === st.period)[1].toLowerCase();
  const sevOf = ([ln, sv, g]) => `${LNAME[ln]} line: ${g === 1 ? "planned closure" : SEVTXT[sv]}${g > 1 ? " (" + S.groups[g - 1].toLowerCase() + ")" : ""}`;
  const names = crit.map((d) => `${d.name} (${linesOf(d).map((l) => LNAME[l]).join(", ")})`).join("; ");
  const critLines = [...new Set(crit.flatMap((d) => linesOf(d)))], undeclared = critLines.filter((l) => !m.lines.some((x) => x[0] === l)).map((l) => LNAME[l]);
  const going = (m.lines.length ? m.lines.map(sevOf).join("; ") : "no line was disrupted") + (undeclared.length ? `. No disruption was declared on the ${undeclared.join(" or ")} line${undeclared.length > 1 ? "s" : ""} serving the stations in the zone` : "");
  const tfl = m.ctl.length ? m.ctl.slice(0, 8).map(([n, s, ca]) => `${n} (${s === 1 ? "closed" : "exit only"}, ${ca.toLowerCase() || "cause not stated"})`).join("; ") + (m.ctl.length > 8 ? `; and ${m.ctl.length - 8} more` : "") : "no station was closed or restricted";
  const p = (v) => Math.round(v * 100);
  after.textContent = `${fmtT(m.t)}, ${scope}, ${period} (data up to ${S.asof}). In the critical zone: ${crit.length ? names : "no stations"}. What was going on: ${going}. What TfL had done at stations: ${tfl}. Of all ${S.stats.n} critical station moments so far, ${p(S.stats.line)}% happened while a line serving the station was disrupted, ${p(S.stats.exit)}% while TfL had restricted entry (exit-only) at that station, and ${p(S.stats.neither)}% with neither: crowds the service did not meet with no declared problem. The critical zone is crowding of at least ${S.c_thr.toFixed(0)} with supply of at most ${S.s_thr.toFixed(0)}: the highest 10% of crowding and the lowest 10% of supply across every in-service station moment so far; the thresholds move as data accumulate. Diamonds are exit-only stations; closed stations are left out.`;
}


// D1. Where does strain concentrate? The bars say how each line's stations split by main cause (out of 100%), the map says where.
async function strainView(el, c, W, D) {
  const { ctl, areas, after } = shell(el, 2), [a1, a2] = areas, st = STATE.e1 || (STATE.e1 = { line: "all" });
  const causes = ["Supply-led: fewer trains than usual", "Demand-led: much busier than usual", "Both at once"], LITTLE = "Ordinary (under 12 hours a week)", labs = [...causes, LITTLE], colours = [c.supply, c.busy, mix(c.busy, c.ink, 0.6), c.nodata];
  const kind = (s) => { const t = s.sl + s.dl + s.cp; return t < 12 ? LITTLE : s.cp >= s.sl && s.cp >= s.dl ? causes[2] : s.sl >= s.dl ? causes[0] : causes[1]; };
  const all = D.strain.stations.map((s) => ({ ...s, cause: kind(s), total: s.sl + s.dl + s.cp })), onLineOf = (s, l) => s.lines.split(";").includes(l);
  const rowsL = []; LINES.forEach((l) => { const ss = all.filter((s) => onLineOf(s, l)); labs.forEach((k) => rowsL.push({ line: l, cause: k, ord: k === LITTLE ? 0 : labs.indexOf(k) + 1, n: ss.filter((s) => s.cause === k).length, pct: ss.length ? (ss.filter((s) => s.cause === k).length / ss.length) * 100 : 0 })); });
  const under = (l) => rowsL.filter((r) => r.line === l && r.cause !== LITTLE).reduce((s, r) => s + r.pct, 0), order = [...LINES].sort((a, b) => under(b) - under(a));
  const { mapW, barW } = sideBySide(after, a2, a1, W), sx = await data("stations");
  await embed(a1, { title: { text: "Plot 6b: how each line's stations split", anchor: "start", fontSize: 13 }, width: barW, height: 330, data: { values: rowsL }, mark: "bar", encoding: {
    x: { field: "line", type: "nominal", sort: order, axis: { title: null, domain: false, ticks: false, labelAngle: -40, labelLimit: 130, labelExpr: lineName } },
    y: { field: "pct", type: "quantitative", stack: "zero", scale: { domain: [0, 100] }, axis: { title: "% of the line's stations", values: [0, 25, 50, 75, 100] } },
    color: { field: "cause", type: "nominal", scale: { domain: labs, range: colours }, legend: { title: null, orient: "bottom", columns: 1, labelLimit: 420 } }, order: { field: "ord", type: "quantitative" },
    tooltip: [{ field: "line", title: "Line" }, { field: "cause", title: "Main cause" }, { field: "n", title: "Stations" }, { field: "pct", title: "% of the line's stations", format: ".0f" }] } }, c);
  const paint = async () => {
    const h = Math.round(Math.min(mapW * 0.8, 600)), proj = fitMercator(geoPoints(D.boroughs), mapW, h), on = st.line;
    const pts = all.filter((s) => on === "all" || onLineOf(s, on)).map((s) => ({ ...s, label: s.cause })).sort((p, q) => p.total - q.total);
    await embed(a2, { title: { text: "Plot 6: where each station's strain comes from", anchor: "start", fontSize: 13 }, width: mapW, height: h, projection: proj, layer: [boroughLayer(D.boroughs, c), lineLayer({ stations: sx, network: D.network }, c, on),
      { data: { values: pts }, mark: { type: "circle", size: 110, opacity: 0.88, stroke: c.panel, strokeWidth: 0.8 }, encoding: { longitude: { field: "lon", type: "quantitative" }, latitude: { field: "lat", type: "quantitative" },
        color: { field: "label", type: "nominal", scale: { domain: labs, range: colours }, legend: null },
        tooltip: [{ field: "name", title: "Station" }, { field: "label", title: "Main cause" }, { field: "sl", title: "Fewer trains than usual (h/week)", format: ".1f" }, { field: "dl", title: "Much busier than usual (h/week)", format: ".1f" }, { field: "cp", title: "Both (h/week)", format: ".1f" }] } }] }, c);
  };
  ctl.append(select("Map: show stations on", lineOptions("All lines"), st.line, (v) => { st.line = v; paint(); }));
  await paint();
  after.textContent = "Fewer trains than usual means the number of trains running on the station's lines in that hour was more than 20% below the median for the same hour on days of the same type (or the station was closed). Much busier than usual means crowding was more than two of the station's own typical deviations above usual. A station is coloured by whichever cause accounts for most of its strain hours. The bars are out of 100%: how each line's stations split by main cause (interchanges count for every line that serves them). Counted from 06:00, only on days with a baseline, planned closures included. Even in an ordinary week about 5% of quarter-hours are more than two deviations above usual by chance, roughly 6 hours a week, so stations under 12 hours are shown as ordinary.";
}

// ================================================================ A2. Crowding through the day, one line per day
// Click days, or a line, to see what is regular and what is not. 100 = the busiest hour of the typical week on that line.
const hourlyRows = (D, line) => {
  if (line !== "all") return D.lines.filter((r) => r.line === line && r.c != null);
  return [...groupBy(D.system.slots.filter((s) => s.c != null), (s) => `${s.date}|${Math.floor(s.hour)}`)].map(([, v]) => ({ date: v[0].date, dow: v[0].dow, hour: Math.floor(v[0].hour), c: mean(v.map((s) => s.c)), tr: (() => { const t = v.filter((s) => s.tr != null).map((s) => s.tr); return t.length ? mean(t) : null; })(), partial: v[0].partial }));
};
async function dailyPlot(el, c, W, D) {
  const { ctl, area, after } = shell(el), st = STATE.a2 || (STATE.a2 = { line: "all", days: [1, 2, 3, 4, 5, 6, 0] });
  const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]], redraw = () => dailyPlot(el, c, W, D);
  ctl.append(select("Line", lineOptions(), st.line, (v) => { st.line = v; redraw(); }));
  const span = document.createElement("span"); span.append("Days: ");
  DAYS.forEach(([d, t]) => { const b = button(t, () => { st.days = st.days.includes(d) ? st.days.filter((x) => x !== d) : [...st.days, d]; redraw(); }); b.setAttribute("aria-pressed", st.days.includes(d)); span.append(b); });
  [["Weekdays", [1, 2, 3, 4, 5]], ["Weekend", [6, 0]], ["All days", [1, 2, 3, 4, 5, 6, 0]]].forEach(([t, ds]) => span.append(button(t, () => { st.days = ds; redraw(); })));
  ctl.append(span);
  const rs = hourlyRows(D, st.line).filter((r) => !r.partial && r.hour >= 5);
  const med = new Map(); groupBy(rs, (r) => `${r.dow}|${r.hour}`).forEach((v, k) => med.set(k, median(v.map((r) => r.c))));
  const M = Math.max(...med.values());
  const kind = (dow) => (dow === 0 || dow === 6 ? "Weekend" : "Weekday"), shown = rs.filter((r) => st.days.includes(r.dow)), days = [...new Set(shown.map((r) => r.date))].sort();
  if (!shown.length) { area.innerHTML = '<p class="err-msg">Pick at least one day.</p>'; return; }
  const lines = shown.map((r) => ({ date: r.date, label: (() => { const i = dayInfo(r.date); return `${i.dname} ${+r.date.slice(8, 10)} ${MON[+r.date.slice(5, 7) - 1]}`; })(), kind: kind(r.dow), hour: r.hour, v: (r.c / M) * 100 }));
  const typical = []; ["Weekday", "Weekend"].forEach((k) => { const part = lines.filter((l) => l.kind === k); if (part.length) groupBy(part, (l) => l.hour).forEach((v, h) => typical.push({ kind: k, hour: h, v: median(v.map((l) => l.v)), n: new Set(v.map((l) => l.date)).size })); });
  const peaks = ["Weekday", "Weekend"].map((k) => { const t = typical.filter((x) => x.kind === k).sort((a, b) => b.v - a.v)[0]; return t ? { ...t, t: `Typical ${k.toLowerCase()}` } : null; }).filter(Boolean);
  const col = { field: "kind", type: "nominal", scale: { domain: ["Weekday", "Weekend"], range: [c.busy, c.quiet] }, legend: { title: null, orient: "top" } }, x = { field: "hour", type: "quantitative", scale: { domain: [5, 24], nice: false }, axis: hourAxis([6, 9, 12, 15, 18, 21, 24]) };
  const y = { type: "quantitative", scale: { domain: [0, Math.max(110, ...lines.map((l) => l.v)) + 5], nice: false }, axis: { title: `Crowding, 100 = busiest hour of the typical week ${st.line === "all" ? "across all lines" : "on the " + LNAME[st.line] + " line"}`, values: [0, 25, 50, 75, 100] } };
  await embed(area, { width: W - 110, height: 300, layer: [
    { data: { values: lines }, mark: { type: "line", opacity: 0.4, strokeWidth: 1.3 }, encoding: { x, y: { ...y, field: "v" }, detail: { field: "date", type: "nominal" }, color: col, tooltip: [{ field: "label", title: "Day" }, { field: "hour", title: "Hour" }, { field: "v", title: "Crowding (0-100)", format: ".0f" }] } },
    { data: { values: typical }, mark: { type: "line", strokeWidth: 3.6 }, encoding: { x, y: { ...y, field: "v" }, color: { ...col, legend: null }, tooltip: [{ field: "kind", title: "Typical (median)" }, { field: "hour", title: "Hour" }, { field: "v", title: "Crowding (0-100)", format: ".0f" }, { field: "n", title: "Days" }] } },
    { data: { values: peaks }, mark: { type: "text", dy: -10, fontWeight: "bold", fontSize: 12, color: c.ink }, encoding: { x, y: { ...y, field: "v" }, text: { field: "t" } } }] }, c);
  const wk = days.filter((d) => ![0, 6].includes(new Date(d + "T12:00:00Z").getUTCDay())).length, we = days.length - wk;
  after.textContent = `${days.length} day${days.length === 1 ? "" : "s"} shown (${wk} weekday${wk === 1 ? "" : "s"}, ${we} weekend day${we === 1 ? "" : "s"}); each thin line is one day, so the spread between thin lines is how regular the pattern is. Thick lines are the median of the weekdays and of the weekend days shown, so they settle as weeks accumulate. Crowding is TfL's Wi-Fi index averaged over the stations, then scaled so the busiest hour of the typical week is 100 (that is ${M.toFixed(0)}% on TfL's index here); days can exceed 100. Today is left out until it is complete.`;
}

// ================================================================ B1. Supply is rigid; crowding is not
// Supply (trains running) is the main variable. Crowding can be shown behind it in grey. Both are scaled to their own busiest hour of the
// typical week (100). Same line and day controls as A2.
async function supplyRigidity(el, c, W, D) {
  const { ctl, area, after } = shell(el), st = STATE.b1 || (STATE.b1 = { line: "all", days: [1, 2, 3, 4, 5, 6, 0], crowd: true });
  const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]], redraw = () => supplyRigidity(el, c, W, D);
  ctl.append(select("Line", lineOptions(), st.line, (v) => { st.line = v; redraw(); }));
  const span = document.createElement("span"); span.append("Days: ");
  DAYS.forEach(([d, t]) => { const b = button(t, () => { st.days = st.days.includes(d) ? st.days.filter((x) => x !== d) : [...st.days, d]; redraw(); }); b.setAttribute("aria-pressed", st.days.includes(d)); span.append(b); });
  [["Weekdays", [1, 2, 3, 4, 5]], ["Weekend", [6, 0]], ["All days", [1, 2, 3, 4, 5, 6, 0]]].forEach(([t, ds]) => span.append(button(t, () => { st.days = ds; redraw(); })));
  ctl.append(span, checkbox("Show crowding (grey)", st.crowd, (v) => { st.crowd = v; redraw(); }));
  const rs = hourlyRows(D, st.line).filter((r) => !r.partial && r.hour >= 5 && r.tr != null);
  const mx = (field) => { const m = new Map(); groupBy(rs, (r) => `${r.dow}|${r.hour}`).forEach((v, k) => m.set(k, median(v.map((r) => r[field])))); return Math.max(...m.values()); }, MC = mx("c"), MT = mx("tr");
  const kind = (dow) => (dow === 0 || dow === 6 ? "Weekend" : "Weekday"), shown = rs.filter((r) => st.days.includes(r.dow)), SUP = "Supply: trains running", CRO = "Crowding";
  if (!shown.length) { area.innerHTML = '<p class="err-msg">Pick at least one day.</p>'; return; }
  const thin = (field, measure, M) => shown.map((r) => ({ date: r.date, label: (() => { const i = dayInfo(r.date); return `${i.dname} ${+r.date.slice(8, 10)} ${MON[+r.date.slice(5, 7) - 1]}`; })(), kind: kind(r.dow), hour: r.hour, v: (r[field] / M) * 100, measure }));
  const typ = (rows_) => { const out = []; ["Weekday", "Weekend"].forEach((k) => { const part = rows_.filter((l) => l.kind === k); if (part.length) groupBy(part, (l) => l.hour).forEach((v, h) => out.push({ kind: k, hour: h, measure: v[0].measure, v: median(v.map((l) => l.v)), n: new Set(v.map((l) => l.date)).size })); }); return out; };
  const supThin = thin("tr", SUP, MT), croThin = st.crowd ? thin("c", CRO, MC) : [], supTyp = typ(supThin), croTyp = typ(croThin), grey = "#8E95A3";
  const x = { field: "hour", type: "quantitative", scale: { domain: [5, 24], nice: false }, axis: hourAxis([6, 9, 12, 15, 18, 21, 24]) }, y = { field: "v", type: "quantitative", scale: { domain: [0, 110], nice: false }, axis: { title: `100 = its own busiest hour of the typical week ${st.line === "all" ? "across all lines" : "on the " + LNAME[st.line] + " line"}`, values: [0, 25, 50, 75, 100] } };
  const col = { field: "measure", type: "nominal", scale: { domain: st.crowd ? [SUP, CRO] : [SUP], range: st.crowd ? [c.supply, grey] : [c.supply] }, legend: { title: null, orient: "top" } };
  const dash = { field: "kind", type: "nominal", scale: { domain: ["Weekday", "Weekend"], range: [[1, 0], [6, 4]] }, legend: { title: null, orient: "top", symbolType: "stroke", symbolStrokeWidth: 2.5 } };
  const tip = (t) => [{ field: "measure", title: "Measure" }, { field: "hour", title: "Hour" }, { field: "v", title: t, format: ".0f" }];
  await embed(area, { width: W - 110, height: 300, encoding: { x, y, color: col, strokeDash: dash }, layer: [
    { data: { values: croThin }, mark: { type: "line", opacity: 0.3, strokeWidth: 1.2 }, encoding: { detail: { field: "date", type: "nominal" }, tooltip: [{ field: "label", title: "Day" }, ...tip("0-100")] } },
    { data: { values: croTyp }, mark: { type: "line", opacity: 0.85, strokeWidth: 3.2 }, encoding: { tooltip: [...tip("Typical, 0-100"), { field: "n", title: "Days" }] } },
    { data: { values: supThin }, mark: { type: "line", opacity: 0.4, strokeWidth: 1.3 }, encoding: { detail: { field: "date", type: "nominal" }, tooltip: [{ field: "label", title: "Day" }, ...tip("0-100")] } },
    { data: { values: supTyp }, mark: { type: "line", strokeWidth: 3.8 }, encoding: { tooltip: [...tip("Typical, 0-100"), { field: "n", title: "Days" }] } }] }, c);
  const inService = (arr, k) => arr.filter((t) => t.kind === k && t.hour >= 6 && t.hour < 22).map((t) => t.v), k = supTyp.some((t) => t.kind === "Weekday") ? "Weekday" : "Weekend", sMin = Math.min(...inService(supTyp, k)), cMin = croTyp.length ? Math.min(...inService(croTyp, k)) : null;
  const days = new Set(shown.map((r) => r.date)).size;
  after.textContent = `${days} day${days === 1 ? "" : "s"} shown; thin lines are single days, thick lines the median of the weekdays and of the weekend days shown (solid = weekday, dashed = weekend), so they settle as weeks accumulate. On a typical ${k.toLowerCase()} between 06:00 and 22:00, supply never falls below ${sMin.toFixed(0)}% of its busiest hour${cMin === null ? "" : `, while crowding falls to ${cMin.toFixed(0)}%`}: supply is rigid and crowding is volatile. Supply is the number of trains with a live arrival prediction; crowding is TfL's Wi-Fi index averaged over the stations. Each is scaled to its own busiest hour of the typical week, so compare shapes, not heights.`;
}

// D3. What happens after a disruption starts? Pick how serious and why (click the matrix); the three pictures say what to expect next:
// trains running on the line, crowding at its stations, and how long it lasts. 0 = the moment the disruption begins.
async function whatNext(el, c, W, D) {
  const { ctl, areas, after } = shell(el, 2), [a1, a2] = areas, E = D.events, st = STATE.d3 || (STATE.d3 = { line: "all", sel: null });
  const SEV = [[1, "Minor delays", "minor"], [2, "Severe delays|or reduced service", "severe"], [3, "Suspended|or part suspended", "susp"]], REASONS = E.groups.slice(1), weeks = Math.max(E.days / 7, 1);
  const redraw = () => whatNext(el, c, W, D), lineEv = E.list.filter((e) => e.kind === "line" && e.grp >= 2 && e.name !== "waterloo-city" && (st.line === "all" || e.lines.split(";").includes(st.line)));
  const cells = []; REASONS.forEach((reason, gi) => SEV.forEach(([sv, sl, key]) => { const part = lineEv.filter((e) => e.shock === key && e.grp === gi + 2), n = part.length, h = part.reduce((s, e) => s + e.dur, 0);
    cells.push({ reason, sev: sl, sevN: sv, grpN: gi + 2, v: h / weeks, n, h, thin: n < 5 }); }));
  if (!st.sel) { const best = [...cells].sort((a, b) => b.n - a.n)[0]; st.sel = { sev: best.sevN, grp: best.grpN }; }
  const sel = st.sel, isSel = (x) => x.sevN === sel.sev && x.grpN === sel.grp, mx = Math.max(0.01, ...cells.map((x) => x.v));
  ctl.append(select("Line", lineOptions(), st.line, (v) => { st.line = v; st.sel = null; redraw(); }));
  const res = await embed(a1, { title: "What goes wrong, and why: hours of disruption per week (click a cell)", width: { step: 150 }, height: { step: 44 }, data: { values: cells.map((x) => ({ ...x, sel: isSel(x) })) }, encoding: {
    x: { field: "sev", type: "ordinal", sort: SEV.map((s) => s[1]), axis: { title: null, orient: "top", labelAngle: 0, labelLimit: 150, domain: false, ticks: false, labelPadding: 10, labelExpr: "split(datum.value, '|')" } },
    y: { field: "reason", type: "ordinal", sort: REASONS, axis: { title: null, domain: false, ticks: false, labelLimit: 260 } } },
    layer: [{ mark: { type: "rect", cursor: "pointer" }, encoding: { color: { field: "v", type: "quantitative", scale: { domain: [0, mx], range: [c.usual, c.ink], interpolate: "lab" }, legend: { title: "Hours per week", orient: "right" } }, opacity: { condition: { test: "datum.thin", value: 0.55 }, value: 1 },
        stroke: { condition: { test: "datum.sel", value: c.busy }, value: c.bg }, strokeWidth: { condition: { test: "datum.sel", value: 4 }, value: 3 },
        tooltip: [{ field: "reason", title: "Reason" }, { field: "sev", title: "Severity" }, { field: "v", title: "Hours per week", format: ".1f" }, { field: "n", title: "Disruptions so far" }] } },
      { mark: { type: "text", fontSize: 12, cursor: "pointer" }, encoding: { text: { field: "v", type: "quantitative", format: ".1f" }, color: { condition: { test: `datum.v > ${mx / 2}`, value: "#ffffff" }, value: c.ink } } }] }, c);
  res.view.addEventListener("click", (ev, item) => { const d = item && item.datum; if (d && d.grpN) { st.sel = { sev: d.sevN, grp: d.grpN }; redraw(); } });
  const key = SEV.find((s) => s[0] === sel.sev)[2], evs = lineEv.filter((e) => e.shock === key && e.grp === sel.grp), off = E.offsets.filter((o) => o >= -30), idx = E.offsets.map((o, i) => (o >= -30 ? i : -1)).filter((i) => i >= 0);
  const desc = `${SEV.find((s) => s[0] === sel.sev)[1].replace("|", " ").toLowerCase()} caused by ${E.groups[sel.grp - 1].toLowerCase()}`, scope = st.line === "all" ? "any line" : `the ${LNAME[st.line]} line`;
  const have = (e, f) => Array.isArray(e[f]), nEv = evs.filter((e) => have(e, "crowd_aff")).length;
  if (!nEv) { a2.innerHTML = `<p class="err-msg">No events of this kind yet on ${scope}. Click another cell.</p>`; after.textContent = ""; return; }
  const rng = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646; })();
  const stat = (field) => idx.map((i) => { const v = evs.filter((e) => have(e, field) && e[field][i] !== null).map((e) => e[field][i]); if (!v.length) return null; const mu = mean(v);
    let lo = null, hi = null; if (v.length >= 5) { const bs = Array.from({ length: 300 }, () => mean(v.map(() => v[Math.floor(rng() * v.length)]))).sort((a, b) => a - b); lo = bs[7]; hi = bs[292]; } return { off: E.offsets[i], m: mu, lo, hi, n: v.length }; }).filter(Boolean);
  const pw = (W - 250) / 3, xax = { title: "Minutes from the start of the disruption", values: off, labelExpr: "datum.value == 0 ? 'start' : (datum.value > 0 ? '+' : '') + datum.value" };
  const panel = (field, title, colour, ytitle) => { const rows_ = stat(field), pts = []; if (nEv < 5) evs.filter((e) => have(e, field)).forEach((e) => idx.forEach((i) => { if (e[field][i] !== null) pts.push({ off: E.offsets[i], v: e[field][i], label: e.label }); }));
    const x = { field: "off", type: "quantitative", scale: { domain: [-30, 60], nice: false }, axis: xax };
    return { title, width: pw, height: 230, layer: [
      { data: { values: [{ v: 0 }] }, mark: { type: "rule", color: c.ink3 }, encoding: { y: { field: "v", type: "quantitative", axis: { title: ytitle } } } },
      { data: { values: [{ v: 0 }] }, mark: { type: "rule", color: c.ink, strokeDash: [3, 3] }, encoding: { x: { field: "v", type: "quantitative", scale: { domain: [-30, 60], nice: false }, axis: xax } } },
      { data: { values: rows_.filter((r) => r.lo !== null) }, mark: { type: "area", opacity: 0.18, color: colour }, encoding: { x, y: { field: "lo", type: "quantitative", axis: { title: ytitle } }, y2: { field: "hi" } } },
      { data: { values: pts }, mark: { type: "point", filled: true, size: 30, opacity: 0.5, color: colour }, encoding: { x, y: { field: "v", type: "quantitative", axis: { title: ytitle } }, tooltip: [{ field: "label", title: "Event" }, { field: "off", title: "Minutes" }, { field: "v", title: "% against usual" }] } },
      { data: { values: rows_ }, mark: { type: "line", strokeWidth: 3, color: colour, point: { filled: true, size: 55, color: colour } }, encoding: { x, y: { field: "m", type: "quantitative", axis: { title: ytitle } }, tooltip: [{ field: "off", title: "Minutes" }, { field: "m", title: "Average, % against usual", format: "+.0f" }, { field: "n", title: "Events" }] } }] }; };
  const durs = evs.map((e) => e.dur * 60).sort((a, b) => a - b), q = (p) => durs[Math.min(durs.length - 1, Math.floor(p * durs.length))], surv = []; for (let t = 0; t <= 180; t += 15) surv.push({ t, v: (durs.filter((d) => d > t).length / durs.length) * 100 });
  const survival = { title: "How long does it last?", width: pw, height: 230, data: { values: surv }, layer: [{ mark: { type: "line", interpolate: "step-after", strokeWidth: 3, color: c.ink }, encoding: { x: { field: "t", type: "quantitative", scale: { domain: [0, 180], nice: false }, axis: { title: "Minutes since the start", values: [0, 30, 60, 90, 120, 150, 180] } }, y: { field: "v", type: "quantitative", scale: { domain: [0, 100], nice: false }, axis: { title: "% still disrupted", values: [0, 25, 50, 75, 100] } } } },
    { mark: { type: "point", opacity: 0, size: 80 }, encoding: { x: { field: "t", type: "quantitative" }, y: { field: "v", type: "quantitative" }, tooltip: [{ field: "t", title: "Minutes since the start" }, { field: "v", title: "% still disrupted", format: ".0f" }] } }] };
  await embed(a2, { hconcat: [panel("trains_aff", "Trains running on the line", c.supply, "% against usual"), panel("crowd_aff", "Crowding at the line's stations", c.busy, "% against usual"), survival], spacing: 28 }, c);
  const at = (field, o) => { const r = stat(field).find((z) => z.off === o); return r ? r.m : null; }, f = (v) => (v === null ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(0)}%`), mins = (v) => (v < 60 ? `${Math.round(v)} minutes` : `${(v / 60).toFixed(1)} hours`);
  after.textContent = `If ${desc} starts on ${scope}: thirty minutes in, trains running are typically ${f(at("trains_aff", 30))} against usual and crowding at the affected stations ${f(at("crowd_aff", 30))}; an hour in, ${f(at("trains_aff", 60))} and ${f(at("crowd_aff", 60))}. Half of these are over within ${mins(q(0.5))} and one in four lasts longer than ${mins(q(0.75))}. Based on ${nEv} event${nEv === 1 ? "" : "s"} so far (every one collected, not just this week); with fewer than 5 each event is shown as a dot, and from 5 the shaded band is a 95% range from resampling events, which narrows as they accumulate. 'Against usual' means against the same time of day on days of the same type. The orange line moves with demand and the purple line is what TfL runs; trains falling before the start would suggest service was cut first. Planned works are left out.`;
}


// ================================================================ registry and mounting
export const CHARTS = {
  p1: { needs: ["system", "lines"], draw: dailyPlot },
  p2: { needs: ["stations", "boroughs", "network"], draw: stationTypes },
  p3: { needs: ["system", "lines"], draw: supplyRigidity },
  p4: { needs: ["typical", "typicalSupply", "stations"], draw: stationHeat },
  p5: { needs: ["stations"], draw: drawWaits },
  p6: { needs: ["strain", "boroughs", "network"], draw: strainView },
  appA: { needs: ["strained", "network", "strain"], draw: strainMoment },
  appB: { needs: ["events"], draw: whatNext },
};

const redrawChart = async (id) => { const n = document.querySelector(`[data-chart="${id}"]`); if (n) await drawOne(n, palette()); };


async function drawOne(node, c) {
  const id = node.dataset.chart, spec = CHARTS[id];
  if (!spec) { node.innerHTML = `<p class="err-msg">No chart called ${id}.</p>`; return; }
  try {
    const W = Math.max(600, Math.floor(node.clientWidth || 800)), D = {};
    for (const n of spec.needs) D[n] = await data(n);
    if (spec.draw) await spec.draw(node, c, W, D);
    else { const { area } = shell(node); await embed(area, spec.build(D, c, W), c); }
  } catch (e) { console.error(id, e); node.innerHTML = `<p class="err-msg">This chart could not be drawn: ${String(e.message || e).slice(0, 200)}</p>`; }
}

// Charts marked data-lazy (the appendix) are drawn when they scroll into view.
export async function mountAll() {
  const nodes = [...document.querySelectorAll("[data-chart]")], status = document.getElementById("status");
  const lazy = nodes.filter((n) => n.hasAttribute("data-lazy")), eager = nodes.filter((n) => !n.hasAttribute("data-lazy")), drawn = new WeakSet();
  const go = async () => { const c = palette(); for (const n of eager) await drawOne(n, c); for (const n of lazy) if (drawn.has(n)) await drawOne(n, c); window.__READY__ = true; };
  try {
    const S = await data("system"), days = S.daily.filter((d) => d.n >= 8);
    if (status) status.textContent = `${days.length} days of data, ${days[0].date} to ${days[days.length - 1].date}. Built ${S.generated.replace("T", " ")} UTC.`;
  } catch (e) { if (status) { status.textContent = "The processed data is not on the data branch yet. Run the build workflow in GitHub Actions, then reload."; status.classList.add("err"); } return; }
  await go();
  const io = new IntersectionObserver((es) => es.forEach(async (e) => { if (e.isIntersecting && !drawn.has(e.target)) { drawn.add(e.target); io.unobserve(e.target); await drawOne(e.target, palette()); } }), { rootMargin: "500px" });
  lazy.forEach((n) => io.observe(n));
  window.__forceLazy__ = async () => { for (const n of lazy) if (!drawn.has(n)) { drawn.add(n); await drawOne(n, palette()); } window.__LAZY_DONE__ = true; };
  let t; addEventListener("resize", () => { clearTimeout(t); t = setTimeout(go, 250); });
}
