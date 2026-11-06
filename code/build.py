"""build.py - turn the raw collector CSVs into small, tidy JSON files for the charts.

Reads   $DATA_DIR/raw/YYYY-MM-DD/{crowding,line_supply,line_status,station_disruptions}.csv
        $DATA_DIR/raw/reference/stations.csv
Writes  $DATA_DIR/processed/system.json    the whole network, one row per 15-minute slot, plus one row per day
        $DATA_DIR/processed/lines.json     one row per line per hour
        $DATA_DIR/processed/stations.json  one row per station (weekday, Saturday and Sunday averages)

Run by .github/workflows/build.yml once a day, or by hand:
    DATA_DIR=path/to/data-branch python pipeline/build.py

Every file is rewritten from scratch, so the numbers always match the raw data. Tables are stored as
{"cols": [...], "rows": [[...], ...]} because that is about three times smaller than a list of objects;
assets/js/tube.js turns them back into objects for the charts.

What the numbers mean
  crowding   TfL's live index for a station: how busy it is as a share of that station's own busiest-week level.
             'c' is the unweighted average over stations that report and are not closed. It is a measure of how
             busy the typical station is, not a count of people, and levels are not comparable between stations.
  trains     trains with a live arrival prediction, summed over the 11 Tube lines. A good proxy for trains running,
             not an exact count: TfL only predicts a train once it is close to a station.
  status     the worst line status in the period, on a 0-5 scale (see STATUS below).
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR") or ROOT / "_data")
RAW, PROCESSED = DATA / "raw", DATA / "processed"
LONDON = "Europe/London"
TUBE = ["bakerloo", "central", "circle", "district", "hammersmith-city", "jubilee",
        "metropolitan", "northern", "piccadilly", "victoria", "waterloo-city"]

# TfL status severity -> our 0-5 scale. 0 good, 1 minor delays, 2 severe delays or reduced service,
# 3 part suspended or part closed, 4 suspended or closed, 5 closed for the night.
STATUS = {10: 0, 18: 0, 19: 0, 9: 1, 6: 2, 7: 2, 3: 3, 5: 3, 2: 4, 4: 4, 20: 5}
# When several statuses share a period, the worst wins. A night closure counts as the mildest non-good status.
WORST_RANK = {0: 0, 5: 1, 1: 2, 2: 3, 3: 4, 4: 5}
RANK_TO_STATUS = {v: k for k, v in WORST_RANK.items()}

MIN_STATIONS = 100   # a slot needs this many reporting stations before we trust its network average
MIN_LINES = 9        # ... and this many lines before we trust the trains total and line statuses


def read(table, cols):
    """All days of one raw table, with only the columns we need."""
    files = sorted(RAW.glob(f"20*/{table}.csv"))
    frames = [pd.read_csv(f, usecols=cols, dtype=str) for f in files]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=cols)


def to_local_slot(run_utc):
    """UTC run time -> London clock time, rounded to the nearest 15 minutes (the collector's rhythm)."""
    t = pd.to_datetime(run_utc, utc=True).dt.tz_convert(LONDON).dt.tz_localize(None)
    return t.dt.round("15min")


def first_per(df, keys):
    """Some slots have two runs a minute apart. Keep the earlier one."""
    return df.sort_values("run_utc").drop_duplicates(keys)


def table(df, cols, ndigits=None, keep=()):
    """DataFrame -> {"cols", "rows"} with NaN as null and no numpy types. Columns in keep are not rounded."""
    out = df[cols].copy()
    if ndigits is not None:
        out = out.round({c: ndigits for c in cols if c not in keep and pd.api.types.is_float_dtype(out[c])})
    out = out.astype(object).where(out.notna(), None)
    return {"cols": cols, "rows": out.values.tolist()}


def write(name, payload):
    PROCESSED.mkdir(parents=True, exist_ok=True)
    payload = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), **payload}
    text = json.dumps(payload, separators=(",", ":"), allow_nan=False)
    (PROCESSED / name).write_text(text, encoding="utf-8")
    print(f"  {name:14s} {len(text) / 1000:8.1f} KB")


