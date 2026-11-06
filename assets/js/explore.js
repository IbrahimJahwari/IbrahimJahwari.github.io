// explore.js - the exploratory charts for explore.html, written as Vega-Lite specs.
//
// Each chart is one function: (data, colours, width) -> a Vega-Lite spec. Nothing is hard-coded to the
// number of days collected, so the same code draws six days now and six months later:
//   - medians are taken across whichever days exist (partial days are left out of them),
//   - panels that show one line per day switch to a median line plus faint days when there are many.
// To use a chart on project.html, copy its function and its entry in CHARTS, and write your own title and caption.
import { getJSON, rows, palette, mix, isDark } from "./tube.js";

const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LINES = ["bakerloo", "central", "circle", "district", "hammersmith-city", "jubilee",
               "metropolitan", "northern", "piccadilly", "victoria", "waterloo-city"];
const LNAME = { bakerloo: "Bakerloo", central: "Central", circle: "Circle", district: "District",
                "hammersmith-city": "Hammersmith & City", jubilee: "Jubilee", metropolitan: "Metropolitan",
                northern: "Northern", piccadilly: "Piccadilly", victoria: "Victoria", "waterloo-city": "Waterloo & City" };
const STATUS_LABEL = ["Good service", "Minor delays", "Severe delays or reduced service",
                      "Part suspended or part closed", "Suspended or closed", "Closed for the night"];
const PARTIAL_BELOW = 56;   // a day with fewer than 56 of its 64 service-hour slots counts as partial
const HOUR_EXPR = "(datum.value < 10 ? '0' : '') + datum.value + ':00'";
const DAYTYPES = ["Weekday", "Saturday", "Sunday"];

// ---------- data ----------
const pad = (n) => String(n).padStart(2, "0");
function dayInfo(date) {
  const d = new Date(date + "T12:00:00Z");
  const dow = d.getUTCDay();
  const mon = new Date(d.getTime() - ((dow + 6) % 7) * 86400000);
  return { dow, dname: DOW[dow], daytype: dow === 0 ? "Sunday" : dow === 6 ? "Saturday" : "Weekday",
           week: mon.toISOString().slice(0, 10) };
}
function stamp(t) {   // "2026-11-03T08:15"
  const h = +t.slice(11, 13), m = +t.slice(14, 16);
  return { date: t.slice(0, 10), hour: h + m / 60, hl: `${pad(h)}:${pad(m)}`, ...dayInfo(t.slice(0, 10)) };
}
const plusHour = (t) => {
  const d = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10), +t.slice(11, 13) + 1));
  return d.toISOString().slice(0, 13) + ":00";
};
const groupBy = (arr, key) => { const m = new Map(); for (const x of arr) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y), i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };

export async function loadData() {
  const [sys, lin, sta] = await Promise.all([
    getJSON("processed/system.json"), getJSON("processed/lines.json"), getJSON("processed/stations.json")]);
  const daily = rows(sys.daily).map((d) => ({ ...d, ...dayInfo(d.date), partial: d.n < PARTIAL_BELOW }));
  const partial = new Set(daily.filter((d) => d.partial).map((d) => d.date));
  const usable = new Set(daily.filter((d) => d.n >= 8).map((d) => d.date));   // days with almost no data are left out
  const slots = rows(sys.slots).map((s) => ({ ...s, ...stamp(s.t) })).filter((s) => usable.has(s.date)).map((s) => ({ ...s, partial: partial.has(s.date) }));
  const lines = rows(lin.lines).map((r) => ({ ...r, ...stamp(r.t), t2: plusHour(r.t) })).filter((r) => usable.has(r.date));
  return { slots, daily, partial, lines, stations: rows(sta.stations), generated: sys.generated };
}

