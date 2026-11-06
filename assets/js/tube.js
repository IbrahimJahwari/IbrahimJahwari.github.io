// tube.js - helpers shared by the pages and the charts.
// The collector and the build write to the `data` branch; pages read it from there (public repo, no key needed).
export const DATA = "https://raw.githubusercontent.com/IbrahimJahwari/IbrahimJahwari.github.io/data/";

// Fetch one JSON file. Paths starting with "assets/" come from this site; everything else from the data branch.
// If a page defines window.__TUBE_INLINE__ (a preview with the data baked in), that is used instead.
export async function getJSON(path) {
  const inline = window.__TUBE_INLINE__ && window.__TUBE_INLINE__[path];
  if (inline) return inline;
  const url = path.startsWith("assets/") ? path : DATA + path + "?t=" + Date.now();
  const r = await fetch(url);
  if (!r.ok) throw new Error(path + " returned " + r.status);
  return r.json();
}

// build.py stores tables as {cols, rows}; this turns them back into a list of objects.
export function rows(t) {
  return t.rows.map((r) => Object.fromEntries(t.cols.map((c, i) => [c, r[i]])));
}

// base64 text -> Int8Array (the build stores matrices this way; -128 means missing)
export function dec8(b64) {
  const s = atob(b64), a = new Int8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = (s.charCodeAt(i) << 24) >> 24;
  return a;
}

export function londonTime(iso) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
}

// One plain sentence about the collector, built only from status.json.
export function heartbeatText(s, now = Date.now()) {
  const ageMin = Math.round((now - new Date(s.latest_run_utc)) / 60000);
  const t = londonTime(s.latest_run_utc);
  if (ageMin > 45) {
    const ago = ageMin < 120 ? ageMin + " minutes" : Math.round(ageMin / 60) + " hours";
    return { late: true, text: `The collector last ran at ${t} London time, ${ago} ago.` };
  }
  return { late: false, text: `Latest run ${t} London time. ${s.stations_with_data} of ${s.stations_total} stations reporting crowding, ${s.stations_with_lift_out} with a lift out.` };
}

// ---- colours: the page's CSS variables ----
export function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k) => cs.getPropertyValue("--" + k).trim();
  return { ink: v("ink"), ink2: v("ink2"), ink3: v("ink3"), rule: v("rule"), bg: v("bg"), panel: v("panel"),
           busy: v("busy"), quiet: v("quiet"), usual: v("usual"), supply: v("supply"), nodata: v("nodata") };
}

// Blend two #rrggbb colours: mix(a, b, 0) is a, mix(a, b, 1) is b.
export function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

export const LNAME = { bakerloo: "Bakerloo", central: "Central", circle: "Circle", district: "District",
                       "hammersmith-city": "Hammersmith & City", jubilee: "Jubilee", metropolitan: "Metropolitan",
                       northern: "Northern", piccadilly: "Piccadilly", victoria: "Victoria", "waterloo-city": "Waterloo & City" };
// TfL's line colours. They identify lines and never carry a value.
export const LINE_COLOURS = { bakerloo: "#B36305", central: "#E32017", circle: "#FFD300", district: "#00782A",
                              "hammersmith-city": "#F3A9BB", jubilee: "#A0A5A9", metropolitan: "#9B0056", northern: "#000000",
                              piccadilly: "#003688", victoria: "#0098D4", "waterloo-city": "#95CDBA" };
