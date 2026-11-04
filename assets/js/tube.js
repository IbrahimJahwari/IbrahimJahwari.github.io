// tube.js - helpers shared by the home page and the charts.
// The collector writes to the `data` branch; pages read it from there (public repo, no key needed).
export const DATA = "https://raw.githubusercontent.com/IbrahimJahwari/IbrahimJahwari.github.io/data/";

// Fetch one JSON file from the data branch. The timestamp stops the browser reusing an old copy.
export async function getJSON(path) {
  const r = await fetch(DATA + path + "?t=" + Date.now());
  if (!r.ok) throw new Error(path + " returned " + r.status);
  return r.json();
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