// ---------- shared pieces ----------
function config(c) {
  return {
    font: "Atkinson Hyperlegible, system-ui, sans-serif",
    view: { stroke: null },
    axis: { labelColor: c.ink2, titleColor: c.ink2, domainColor: c.rule, tickColor: c.rule, gridColor: c.rule,
            labelFontSize: 12, titleFontSize: 12, titleFontWeight: 400, titlePadding: 8 },
    legend: { labelColor: c.ink2, titleColor: c.ink2, labelFontSize: 12, titleFontSize: 12, titleFontWeight: 400 },
    title: { color: c.ink, fontSize: 13, fontWeight: "bold", anchor: "start", offset: 8 },
    header: { labelColor: c.ink, labelFontSize: 13, labelFontWeight: "bold", titleColor: c.ink2 },
  };
}
const hourAxis = (values = [6, 9, 12, 15, 18, 21, 24]) => ({ title: null, values, labelExpr: HOUR_EXPR, grid: false });
const hourX = (extra = {}) => ({ field: "hour", type: "quantitative", scale: { domain: [5, 24], nice: false }, axis: hourAxis(), ...extra });
const rampOf = (c, key) => [c.usual, c[key]];
const lab = { interpolate: "lab" };
const gradientLegend = (title) => ({ title, orient: "bottom", direction: "horizontal", gradientLength: 260, titleLimit: 400 });
const partialDash = { condition: { test: "datum.partial", value: [4, 3] }, value: [1, 0] };
const lineName = `${JSON.stringify(LNAME)}[datum.value]`;

// ---------- A. The system ----------

// A1. The weekly rhythm: median crowding for every weekday and every 15 minutes.
function a1(D, c, W) {
  const data = D.slots.filter((s) => s.c != null && !s.partial && s.hour >= 5);
  const grid = [];
  for (const d of WEEK) for (let h = 5; h < 24; h += 0.25) grid.push({ dname: d, hour: h, hour2: h + 0.25 });
  const y = { field: "dname", type: "ordinal", sort: WEEK, axis: { title: null, domain: false, ticks: false } };
  return {
    width: W, height: 210, autosize: { type: "fit", contains: "padding" },
    layer: [
      { data: { values: grid }, mark: "rect", encoding: { x: hourX(), x2: { field: "hour2" }, y, color: { value: c.nodata }, opacity: { value: 0.35 } } },
      { data: { values: data }, mark: "rect",
    transform: [{ aggregate: [{ op: "median", field: "c", as: "c" }, { op: "distinct", field: "date", as: "days" }],
                  groupby: ["dname", "hour", "hl"] },
                { calculate: "datum.hour + 0.25", as: "hour2" }],
    encoding: {
      x: hourX(), x2: { field: "hour2" },
      y,
      color: { field: "c", type: "quantitative", scale: { range: rampOf(c, "busy"), zero: true, nice: true, ...lab },
               legend: gradientLegend("Average station crowding (% of own busiest week)") },
      tooltip: [{ field: "dname", title: "Day" }, { field: "hl", title: "From" },
                { field: "c", title: "Median crowding", format: ".1f" }, { field: "days", title: "Days in median" }],
    } },
    ],
  };
}

// A2. Every day as its own line, split by weekday, Saturday and Sunday. Dashed means a partial day.
function a2(D, c, W) {
  const data = D.slots.filter((s) => s.c != null && s.hour >= 5);
  const y = { field: "c", type: "quantitative", scale: { zero: true }, axis: { title: "Crowding, % of own busiest week", minExtent: 46 } };
  const pw = (W - 140) / 3;
  return {
    data: { values: data }, spacing: 14,
    facet: { column: { field: "daytype", type: "nominal", sort: DAYTYPES, header: { title: null, labelOrient: "top" } } },
    spec: {
      width: pw, height: 230,
      layer: [
        { mark: { type: "line", color: c.busy, opacity: 0.45, strokeWidth: 1.3 },
          encoding: { x: hourX(), y, detail: { field: "date", type: "nominal" }, strokeDash: partialDash } },
        { transform: [{ filter: "!datum.partial" }, { aggregate: [{ op: "median", field: "c", as: "c" }], groupby: ["daytype", "hour"] }],
          mark: { type: "line", color: c.busy, strokeWidth: 3 }, encoding: { x: hourX(), y } },
        { mark: { type: "point", opacity: 0, size: 80 },
          encoding: { x: hourX(), y, tooltip: [{ field: "date", title: "Date" }, { field: "hl", title: "Time" }, { field: "c", title: "Crowding", format: ".1f" }] } },
      ],
    },
  };
}