def main():
    stations = pd.read_csv(RAW / "reference" / "stations.csv", dtype=str)
    stations = stations[stations.naptan.str.startswith("940GZZLU")].copy()   # Underground only
    stations["lines"] = stations.lines.fillna("")
    print(f"{len(stations)} Underground stations")

    # ---------- crowding, with closed stations taken out ----------
    cr = read("crowding", ["run_utc", "naptan", "data_available", "pct_baseline"])
    cr = cr[cr.data_available == "True"].copy()
    cr["v"] = pd.to_numeric(cr.pct_baseline, errors="coerce") * 100
    cr = cr.dropna(subset=["v"])
    cr["slot"] = to_local_slot(cr.run_utc)
    cr = first_per(cr, ["naptan", "slot"])

    # A closed or exit-only station's reading is capped by the closure, so it is left out of every average.
    sd = read("station_disruptions", ["run_utc", "atco_code", "type", "from_date", "to_date"])
    sd = sd[sd.type.isin(["Closure", "Exit Only"])].copy()
    run = pd.to_datetime(sd.run_utc, utc=True)
    start = pd.to_datetime(sd.from_date, utc=True, errors="coerce")
    end = pd.to_datetime(sd.to_date, utc=True, errors="coerce")
    sd = sd[(start <= run) & (end.isna() | (run <= end))]
    sd["slot"] = to_local_slot(sd.run_utc)
    closed = sd[["atco_code", "slot"]].drop_duplicates().rename(columns={"atco_code": "naptan"}).assign(closed=True)
    cr = cr.merge(closed, on=["naptan", "slot"], how="left")
    cr = cr[cr.closed.isna()].drop(columns="closed")

    # ---------- supply and status ----------
    sup = read("line_supply", ["run_utc", "line_id", "direction", "n_vehicles"])
    sup = sup[(sup.direction == "all") & sup.line_id.isin(TUBE)].copy()
    sup["trains"] = pd.to_numeric(sup.n_vehicles, errors="coerce")
    sup["slot"] = to_local_slot(sup.run_utc)
    sup = first_per(sup, ["line_id", "slot"])

    ls = read("line_status", ["run_utc", "line_id", "severity"])
    ls = ls[ls.line_id.isin(TUBE)].copy()
    ls["st"] = pd.to_numeric(ls.severity, errors="coerce").map(STATUS)
    ls = ls.dropna(subset=["st"])
    ls["rank"] = ls.st.astype(int).map(WORST_RANK)
    ls["slot"] = to_local_slot(ls.run_utc)
    ls = ls.sort_values("run_utc").groupby(["line_id", "slot"], as_index=False).agg(rank=("rank", "max"))
    ls["st"] = ls["rank"].map(RANK_TO_STATUS)

    # A station whose every line is suspended or closed has no trains, so its crowding is zero for that reason alone.
    sl = stations.assign(line=stations.lines.str.split(";")).explode("line")
    sl = sl[sl.line.isin(TUBE)][["naptan", "line"]]
    dead = sl.merge(ls[ls.st == 4][["line_id", "slot"]], left_on="line", right_on="line_id")
    dead = dead.groupby(["naptan", "slot"]).size().rename("nd").reset_index().merge(sl.groupby("naptan").size().rename("nl").reset_index(), on="naptan")
    dead = dead[dead.nd >= dead.nl][["naptan", "slot"]].assign(dead=True)
    cr = cr.merge(dead, on=["naptan", "slot"], how="left")
    cr = cr[cr.dead.isna()].drop(columns="dead")

    # ---------- system.json: one row per slot ----------
    net = cr.groupby("slot").agg(c=("v", "mean"), n=("naptan", "size"))
    net.loc[net.n < MIN_STATIONS, "c"] = np.nan
    tr = sup.groupby("slot").agg(tr=("trains", "sum"), nl=("line_id", "nunique"))
    tr.loc[tr.nl < MIN_LINES, "tr"] = np.nan
    bad = ls.assign(bad=ls.st.isin([1, 2, 3, 4])).groupby("slot").agg(lb=("bad", "sum"), ln=("line_id", "nunique"))
    bad.loc[bad.ln < MIN_LINES, "lb"] = np.nan
    slots = net.join(tr[["tr"]], how="outer").join(bad[["lb"]], how="outer").sort_index()
    slots["t"] = slots.index.strftime("%Y-%m-%dT%H:%M")
    slots = slots.reset_index(drop=True)
    slots[["n"]] = slots[["n"]].fillna(0)
    slots["n"] = slots.n.astype(int)

    # one row per day: service hours are 06:00-22:00, so a full day has 64 slots
    s = slots.copy()
    s["dt"] = pd.to_datetime(s.t)
    s["date"] = s.dt.dt.strftime("%Y-%m-%d")
    s["hour"] = s.dt.dt.hour
    svc = s[(s.hour >= 6) & (s.hour < 22) & s.c.notna()]
    hourly = svc.groupby(["date", "hour"]).c.mean().reset_index()
    daily = svc.groupby("date").agg(c=("c", "mean"), tr=("tr", "mean"), bad=("lb", "mean"), n=("c", "size"))
    daily["pk"] = hourly.groupby("date").c.max()
    daily["bad"] = daily.bad * 16          # average lines not on good service, times 16 service hours = line-hours
    daily["dow"] = pd.to_datetime(daily.index).strftime("%a")
    daily["date"] = daily.index
    daily = daily.reset_index(drop=True)

    write("system.json", {
        "note": "c: average station crowding, % of own busiest week; tr: trains with a live prediction; "
                "lb: tube lines not on good service; n: stations reporting",
        "slots": table(slots, ["t", "c", "tr", "lb", "n"], 1),
        "daily": table(daily, ["date", "dow", "c", "pk", "tr", "bad", "n"], 1),
    })

    # ---------- lines.json: one row per line per hour ----------
    lc = cr.merge(sl, on="naptan")
    lc["hour"] = lc.slot.dt.floor("h")
    line_crowd = lc.groupby(["line", "hour"]).v.mean().rename("c")
    sup["hour"] = sup.slot.dt.floor("h")
    line_trains = sup.groupby(["line_id", "hour"]).trains.median().rename("tr")
    line_trains.index = line_trains.index.set_names(["line", "hour"])
    ls["hour"] = ls.slot.dt.floor("h")
    line_status = ls.groupby(["line_id", "hour"], as_index=False).agg(rank=("rank", "max"))
    line_status["st"] = line_status["rank"].map(RANK_TO_STATUS)
    line_status = line_status.rename(columns={"line_id": "line"}).set_index(["line", "hour"]).st
    lines = pd.concat([line_crowd, line_trains, line_status], axis=1).reset_index()
    lines["t"] = lines.hour.dt.strftime("%Y-%m-%dT%H:00")
    lines = lines.sort_values(["line", "t"])
    write("lines.json", {
        "note": "c: mean crowding of the line's stations; tr: median trains with a live prediction; "
                "st: worst status (0 good, 1 minor delays, 2 severe or reduced, 3 part suspended or closed, "
                "4 suspended or closed, 5 closed for the night)",
        "lines": table(lines, ["line", "t", "c", "tr", "st"], 1),
    })

    # ---------- stations.json: typical levels by day type ----------
    cr["dow"] = cr.slot.dt.dayofweek
    cr["hour"] = cr.slot.dt.hour

    def mean_where(mask, name):
        return cr[mask].groupby("naptan").v.mean().rename(name)

    wk = cr.dow < 5
    parts = [
        mean_where(wk & cr.hour.between(6, 21), "wk"),
        mean_where(wk & cr.hour.between(7, 9), "am"),
        mean_where(wk & cr.hour.between(16, 18), "pm"),
        mean_where(wk & cr.hour.between(11, 14), "mid"),
        mean_where((cr.dow == 5) & cr.hour.between(8, 19), "sat"),
        mean_where((cr.dow == 6) & cr.hour.between(8, 19), "sun"),
        cr[wk & cr.hour.between(6, 21)].groupby("naptan").size().rename("n"),
    ]
    prof = pd.concat(parts, axis=1)
    prof = stations.set_index("naptan")[["name", "lat", "lon", "lines"]].join(prof)
    prof["lat"] = pd.to_numeric(prof.lat, errors="coerce")
    prof["lon"] = pd.to_numeric(prof.lon, errors="coerce")
    prof["n"] = prof.n.fillna(0).astype(int)
    prof = prof.reset_index()
    write("stations.json", {
        "note": "Average crowding (% of own busiest week) by day type: wk Mon-Fri 06-22, am 07-10, pm 16-19, "
                "mid 11-15, sat and sun 08-20. n: weekday slots behind the averages.",
        "stations": table(prof, ["naptan", "name", "lat", "lon", "lines", "wk", "am", "pm", "mid", "sat", "sun", "n"], 1, keep=("lat", "lon")),
    })


if __name__ == "__main__":
    main()
