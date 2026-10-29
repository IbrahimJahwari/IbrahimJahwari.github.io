"""process.py - build processed/status.json from the latest raw snapshot.

Standard library only, so the GitHub Action needs no extra installs. This is the
'heartbeat' that proves the pipeline works end to end; real analysis comes later.
"""
import argparse
import csv
import json
import os
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR") or ROOT / "_data")


def read(path):
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=str(DATA / "raw"))
    ap.add_argument("--out", default=str(DATA / "processed"))
    args = ap.parse_args()
    raw, out = Path(args.raw), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    days = sorted(d for d in raw.iterdir() if d.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", d.name))
    status = {"generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    if days:
        day = days[-1]
        log = read(day / "collection_log.csv")
        runs = sorted({r["run_utc"] for r in log})
        if runs:
            latest = runs[-1]
            # keyed by station, so a manual run in the same minute as a scheduled one is not double counted
            crowd = list({r["naptan"]: r for r in read(day / "crowding.csv") if r["run_utc"] == latest}.values())
            with_data = [r for r in crowd if r["data_available"] == "True" and r["pct_baseline"] != ""]
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
    (out / "status.json").write_text(json.dumps(status, indent=1))
    print("wrote", out / "status.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