// A3. Day by day: one cell per date, a column per week. Faded cells are partial days.
function a3(D, c, W) {
  const data = D.daily.filter((d) => d.n >= 8);
  const weeks = [...new Set(data.map((d) => d.week))].sort();
  const step = Math.max(28, Math.min(64, Math.floor((W - 150) / 3 / Math.max(1, weeks.length))));
  const panel = (field, title, key, fmt, first) => {
    const vals = data.map((d) => d[field]).filter((v) => v != null);
    const mid = (Math.min(...vals) + Math.max(...vals)) / 2;
    return {
      title, data: { values: data }, width: { step }, height: { step: 28 },
      encoding: {
        x: { field: "week", type: "ordinal", sort: weeks, axis: { title: null, labelAngle: 0, ticks: false, domain: false,
             labelExpr: "utcFormat(toDate(datum.value), '%-d %b')" } },
        y: { field: "dname", type: "ordinal", sort: WEEK, axis: first ? { title: null, ticks: false, domain: false } : null },
      },
      layer: [
        { mark: { type: "rect", stroke: c.bg, strokeWidth: 3 },
          encoding: { color: { field, type: "quantitative", scale: { zero: false, range: rampOf(c, key), ...lab }, legend: null },
                      opacity: { condition: { test: "datum.partial", value: 0.45 }, value: 1 },
                      tooltip: [{ field: "date", title: "Date" }, { field, title, format: fmt }, { field: "n", title: "Slots with data (of 64)" }] } },
        { mark: { type: "text", fontSize: 11 },
          encoding: { text: { field, type: "quantitative", format: fmt },
                      color: { condition: { test: `datum.${field} > ${mid}`, value: "#ffffff" }, value: c.ink } } },
      ],
    };
  };
  return { hconcat: [panel("c", "Average crowding (%)", "busy", ".0f", true),
                     panel("tr", "Trains with a live prediction", "supply", ".0f", false),
                     panel("bad", "Line-hours not on good service", "ink", ".0f", false)], spacing: 22,
           resolve: { scale: { color: "independent" } } };
}

// A4. Demand and supply through the day: crowding on top, trains below, one column per day type.
function a4(D, c, W) {
  const u = (W - 160) / 3.5;
  const widths = { Weekday: u * 1.5, Saturday: u, Sunday: u };
  const maxC = Math.ceil(Math.max(...D.slots.filter((s) => s.c != null).map((s) => s.c)) / 5) * 5;
  const maxT = Math.ceil(Math.max(...D.slots.filter((s) => s.tr != null).map((s) => s.tr)) / 50) * 50;
  const row = (field, key, ydom, ytitle, withTitle) => ({
    hconcat: DAYTYPES.map((dt, i) => {
      const data = D.slots.filter((s) => s.daytype === dt && s[field] != null && s.hour >= 5);
      const y = { field, type: "quantitative", scale: { domain: [0, ydom] },
                  axis: i === 0 ? { title: ytitle, minExtent: 52 } : null };
      return {
        width: widths[dt], height: 150, data: { values: data },
        layer: [
          ...(withTitle ? [{ data: { values: [{ t: dt }] }, mark: { type: "text", x: 6, y: 6, align: "left", baseline: "top", fontWeight: "bold", fontSize: 13, color: c.ink }, encoding: { text: { field: "t" } } }] : []),
          { mark: { type: "line", color: c[key], opacity: 0.4, strokeWidth: 1.2 },
            encoding: { x: hourX(), y, detail: { field: "date", type: "nominal" }, strokeDash: partialDash } },
          { transform: [{ filter: "!datum.partial" }, { aggregate: [{ op: "median", field, as: field }], groupby: ["hour"] }],
            mark: { type: "line", color: c[key], strokeWidth: 3 }, encoding: { x: hourX(), y } },
          { mark: { type: "point", opacity: 0, size: 80 },
            encoding: { x: hourX(), y, tooltip: [{ field: "date", title: "Date" }, { field: "hl", title: "Time" }, { field, format: ".0f" }] } },
        ],
      };
    }),
    spacing: 14,
  });
  return { vconcat: [row("c", "busy", maxC, "Crowding (% of own busiest week)", true),
                     row("tr", "supply", maxT, "Trains with a live prediction", false)], spacing: 12 };
}

