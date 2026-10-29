"""collect.py - one snapshot of the Tube network, appended to daily CSV files.

Run by GitHub Actions every 15 minutes (.github/workflows/collect.yml), or by hand:
    TFL_APP_KEY=... python pipeline/collect.py

Writes to $DATA_DIR/raw/YYYY-MM-DD/ (default _data/raw/..., which is git-ignored;
in CI DATA_DIR is the checked-out `data` branch) (all rows share one run_utc, the join key):
    crowding             live crowding for every Underground station (demand proxy)
    line_status          status of every rail line (supply shock: delays, closures)
    lifts                lifts currently out of service (accessibility shock)
    station_disruptions  station-level disruptions (supply shock)
    line_supply          trains with predictions, per line and direction (supply)
    station_supply       trains due in 15 min, per station/line/direction (hourly only)
    collection_log       one row per source per run, so gaps and failures are visible
"""
import argparse
import csv
import json
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from tfl_common import (RAIL_MODES, RAW, TUBE_LINES, WORKERS, Api, discover_stations, get_key)

LOG_HEADER = ["run_utc", "source", "ok", "http_status", "n_items", "n_errors", "seconds", "note"]
NORMAL_STATUS = (10, 18)  # Good Service / No Issues


class Store:
    def __init__(self, root, run_utc):
        self.dir = Path(root) / run_utc[:10]
        self.dir.mkdir(parents=True, exist_ok=True)

    def append(self, table, header, rows):
        path = self.dir / f"{table}.csv"
        new = not path.exists()
        with open(path, "a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(header)
            w.writerows(rows)


def load_station_ids(api, root):
    ref = Path(root) / "reference" / "stations.csv"
    if ref.exists():
        with open(ref, encoding="utf-8") as f:
            ids = [r["naptan"] for r in csv.DictReader(f)]
        if ids:
            return ids
    return sorted(discover_stations(api))  # fallback if build_reference.py has not been run


def simple(api, path):
    r = api.get(path)
    body = r["body"] if isinstance(r["body"], list) else None
    return r, body


def collect_crowding(api, run, station_ids):
    def one(nid):
        return nid, api.get(f"/crowding/{nid}/Live")

    rows, errs, avail = [], 0, 0
    with ThreadPoolExecutor(WORKERS) as ex:
        for nid, r in ex.map(one, station_ids):
            b = r["body"]
            if r["err"] or not isinstance(b, dict):
                errs += 1
                rows.append([run, nid, "", "", "", "", r["err"] or "unexpected body"])
                continue
            avail += bool(b.get("dataAvailable"))
            rows.append([run, nid, b.get("dataAvailable"), b.get("percentageOfBaseline", ""),
                         b.get("timeUtc", ""), b.get("timeLocal", ""), ""])
    header = ["run_utc", "naptan", "data_available", "pct_baseline", "obs_utc", "obs_local", "error"]
    log = ["crowding", errs == 0, "", len(rows), errs, "", f"{avail} stations with data"]
    return [("crowding", header, rows)], log


def collect_line_status(api, run):
    r, body = simple(api, f"/Line/Mode/{RAIL_MODES}/Status")
    if body is None:
        return [], ["line_status", False, r["status"], 0, 1, r["secs"], r["err"] or "unexpected body"]
    rows = []
    for line in body:
        for i, st in enumerate(line.get("lineStatuses", [])):
            sev = st.get("statusSeverity")
            reason = "" if sev in NORMAL_STATUS else " ".join((st.get("reason") or "").split())
            rows.append([run, line.get("id"), line.get("modeName"), i, sev,
                         st.get("statusSeverityDescription"), reason])
    header = ["run_utc", "line_id", "mode", "status_index", "severity", "description", "reason"]
    return [("line_status", header, rows)], ["line_status", True, r["status"], len(rows), 0, r["secs"], ""]


def collect_lifts(api, run):
    r, body = simple(api, "/Disruptions/Lifts/v2")
    if body is None:
        return [], ["lifts", False, r["status"], 0, 1, r["secs"], r["err"] or "unexpected body"]
    rows = []
    for d in body:
        ids = d.get("disruptedLiftUniqueIds") or []
        rows.append([run, d.get("stationUniqueId"), ";".join(ids), len(ids),
                     " ".join((d.get("message") or "").split())])
    header = ["run_utc", "station_id", "lift_ids", "n_lifts_out", "message"]
    # zero rows with ok=True means "no lifts out", which is different from a failed call
    return [("lifts", header, rows)], ["lifts", True, r["status"], len(rows), 0, r["secs"], ""]


def collect_station_disruptions(api, run):
    r, body = simple(api, "/StopPoint/Mode/tube/Disruption")
    if body is None:
        return [], ["station_disruptions", False, r["status"], 0, 1, r["secs"], r["err"] or "unexpected body"]
    rows = [[run, d.get("atcoCode") or d.get("stationAtcoCode"), d.get("commonName"), d.get("type"),
             d.get("fromDate"), d.get("toDate"), json.dumps(d, separators=(",", ":"))] for d in body]
    header = ["run_utc", "atco_code", "common_name", "type", "from_date", "to_date", "item_json"]
    return [("station_disruptions", header, rows)], \
        ["station_disruptions", True, r["status"], len(rows), 0, r["secs"], ""]


def collect_supply(api, run, hourly):
    line_rows, station_rows, errs, n_pred = [], [], 0, 0

    def one(line):
        return line, api.get(f"/Line/{line}/Arrivals")

    with ThreadPoolExecutor(4) as ex:
        for line, r in ex.map(one, TUBE_LINES):
            if r["err"] or not isinstance(r["body"], list):
                errs += 1
                continue
            preds = r["body"]
            n_pred += len(preds)
            by_dir = defaultdict(list)
            for p in preds:
                by_dir[p.get("direction") or "unknown"].append(p)
            for direction, ps in by_dir.items():
                vehicles = {p.get("vehicleId") for p in ps if p.get("vehicleId")}
                stops = {p.get("naptanId") for p in ps}
                line_rows.append([run, line, direction, len(ps), len(vehicles), len(stops)])
                if not hourly:
                    continue
                per = defaultdict(list)
                for p in ps:
                    per[p.get("naptanId")].append(p)
                for nid, qs in per.items():
                    times = [q.get("timeToStation") for q in qs if isinstance(q.get("timeToStation"), (int, float))]
                    soon = {q.get("vehicleId") for q in qs
                            if isinstance(q.get("timeToStation"), (int, float)) and q["timeToStation"] <= 900}
                    station_rows.append([run, nid, line, direction, len(soon), min(times) if times else ""])
    tables = [("line_supply", ["run_utc", "line_id", "direction", "n_predictions", "n_vehicles", "n_stations"], line_rows)]
    if hourly:
        tables.append(("station_supply", ["run_utc", "naptan", "line_id", "direction",
                                          "trains_next_15m", "next_arrival_s"], station_rows))
    return tables, ["supply", errs == 0, "", len(line_rows), errs, "", f"{n_pred} predictions, hourly={hourly}"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(RAW), help="folder for the daily raw files")
    args = ap.parse_args()

    key = get_key()
    if not key:
        print("No API key. Set TFL_APP_KEY (GitHub secret, environment variable or .env file).")
        return 1
    api = Api(key)
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    run = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    hourly = now.minute < 15  # station-level supply is stored once an hour to keep files small
    store = Store(args.out, run)
    station_ids = load_station_ids(api, args.out)
    print(f"run {run} | {len(station_ids)} stations | hourly={hourly}")

    jobs = [
        ("crowding", lambda: collect_crowding(api, run, station_ids)),
        ("line_status", lambda: collect_line_status(api, run)),
        ("lifts", lambda: collect_lifts(api, run)),
        ("station_disruptions", lambda: collect_station_disruptions(api, run)),
        ("supply", lambda: collect_supply(api, run, hourly)),
    ]
    log_rows, n_ok = [], 0
    for name, fn in jobs:
        t0 = time.time()
        try:
            tables, log = fn()
        except Exception as e:  # one broken source must not lose the others
            tables, log = [], [name, False, "", 0, 1, "", f"exception {type(e).__name__}: {str(e)[:100]}"]
        for table, header, rows in tables:
            if rows:
                store.append(table, header, rows)
        log[5] = log[5] if log[5] != "" else round(time.time() - t0, 2)
        n_ok += bool(log[1])
        log_rows.append([run] + log)
        print(f"  {'ok  ' if log[1] else 'FAIL'} {name:20s} items={log[3]} errors={log[4]} {log[6]}")
    store.append("collection_log", LOG_HEADER, log_rows)
    return 0 if n_ok else 2


if __name__ == "__main__":
    sys.exit(main())
