// tube.js - helpers shared by the home page and the charts.
// The collector and the build write to the `data` branch; pages read it from there (public repo, no key needed).
export const DATA = "https://raw.githubusercontent.com/IbrahimJahwari/IbrahimJahwari.github.io/data/";

// Fetch one JSON file from the data branch. The timestamp stops the browser reusing an old copy.
// If a page defines window.__TUBE_INLINE__ (a preview with the data baked in), that is used instead.
export async function getJSON(path) {
  const inline = window.__TUBE_INLINE__ && window.__TUBE_INLINE__[path];
  if (inline) return inline;
  const r = await fetch(DATA + path + "?t=" + Date.now());
  if (!r.ok) throw new Error(path + " returned " + r.status);
  return r.json();
}

// build.py stores tables as {cols, rows}; this turns them back into a list of objects.
export function rows(t) {
  return t.rows.map((r) => Object.fromEntries(t.cols.map((c, i) => [c, r[i]])));
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

// ---- colours: the page's CSS variables, so charts follow light and dark mode ----
export function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k) => cs.getPropertyValue("--" + k).trim();
  return { ink: v("ink"), ink2: v("ink2"), ink3: v("ink3"), rule: v("rule"), bg: v("bg"), panel: v("panel"),
           busy: v("busy"), usual: v("usual"), supply: v("supply"), nodata: v("nodata") };
}

// Blend two #rrggbb colours: mix(a, b, 0) is a, mix(a, b, 1) is b.
export function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

export const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