// A5. The same two measures against each other: the path a typical day traces, labelled by hour.
function a5(D, c, W) {
  const data = D.slots.filter((s) => s.c != null && s.tr != null && s.hour >= 5);
  const pw = (W - 190) / 3;
  const x = { field: "tr", type: "quantitative", scale: { zero: false }, axis: { title: "Trains with a live prediction", tickCount: 4 } };
  const y = { field: "c", type: "quantitative", scale: { zero: true }, axis: { title: "Crowding (% of own busiest week)", minExtent: 46 } };
  return {
    data: { values: data }, spacing: 14,
    transform: [{ filter: "!datum.partial" },
                { calculate: "floor(datum.hour)", as: "hh" },
                { aggregate: [{ op: "median", field: "c", as: "c" }, { op: "median", field: "tr", as: "tr" }], groupby: ["daytype", "hh"] },
                { calculate: "(datum.hh < 10 ? '0' : '') + datum.hh + ':00'", as: "lab" }],
    facet: { column: { field: "daytype", type: "nominal", sort: DAYTYPES, header: { title: null, labelOrient: "top" } } },
    spec: {
      width: pw, height: 240,
      layer: [
        { mark: { type: "line", color: c.ink3, strokeWidth: 1.6 }, encoding: { x, y, order: { field: "hh" } } },
        { transform: [{ filter: "datum.hh % 3 == 0 && datum.hh >= 6" }],
          mark: { type: "point", filled: true, color: c.ink, size: 40 },
          encoding: { x, y, tooltip: [{ field: "lab", title: "Hour" }, { field: "tr", title: "Trains", format: ".0f" }, { field: "c", title: "Crowding", format: ".1f" }] } },
        { transform: [{ filter: "datum.hh % 3 == 0 && datum.hh >= 6" }],
          mark: { type: "text", dx: 7, dy: -7, align: "left", fontSize: 11, color: c.ink2 },
          encoding: { x, y, text: { field: "lab" } } },
      ],
    },
  };
}

// A6. When service goes wrong: every line, every hour, coloured by its worst status.
function a6(D, c, W) {
  const data = D.lines.filter((r) => r.st != null);
  const bad = new Map(LINES.map((l) => [l, 0]));
  data.forEach((r) => { if (r.st >= 1 && r.st <= 4) bad.set(r.line, bad.get(r.line) + 1); });
  const order = [...LINES].sort((a, b) => bad.get(b) - bad.get(a));
  const midnights = [...new Set(data.map((r) => r.date))].map((d) => ({ d: d + "T00:00" }));
  const colours = [mix(c.usual, c.bg, 0.0), mix(c.usual, c.ink, 0.28), mix(c.usual, c.ink, 0.52),
                   mix(c.usual, c.ink, 0.76), c.ink, mix(c.bg, c.rule, 0.6)];
  return {
    width: W, height: 12 * 22, autosize: { type: "fit", contains: "padding" },
    layer: [
      { data: { values: data }, mark: { type: "rect", tooltip: true },
        encoding: {
          x: { field: "t", type: "temporal", axis: { title: null, format: "%a %-d", tickCount: { interval: "day", step: 1 }, labelAlign: "left", labelPadding: 6, grid: false } },
          x2: { field: "t2" },
          y: { field: "line", type: "nominal", sort: order, axis: { title: null, domain: false, ticks: false, labelExpr: lineName } },
          color: { field: "st", type: "nominal", scale: { domain: [0, 1, 2, 3, 4, 5], range: colours },
                   legend: { title: null, orient: "bottom", columns: 3, labelLimit: 300, labelExpr: `${JSON.stringify(STATUS_LABEL)}[datum.value]`, symbolType: "square", symbolSize: 120 } },
          tooltip: [{ field: "line", title: "Line" }, { field: "t", title: "Hour starting" }, { field: "st", title: "Status code (0 good, 4 suspended)" }],
        } },
      { data: { values: midnights }, mark: { type: "rule", color: c.bg, strokeWidth: 3 },
        encoding: { x: { field: "d", type: "temporal" } } },
    ],
  };
}

