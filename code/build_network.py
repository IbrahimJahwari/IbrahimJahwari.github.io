"""build_network.py - one-off: station positions, line connections and borough outlines for the maps.

Writes  assets/data/network.json      stations (with a centre-enlarged position for the network diagram),
                                      edges between consecutive stations on each line, and the longest route of each line
        assets/data/boroughs.geojson  London borough outlines, simplified so the file stays small

Run it once from the repo root:   python code/build_network.py
It needs the station list the collector keeps on the data branch (raw/reference/stations.csv); point DATA_DIR at it.

Where the connections come from: an open dataset of Tube connections (github.com/nicola/tubemaps), matched to TfL's station
IDs by name, with a few manual fixes. It is a stand-in: TfL's /Line/{id}/Route/Sequence would replace it.
"""
import collections
import csv
import io
import json
import math
import os
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR") or ROOT / "_data")
OUT = ROOT / "assets" / "data"
TUBES = "https://raw.githubusercontent.com/nicola/tubemaps/master/datasets/"
BOROUGHS = "https://raw.githubusercontent.com/radoi90/housequest-data/master/london_boroughs.geojson"
TUBE = ["bakerloo", "central", "circle", "district", "hammersmith-city", "jubilee",
        "metropolitan", "northern", "piccadilly", "victoria", "waterloo-city"]
LINE_OF = {1: "bakerloo", 2: "central", 3: "circle", 4: "district", 6: "hammersmith-city", 7: "jubilee",
           8: "metropolitan", 9: "northern", 10: "piccadilly", 11: "victoria", 12: "waterloo-city"}
# open-dataset station id -> TfL station ids, where the names differ
MANUAL = {82: ["940GZZLUERB"], 83: ["940GZZLUERC"], 114: ["940GZZLUHAW"], 117: ["940GZZLUHRC"], 197: ["940GZZLUPCC"],
          226: ["940GZZLUSBC"], 227: ["940GZZLUSBM"], 110: ["940GZZLUHSD", "940GZZLUHSC"], 193: ["940GZZLUPAC", "940GZZLUPAH"]}
EXTRA = [("940GZZLULRD", "940GZZLUWLA", "hammersmith-city"), ("940GZZLUWLA", "940GZZLUSBM", "hammersmith-city"),
         ("940GZZLULRD", "940GZZLUWLA", "circle"), ("940GZZLUWLA", "940GZZLUSBM", "circle"),
         ("940GZZLUHRC", "940GZZLUHR5", "piccadilly")]
LAT0, LON0 = 51.5085, -0.1257


def fetch(name):
    return urllib.request.urlopen(TUBES + name, timeout=30).read().decode("utf-8")


def norm(s):
    s = s.lower().replace("&", "and").replace("'", "").replace(".", "")
    s = re.sub(r"\(.*?\)", "", s)
    return re.sub(" +", " ", re.sub(r"[^a-z0-9 ]", "", s)).strip()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    stations = [r for r in csv.DictReader(open(DATA / "raw" / "reference" / "stations.csv", encoding="utf-8"))
                if r["naptan"].startswith("940GZZLU")]
    for s in stations:
        s["lat"], s["lon"] = float(s["lat"]), float(s["lon"])
        s["lines"] = [l for l in s["lines"].split(";") if l in TUBE]
    by_id = {s["naptan"]: s for s in stations}
    by_name = collections.defaultdict(list)
    for s in stations:
        by_name[norm(s["name"])].append(s["naptan"])

    # positions in km from Charing Cross, with the centre enlarged so the middle of the network opens up
    kx, ky = 111.32 * math.cos(math.radians(LAT0)), 110.57
    for s in stations:
        x, y = (s["lon"] - LON0) * kx, (s["lat"] - LAT0) * ky
        r, th = math.hypot(x, y), math.atan2(y, x)
        rc = 4.2 * (r / 4.2) ** 0.55
        s["x"], s["y"] = round(rc * math.cos(th), 3), round(rc * math.sin(th), 3)

    names = {int(r["id"]): r["name"] for r in csv.DictReader(io.StringIO(fetch("london.stations.csv")))}
    cand = {i: MANUAL.get(i, by_name.get(norm(n), [])) for i, n in names.items()}

    def pick(sid, line, other_name):
        c = [n for n in cand.get(sid, []) if line in by_id[n]["lines"]]
        if len(c) > 1:   # the two Paddington stations
            keep = [n for n in c if (n == "940GZZLUPAH") == ("Royal Oak" in (other_name or ""))]
            c = keep or c
        return c[0] if c else None

    edges = set()
    for e in csv.DictReader(io.StringIO(fetch("london.connections.csv"))):
        line = LINE_OF.get(int(e["line"]))
        if not line:
            continue
        s1, s2 = int(e["station1"]), int(e["station2"])
        a, b = pick(s1, line, names.get(s2)), pick(s2, line, names.get(s1))
        if a and b and a != b:
            edges.add((min(a, b), max(a, b), line))
    edges |= {(min(a, b), max(a, b), l) for a, b, l in EXTRA}
    for line in ("hammersmith-city", "circle"):   # the open data links these through Wood Lane; drop the shortcut
        edges.discard(("940GZZLULRD", "940GZZLUSBM", line))
    edges = sorted(edges)

    # the longest route of each line, west to east (or north to south), for the time-space diagram
    trunk = {}
    for line in TUBE:
        adj = collections.defaultdict(list)
        for a, b, l in edges:
            if l == line:
                adj[a].append(b)
                adj[b].append(a)
        if not adj:
            continue

        def bfs(src):
            dist, prev, q = {src: 0}, {src: None}, collections.deque([src])
            while q:
                u = q.popleft()
                for v in adj[u]:
                    if v not in dist:
                        dist[v], prev[v] = dist[u] + 1, u
                        q.append(v)
            return max(dist, key=dist.get), prev

        a, _ = bfs(next(iter(adj)))
        b, prev = bfs(a)
        path = [b]
        while prev[path[-1]] is not None:
            path.append(prev[path[-1]])
        if by_id[path[0]]["lon"] > by_id[path[-1]]["lon"]:
            path.reverse()
        trunk[line] = path

    linked = {n for a, b, _ in edges for n in (a, b)}
    print("stations without a connection:", [s["name"] for s in stations if s["naptan"] not in linked])
    out = {"stations": [{"id": s["naptan"], "name": s["name"], "x": s["x"], "y": s["y"], "lines": s["lines"]} for s in stations],
           "edges": [[a, b, l] for a, b, l in edges], "trunk": trunk}
    (OUT / "network.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print("network.json", len(json.dumps(out)) // 1000, "KB")

    # borough outlines
    gj = json.loads(urllib.request.urlopen(BOROUGHS, timeout=60).read().decode("utf-8"))
    try:
        from shapely.geometry import mapping, shape
        for f in gj["features"]:
            f["geometry"] = mapping(shape(f["geometry"]).simplify(0.0012, preserve_topology=True))
    except ImportError:
        print("shapely not installed: borough outlines left unsimplified")

    def rnd(o):
        return [rnd(x) for x in o] if isinstance(o, (list, tuple)) else round(o, 4)
    for f in gj["features"]:
        f["geometry"]["coordinates"] = rnd(f["geometry"]["coordinates"])
        f["properties"] = {"name": f["properties"]["name"]}
    (OUT / "boroughs.geojson").write_text(json.dumps(gj, separators=(",", ":")), encoding="utf-8")
    print("boroughs.geojson", len(json.dumps(gj)) // 1000, "KB")


if __name__ == "__main__":
    main()
