"""Fetch the stop order of every Tube line from TfL, so each direction can be named by where it is heading.

TfL publishes, for every line and direction, the ordered stops of each regular route
(GET /Line/{id}/Route/Sequence/{direction}, field orderedLineRoutes). build.py uses them to name every
direction "towards <end of the line>, next stop <station>" and to know where trains really end.

Usage: python code/fetch_routes.py OUT.json        (TFL_APP_KEY is read from the environment if set)
Writes {line: {direction: [[naptan, naptan, ...], ...]}}, one list per route, in the direction of travel.
It never fails the workflow: if nothing can be fetched it leaves any existing file alone.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://api.tfl.gov.uk"
LINES = ["bakerloo", "central", "circle", "district", "hammersmith-city", "jubilee",
         "metropolitan", "northern", "piccadilly", "victoria", "waterloo-city"]


def get(path, key):
    query = {"serviceTypes": "Regular"}
    if key:
        query["app_key"] = key
    url = f"{BASE}{path}?{urllib.parse.urlencode(query)}"
    err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pp434-tube-project"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:                      # network error, 429, bad JSON: try again, then give up quietly
            err = e
            time.sleep(2 * (attempt + 1))
    print(f"  {path}: {err}")
    return None


def routes_from(body):
    out = []
    for r in (body or {}).get("orderedLineRoutes") or []:
        ids = [i for i in (r.get("naptanIds") or []) if isinstance(i, str)]
        if len(ids) >= 2:
            out.append(ids)
    return out


def main(out_path):
    key = os.environ.get("TFL_APP_KEY")
    result = {line: {d: routes_from(get(f"/Line/{line}/Route/Sequence/{d}", key)) for d in ("inbound", "outbound")} for line in LINES}
    n = sum(len(v) for d in result.values() for v in d.values())
    if n == 0:
        print("no route sequences fetched; leaving any existing file as it is")
        return 0
    path = Path(out_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    print(f"{n} routes written to {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "routes.json"))