// ---------- B. Lines and stations ----------

// B1 and B2. Line by hour of day on weekdays. B1 colours by crowding, B2 by trains as a share of the line's own peak.
function lineHeat(field) {
  return (D, c, W) => {
    const base = D.lines.filter((r) => r.dow >= 1 && r.dow <= 5 && !D.partial.has(r.date) && r[field] != null && r.hour >= 5);
    const cells = [];
    for (const [line, rs] of groupBy(base, (r) => r.line)) {
      const byHour = [...groupBy(rs, (r) => r.hour)].map(([hour, v]) => ({ line, hour, v: field === "c" ? mean(v.map((r) => r.c)) : median(v.map((r) => r.tr)) }));
      const peak = Math.max(...byHour.map((h) => h.v));
      byHour.forEach((h) => cells.push({ line, hour: h.hour, hour2: h.hour + 1, v: field === "c" ? h.v : (h.v / peak) * 100 }));
    }
    const avg = new Map([...groupBy(cells, (r) => r.line)].map(([l, v]) => [l, mean(v.map((r) => r.v))]));
    const order = [...avg.keys()].sort((a, b) => avg.get(b) - avg.get(a));
    const title = field === "c" ? "Average crowding of the line's stations (% of own busiest week)" : "Trains as % of the line's own weekday peak";
    return {
      width: W, height: 12 * 24, autosize: { type: "fit", contains: "padding" }, data: { values: cells },
      mark: { type: "rect", stroke: c.bg, strokeWidth: 1 },
      encoding: {
        x: hourX({ axis: hourAxis([6, 8, 10, 12, 14, 16, 18, 20, 22, 24]) }), x2: { field: "hour2" },
        y: { field: "line", type: "nominal", sort: order, axis: { title: null, domain: false, ticks: false, labelExpr: lineName } },
        color: { field: "v", type: "quantitative", scale: { range: rampOf(c, field === "c" ? "busy" : "supply"), zero: true, nice: true, ...lab }, legend: gradientLegend(title) },
        tooltip: [{ field: "line", title: "Line" }, { field: "hour", title: "Hour starting" }, { field: "v", title, format: ".0f" }],
      },
    };
  };
}

