"""process.py - turn the latest raw snapshot into small files the website can load.

Standard library only, so the GitHub Action needs no extra installs. Writes to $DATA_DIR/processed/:
    status.json      pipeline heartbeat (latest run, stations reporting, failures)
    map_latest.json  one record per station: live crowding, TfL's typical value for the same
                     weekday and 15-minute band, and the difference (live minus typical)
"""
import argparse
import csv
import gzip
import json
import os
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR") or ROOT / "_data")
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def read(path):
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def band_label(local_str):
    """'2026-10-30 09:07:00' -> ('Fri', '09:00-09:15'), matching TfL's typical-profile labels."""
    t = datetime.strptime(local_str[:16], "%Y-%m-%d %H:%M")
    start = t.hour * 60 + t.minute // 15 * 15
    end = (start + 15) % (24 * 60)
    fmt = lambda m: f"{m // 60:02d}:{m % 60:02d}"
    return DAYS[t.weekday()], f"{fmt(start)}-{fmt(end)}"


def load_typical(raw):
    path = raw / "reference" / "typical_crowding.csv.gz"
    typical = {}
    if path.exists():
        with gzip.open(path, "rt", newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if r["pct_baseline"] != "":
                    typical[(r["naptan"], r["day"], r["time_band"])] = float(r["pct_baseline"])
    return typical


def to_float(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=str(DATA / "raw"))
    ap.add_argument("--out", default=str(DATA / "processed"))
    args = ap.parse_args()
    raw, out = Path(args.raw), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    days = sorted(d for d in raw.iterdir() if d.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", d.name))
    status = {"generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    map_out = {"generated_utc": status["generated_utc"], "stations": []}
    if days:
        day = days[-1]
        log = read(day / "collection_log.csv")
        runs = sorted({r["run_utc"] for r in log})
        if runs:
            latest = runs[-1]
            # keyed by station, so a manual run in the same minute as a scheduled one is not double counted
            crowd = {r["naptan"]: r for r in read(day / "crowding.csv") if r["run_utc"] == latest}
            with_data = [r for r in crowd.values() if r["data_available"] == "True" and r["pct_baseline"] != ""]
            vals = [float(r["pct_baseline"]) for r in with_data]
            lines = [r for r in read(day / "line_status.csv")
                     if r["run_utc"] == latest and r["severity"] not in ("10", "18")]
            lifts = [r for r in read(day / "lifts.csv") if r["run_utc"] == latest]
            status.update({
                "latest_run_utc": latest,
                "latest_observation_utc": max((r["obs_utc"] for r in with_data), default=""),
                "runs_today": len(runs),
                "stations_total": len(crowd),
                "stations_with_data": len(with_data),
                "median_crowding": round(statistics.median(vals), 3) if vals else None,
                "lines_not_good_service": sorted({r["line_id"] for r in lines}),
                "stations_with_lift_out": len({r["station_id"] for r in lifts}),
                "failed_source_calls_today": sum(1 for r in log if r["ok"] == "False"),
            })

            # ---- map: live vs TfL's typical value for the same weekday and 15-minute band
            typical = load_typical(raw)
            map_out["run_utc"] = latest
            for s in read(raw / "reference" / "stations.csv"):
                c = crowd.get(s["naptan"])
                live = to_float(c["pct_baseline"]) if c and c["data_available"] == "True" else None
                typ = excess = None
                obs = c["obs_utc"] if c else ""
                if live is not None and c["obs_local"]:
                    d, b = band_label(c["obs_local"])
                    typ = typical.get((s["naptan"], d, b))
                    if typ is not None:
                        excess = round(live - typ, 4)
                map_out["stations"].append({
                    "id": s["naptan"], "name": s["name"], "lat": to_float(s["lat"]), "lon": to_float(s["lon"]),
                    "lines": s["lines"].split(";"), "lifts": to_float(s["lifts"]),
                    "live": None if live is None else round(live, 4), "typical": typ,
                    "excess": excess, "obs_utc": obs,
                })
    (out / "status.json").write_text(json.dumps(status, indent=1))
    (out / "map_latest.json").write_text(json.dumps(map_out, separators=(",", ":")))
    print("wrote", out / "status.json", "and", out / "map_latest.json", f"({len(map_out['stations'])} stations)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
