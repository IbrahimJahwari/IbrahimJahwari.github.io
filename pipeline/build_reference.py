"""build_reference.py - one-off (re-run monthly): station list, lift counts, typical crowding.

    TFL_APP_KEY=... python pipeline/build_reference.py

Writes to $DATA_DIR/raw/reference/:
    stations.csv             every Underground station: ids, hub code, lat/lon, lines, lift count
    typical_crowding.csv.gz  TfL's typical crowding per station, weekday and 15-minute band
The collector reads stations.csv; the typical profile is the baseline for 'live minus typical'.
"""
import argparse
import csv
import gzip
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from tfl_common import RAW, WORKERS, Api, discover_stations, get_key

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(RAW), help="raw data folder (reference/ is created inside)")
    args = ap.parse_args()
    key = get_key()
    if not key:
        print("No API key. Set TFL_APP_KEY or add it to .env")
        return 1
    api = Api(key)
    ref = Path(args.out) / "reference"
    ref.mkdir(parents=True, exist_ok=True)

    stations = discover_stations(api)
    print(f"{len(stations)} stations found")

    def facility(nid):
        r = api.get(f"/StopPoint/{nid}")
        props = {}
        if isinstance(r["body"], dict):
            props = {f"{p.get('category')}:{p.get('key')}": p.get("value")
                     for p in r["body"].get("additionalProperties", [])}
        return nid, props

    with ThreadPoolExecutor(WORKERS) as ex:
        for nid, props in ex.map(facility, stations):
            stations[nid]["lifts"] = to_int(props.get("Facility:Lifts"))

    def typical(job):
        nid, day = job
        r = api.get(f"/crowding/{nid}/{day}")
        b = r["body"] if isinstance(r["body"], dict) else {}
        return nid, day, b.get("timeBands") or []

    rows, has = [], set()
    jobs = [(nid, d) for nid in stations for d in DAYS]
    with ThreadPoolExecutor(WORKERS) as ex:
        for nid, day, bands in ex.map(typical, jobs):
            for band in bands:
                rows.append([nid, day, band.get("timeBand"), band.get("percentageOfBaseLine")])
                has.add(nid)
    with gzip.open(ref / "typical_crowding.csv.gz", "wt", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["naptan", "day", "time_band", "pct_baseline"])
        w.writerows(rows)

    with open(ref / "stations.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["naptan", "name", "hub_code", "lat", "lon", "lines", "lifts", "has_typical"])
        for nid, s in sorted(stations.items()):
            w.writerow([nid, s["name"], s["hub"], s["lat"], s["lon"], ";".join(sorted(s["lines"])),
                        s.get("lifts", ""), nid in has])
    print(f"stations.csv: {len(stations)} rows | typical profiles: {len(has)} stations, {len(rows)} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