// B3 and B4. One dot per station, with a few labelled. Both axes are the station's own typical crowding.
function scatter(xf, yf, xt, yt) {
  return (D, c, W) => {
    const pts = D.stations.filter((s) => s[xf] != null && s[yf] != null && s.n >= 100).map((s) => ({ ...s }));
    const max = Math.ceil(Math.max(...pts.map((s) => Math.max(s[xf], s[yf]))) / 10) * 10;
    const size = Math.min(W, 560);
    const side = size - 60, px = (v) => (v / max) * side;
    // candidates in order of interest; a label is kept only if its box clears the ones already kept
    const top = (key, n) => [...pts].sort((a, b) => key(b) - key(a)).slice(0, n);
    const cand = [...top((s) => Math.abs(s[yf] - s[xf]), 14), ...top((s) => Math.max(s[xf], s[yf]), 6)];
    const kept = [];
    for (const s of cand) {
      const box = { x: px(s[xf]) + 7, y: side - px(s[yf]) - 7, w: s.name.length * 6.4, h: 14 };
      if (kept.some((k) => box.x < k.box.x + k.box.w && box.x + box.w > k.box.x && box.y < k.box.y + k.box.h && box.y + box.h > k.box.y)) continue;
      if (box.x + box.w > side + 20) continue;
      kept.push({ s, box });
    }
    const picks = new Set(kept.map((k) => k.s.naptan));
    pts.forEach((s) => { s.lab = picks.has(s.naptan); s.ln = s.lines.split(";").map((l) => LNAME[l] || l).join(", "); });
    const x = { field: xf, type: "quantitative", scale: { domain: [0, max], nice: false }, axis: { title: xt } };
    const y = { field: yf, type: "quantitative", scale: { domain: [0, max], nice: false }, axis: { title: yt } };
    return {
      width: side, height: side, autosize: { type: "fit", contains: "padding" },
      layer: [
        { data: { values: [{ a: 0 }, { a: max }] }, mark: { type: "line", color: c.ink3, strokeDash: [4, 4] },
          encoding: { x: { ...x, field: "a" }, y: { ...y, field: "a" } } },
        { data: { values: pts }, mark: { type: "circle", color: c.busy, opacity: 0.7, size: 46 },
          encoding: { x, y, tooltip: [{ field: "name", title: "Station" }, { field: "ln", title: "Lines" },
                                       { field: "am", title: "Weekday 07-10", format: ".1f" }, { field: "pm", title: "Weekday 16-19", format: ".1f" },
                                       { field: "sat", title: "Saturday", format: ".1f" }, { field: "sun", title: "Sunday", format: ".1f" }] } },
        { data: { values: pts.filter((s) => s.lab) }, mark: { type: "text", dx: 7, align: "left", fontSize: 11, color: c.ink },
          encoding: { x, y, text: { field: "name" } } },
      ],
    };
  };
}

export const CHARTS = [
  { id: "a1", build: a1 }, { id: "a2", build: a2 }, { id: "a3", build: a3 }, { id: "a4", build: a4 },
  { id: "a5", build: a5 }, { id: "a6", build: a6 },
  { id: "b1", build: lineHeat("c") }, { id: "b2", build: lineHeat("tr") },
  { id: "b3", build: scatter("wk", "sat", "Typical weekday crowding (Mon-Fri, 06-22)", "Typical Saturday crowding (08-20)") },
  { id: "b4", build: scatter("am", "pm", "Weekday morning crowding (07-10)", "Weekday evening crowding (16-19)") },
];

// ---------- drawing ----------
async function draw(chart, D, c) {
  const el = document.getElementById(chart.id + "-plot");
  if (!el) return;
  try {
    const W = Math.max(600, Math.floor(el.clientWidth || 800));   // narrower screens scroll sideways instead of squashing
    const spec = { $schema: "https://vega.github.io/schema/vega-lite/v6.json", background: "transparent", config: config(c), ...chart.build(D, c, W) };
    el.textContent = "";
    await vegaEmbed(el, spec, { actions: false, renderer: "svg", tooltip: { theme: isDark() ? "dark" : "light" } });
  } catch (e) {
    console.error(chart.id, e);
    el.innerHTML = `<p class="err-msg">This chart could not be drawn: ${String(e.message || e).slice(0, 160)}</p>`;
  }
}

export async function start() {
  const status = document.getElementById("status");
  let D;
  try {
    D = await loadData();
  } catch (e) {
    status.textContent = "The processed data is not on the data branch yet. Run the build workflow in GitHub Actions, then reload.";
    status.classList.add("err");
    return;
  }
  const days = D.daily.filter((d) => d.n >= 8);
  status.textContent = `${days.length} days of data, ${days[0].date} to ${days[days.length - 1].date}, ${D.slots.length} quarter-hour slots. Built ${D.generated.replace("T", " ")} UTC.`;
  const drawAll = async () => { const c = palette(); for (const ch of CHARTS) await draw(ch, D, c); window.__EXPLORE_READY__ = true; };
  await drawAll();
  let t;
  addEventListener("resize", () => { clearTimeout(t); t = setTimeout(drawAll, 200); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
}
