"""build.py - turn the raw collector CSVs into small files for the charts.

Reads   $DATA_DIR/raw/YYYY-MM-DD/{crowding,line_supply,line_status,station_disruptions,lifts,station_supply}.csv
        $DATA_DIR/raw/reference/{stations.csv,disruption_texts.csv,typical_crowding.csv.gz}
Writes  $DATA_DIR/processed/
    system.json      whole network, one row per 15-minute slot, plus one row per day
    lines.json       one row per line per hour: crowding, trains, frequency, worst status
    lines15.json     the whole network and every line, every 15 minutes from 05:00, one row per complete day: crowding and trains
    stations.json    one row per station: typical levels by day type, plus weekday-morning measures
    weekly.json      the typical week: for the whole network and each line, every weekday and quarter-hour
    reliability.json hours each line spent in each kind of disruption, by reason
    controls.json    how many stations were closed or exit-only, by cause, for every weekday and quarter-hour
    typical.json     the typical week for every station (weekday x quarter-hour), as a compact matrix, with the days behind each cell
    recent.json      the last 7 days for every station and line, as compact matrices
    events.json      every delay, suspension, closure and control, with crowding and trains from 1 hour before to 1 hour after
    strained.json    the most strained moments for the network and each line, over today / this week / this month / all time
    typical_supply.json  trains per hour at every station for the typical week
    strain.json      hours per week each station and line spent under strain, and why
    closures.json    station closure hours by cause, station and line, and how many fell in peak hours
    lifts.json       when each lift-affected station had no working lift, and where
    waits/<id>.json  observed waits at one station, by line, direction, day type and hour, with the direction named

Run by .github/workflows/build.yml once a day, or by hand:
    DATA_DIR=path/to/data-branch python code/build.py

Everything is recomputed from the raw files, so the numbers always match the data.
Tables are {"cols": [...], "rows": [[...], ...]} (about 3x smaller than objects); assets/js/tube.js turns them back.

Definitions
  crowding   TfL's live index: how busy a station is as a share of its own busiest-week level. The network figure is the
             unweighted average over stations that report and are open. It says how busy the typical station is, not how
             many people there are, and levels cannot be compared between stations.
  usual      each station's own median for the same time of day on other days of the same type (Monday to Thursday, Friday,
             Saturday, Sunday), from the 15 minutes either side. Fridays have their own type because they are shaped differently
             from Monday to Thursday. It needs at least two other days of the type, so Saturdays and Sundays fill in from the
             second weekend and Fridays from the third Friday.
  deviation  how far a reading is from usual, in units of that station's own typical spread at that time of day
             (morning peak, midday, evening peak, other; robust, capped at +-6).
  trains     trains with a live arrival prediction on a line. Close to trains running, not an exact count.
  supply     trains against the same hour on other days of the same type, with disrupted hours left out; a station takes the
             average over its lines.
  status     worst line status in the period: 0 good, 1 minor delays, 2 severe delays or reduced service,
             3 part suspended or closed, 4 suspended or closed, 5 closed for the night.
"""
import base64
import json
import os
import re
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=RuntimeWarning)
ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR") or ROOT / "_data")
RAW, PROCESSED = DATA / "raw", DATA / "processed"
LONDON = "Europe/London"
TUBE = ["bakerloo", "central", "circle", "district", "hammersmith-city", "jubilee",
        "metropolitan", "northern", "piccadilly", "victoria", "waterloo-city"]
LNAME = {"bakerloo": "Bakerloo", "central": "Central", "circle": "Circle", "district": "District",
         "hammersmith-city": "Hammersmith & City", "jubilee": "Jubilee", "metropolitan": "Metropolitan",
         "northern": "Northern", "piccadilly": "Piccadilly", "victoria": "Victoria", "waterloo-city": "Waterloo & City"}
STATUS = {10: 0, 18: 0, 19: 0, 9: 1, 6: 2, 7: 2, 3: 3, 5: 3, 2: 4, 4: 4, 20: 5}
WORST_RANK = {0: 0, 5: 1, 1: 2, 2: 3, 3: 4, 4: 5}
RANK_TO_STATUS = {v: k for k, v in WORST_RANK.items()}
MIN_STATIONS, MIN_LINES = 100, 9     # a slot needs this many stations / lines reporting before its totals are trusted
RECENT_SLOTS = 7 * 96
UNPLANNED = {"Fire alert", "Staff unavailable", "Equipment fault", "Lift fault"}
PRE, POST = 4, 4                     # event windows run from 1 hour before to 1 hour after


# ---------------------------------------------------------------- helpers
def top_moments(score, cand, k=5, gap=12):
    """The k highest-scoring slots that are more than `gap` quarter-hours apart, so one bad morning is not listed five times."""
    chosen = []
    for j in cand[np.argsort(-score[cand])]:
        if all(abs(int(j) - c_) > gap for c_ in chosen):
            chosen.append(int(j))
            if len(chosen) == k:
                break
    return chosen


def read(table, cols):
    files = sorted(RAW.glob(f"20*/{table}.csv"))
    frames = [pd.read_csv(f, usecols=cols, dtype=str) for f in files]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=cols)


def to_local_slot(run_utc):
    t = pd.to_datetime(run_utc, utc=True).dt.tz_convert(LONDON).dt.tz_localize(None)
    return t.dt.round("15min")


def first_per(df, keys):
    return df.sort_values("run_utc").drop_duplicates(keys)


def clean(o):
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (float, np.floating)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def table(df, cols, ndigits=1, keep=()):
    out = df[cols].copy()
    out = out.round({c: ndigits for c in cols if c not in keep and pd.api.types.is_float_dtype(out[c])})
    out = out.astype(object).where(out.notna(), None)
    return {"cols": cols, "rows": out.values.tolist()}


def write(name, payload, quiet=False):
    path = PROCESSED / name
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), **clean(payload)}
    text = json.dumps(payload, separators=(",", ":"), allow_nan=False)
    path.write_text(text, encoding="utf-8")
    if not quiet:
        print(f"  {name:16s} {len(text) / 1000:8.1f} KB")


def b64(a, step=1.0, lo=-127, hi=127):
    """Float matrix -> int8 bytes in base64. -128 means missing."""
    q = np.where(np.isnan(a), -128, np.clip(np.round(a / step), lo, hi)).astype(np.int8)
    return base64.b64encode(q.tobytes()).decode()


def cause_of(text, planned):
    s = (text or "").lower()
    for k, v in [("fire", "Fire alert"), ("staff", "Staff unavailable"), ("overcrowd", "Overcrowding control"),
                 ("lift", "Lift fault"), ("planned", "Planned works"), ("fix", "Equipment fault"), ("faulty", "Equipment fault")]:
        if k in s:
            return v
    return "Planned works" if planned else "Other"


GROUPS = ["Planned works", "Signal, track or power fault", "Train fault or cancellation", "Customer incident",
          "Knock-on from an earlier incident", "Other or not stated"]


def reason_group(sev, reason):
    """Sort a line-status entry into why it happened. Planned closures are known from the status itself."""
    if sev in (4, 5):
        return 1
    s = (reason if isinstance(reason, str) else "").lower()
    if any(k in s for k in ("signal", "track", "power", "points", "overhead")):
        return 2
    if any(k in s for k in ("train fault", "cancellation", "cancelled", "train shortage")):
        return 3
    if any(k in s for k in ("customer", "passenger", "person", "trespass")):
        return 4
    if "earlier" in s:
        return 5
    return 6


def runs_of(a):
    """Run-length encode a 1-d int array -> [(start, end_exclusive, value)] for non-zero values."""
    out, i = [], 0
    while i < len(a):
        j = i
        while j < len(a) and a[j] == a[i]:
            j += 1
        if a[i] != 0:
            out.append((i, j, int(a[i])))
        i = j
    return out


# ---------------------------------------------------------------- main
def main():
    stations = pd.read_csv(RAW / "reference" / "stations.csv", dtype=str)
    stations = stations[stations.naptan.str.startswith("940GZZLU")].reset_index(drop=True)
    stations["lines"] = stations.lines.fillna("")
    N = len(stations)
    IDX = {n: i for i, n in enumerate(stations.naptan)}
    NAME = stations.name.tolist()
    LINES_OF = [[TUBE.index(l) for l in s.split(";") if l in TUBE] for s in stations.lines]
    lat, lon = stations.lat.astype(float).to_numpy(), stations.lon.astype(float).to_numpy()
    print(f"{N} Underground stations")

    # ---- raw tables on a common 15-minute slot grid (London clock)
    cr = read("crowding", ["run_utc", "naptan", "data_available", "pct_baseline"])
    cr = cr[cr.data_available == "True"].copy()
    cr["v"] = pd.to_numeric(cr.pct_baseline, errors="coerce") * 100
    cr = cr.dropna(subset=["v"])
    cr = cr[cr.naptan.isin(IDX)]
    cr["slot"] = to_local_slot(cr.run_utc)
    cr = first_per(cr, ["naptan", "slot"])
    slots_idx = pd.date_range(cr.slot.min(), cr.slot.max(), freq="15min")
    NS = len(slots_idx)
    SI = pd.Series(np.arange(NS), index=slots_idx)
    tod = (slots_idx.hour * 4 + slots_idx.minute // 15).to_numpy()
    H = slots_idx.hour.to_numpy()
    dtype = np.where(slots_idx.dayofweek < 5, 0, np.where(slots_idx.dayofweek == 5, 1, 2))
    # What counts as "usual" for a Friday is other Fridays: Fridays are shaped differently from Monday to Thursday (in the first two
    # weeks the 07:00-10:00 average was about 19 on the Fridays against about 29 on Monday to Thursday), so against a Mon-Fri baseline
    # a Friday reads quieter than it is and real strain is missed. Used only for the usual crowding and usual trains; everything
    # else keeps dtype (0 Mon-Fri, 1 Saturday, 2 Sunday).
    btype = np.where(slots_idx.dayofweek == 4, 3, dtype)
    daynum = np.asarray((slots_idx.normalize() - slots_idx[0].normalize()).days)
    print(f"{NS} slots, {slots_idx[0]} to {slots_idx[-1]}")

    def put(M, rows, cols, vals):
        rows, cols = pd.Series(rows).to_numpy(float), pd.Series(cols).to_numpy(float)
        ok = ~(np.isnan(rows) | np.isnan(cols))
        M[rows[ok].astype(int), cols[ok].astype(int)] = np.asarray(vals)[ok]

    LEVEL_RAW = np.full((N, NS), np.nan, np.float32)
    put(LEVEL_RAW, cr.naptan.map(IDX), cr.slot.map(SI), cr.v.to_numpy())

    lidx = {l: i for i, l in enumerate(TUBE)}
    sup = read("line_supply", ["run_utc", "line_id", "direction", "n_vehicles"])
    sup = sup[(sup.direction == "all") & sup.line_id.isin(TUBE)].copy()
    sup["trains"] = pd.to_numeric(sup.n_vehicles, errors="coerce")
    sup["slot"] = to_local_slot(sup.run_utc)
    sup = first_per(sup, ["line_id", "slot"])
    TRM = np.full((len(TUBE), NS), np.nan)
    put(TRM, sup.line_id.map(lidx), sup.slot.map(SI), sup.trains.to_numpy())

    ls = read("line_status", ["run_utc", "line_id", "severity", "reason"])
    ls = ls[ls.line_id.isin(TUBE)].copy()
    ls["sev"] = pd.to_numeric(ls.severity, errors="coerce")
    ls["st"] = ls.sev.map(STATUS)
    ls = ls.dropna(subset=["st"])
    ls["rank"] = ls.st.astype(int).map(WORST_RANK)
    ls["grp"] = [reason_group(int(s), r) for s, r in zip(ls.sev, ls.reason)]
    ls["slot"] = to_local_slot(ls.run_utc)
    ls = ls.sort_values("rank").drop_duplicates(["line_id", "slot"], keep="last")    # the worst status in the slot
    STMf = np.full((len(TUBE), NS), 9.0)
    put(STMf, ls.line_id.map(lidx), ls.slot.map(SI), ls.st.to_numpy(float))
    STM = STMf.astype(np.int8)
    GRPM = np.zeros((len(TUBE), NS), np.int8)               # why: 0 no disruption, then GROUPS above
    put(GRPM, ls.line_id.map(lidx), ls.slot.map(SI), np.where(ls.st.isin([1, 2, 3, 4]), ls.grp, 0).astype(float))

    # station closures and exit-only, with the cause read from TfL's text
    texts = pd.read_csv(RAW / "reference" / "disruption_texts.csv", dtype=str).set_index("text_id")
    sd = read("station_disruptions", ["run_utc", "atco_code", "type", "appearance", "from_date", "to_date", "text_id"])
    sd = sd[sd.type.isin(["Closure", "Exit Only"]) & sd.atco_code.isin(IDX)].copy()
    run = pd.to_datetime(sd.run_utc, utc=True)
    start = pd.to_datetime(sd.from_date, utc=True, errors="coerce")
    end = pd.to_datetime(sd.to_date, utc=True, errors="coerce")
    sd = sd[(start <= run) & (end.isna() | (run <= end))].copy()
    sd["slot"] = to_local_slot(sd.run_utc)
    sd["cause"] = [cause_of(texts.description.get(t, ""), a == "PlannedWork") for t, a in zip(sd.text_id, sd.appearance)]
    sd = sd.drop_duplicates(["atco_code", "slot", "type"])
    CLM = np.zeros((N, NS), np.int8)
    CAUSE = {}
    for r in sd.itertuples():
        i, j = IDX[r.atco_code], SI.get(r.slot)
        if j is None:
            continue
        CLM[i, j] = max(CLM[i, j], 1 if r.type == "Closure" else 2)
        CAUSE[(i, j)] = r.cause

    # lifts out of service (the feed keys stations by TfL ID or by a hub code)
    hub = {h: [IDX[n] for n in g.naptan] for h, g in stations.dropna(subset=["hub_code"]).groupby("hub_code")}
    lf = read("lifts", ["run_utc", "station_id", "message"])
    lf["slot"] = to_local_slot(lf.run_utc)
    lf = first_per(lf, ["station_id", "slot"])
    lf["partial"] = lf.message.fillna("").str.contains("still available", case=False)
    LK = {}
    for r in lf.itertuples():
        j = SI.get(r.slot)
        if j is None or (r.station_id not in IDX and r.station_id not in hub):
            continue
        a = LK.setdefault(r.station_id, np.zeros(NS, np.int8))
        a[j] = max(a[j], 2 if r.partial else 1)
    # The lifts feed only lists lifts that are out, so a quarter-hour with no run (a collector gap, or the sparse test runs on the
    # first day) looks the same as "no outage". Fill those quarter-hours with the last reading so outages are not cut in two.
    logs = read("collection_log", ["run_utc", "source", "ok"])
    ran = to_local_slot(logs[(logs.source == "lifts") & (logs.ok == "True")].run_utc).map(SI).dropna().astype(int).unique()
    seen = np.zeros(NS, bool)
    seen[ran] = True
    for key, arr in LK.items():
        last = 0
        for j in range(NS):
            if seen[j]:
                last = arr[j]
            else:
                arr[j] = last
    LFM = np.zeros((N, NS), np.int8)
    for key, a in LK.items():
        for i in ([IDX[key]] if key in IDX else hub[key]):
            LFM[i] = np.maximum(LFM[i], a)

    # a station whose every line is suspended or closed has no trains: its crowding is zero for that reason alone
    dead = np.zeros((N, NS), bool)
    for i in range(N):
        if LINES_OF[i]:
            dead[i] = np.all(STM[LINES_OF[i]] == 4, axis=0)
    LEVEL = LEVEL_RAW.copy()
    LEVEL[(CLM > 0) | dead] = np.nan       # a closure or an exit-only control caps the count, so those readings leave every average

    # ---- usual: each station's own median for this time of day on other days of the same type
    by_key = {}
    for j in range(NS):
        by_key.setdefault((btype[j], tod[j]), []).append(j)
    BASE = np.full((N, NS), np.nan, np.float32)
    for j in range(NS):
        cand = np.concatenate([by_key.get((btype[j], (tod[j] + d) % 96), []) for d in (-1, 0, 1)]).astype(int)
        cand = cand[daynum[cand] != daynum[j]]
        if len(set(daynum[cand])) < 2:
            continue
        v = LEVEL[:, cand]
        med = np.nanmedian(v, axis=1)
        med[np.sum(~np.isnan(v), axis=1) < 3] = np.nan
        BASE[:, j] = med
    floor = np.maximum(BASE, 8)
    REL, REL_RAW = (LEVEL - BASE) / floor, (LEVEL_RAW - BASE) / floor    # the floor keeps quiet hours from looking dramatic
    # spread of each station's deviations, estimated separately for the morning peak, midday, evening peak and the rest,
    # because relative noise is larger at peak times than off-peak
    svc_wd = (H >= 6) & (H < 22) & (dtype == 0)
    band = np.where((H >= 6) & (H < 10), 0, np.where((H >= 10) & (H < 16), 1, np.where((H >= 16) & (H < 20), 2, 3)))
    SC4 = np.full((N, 4), 0.2)
    for i in range(N):
        allr = REL[i, svc_wd]
        allr = allr[~np.isnan(allr)]
        overall = 1.4826 * np.median(np.abs(allr - np.median(allr))) if len(allr) > 20 else 0.2
        for k in range(4):
            r = REL[i, (dtype == 0) & (band == k)]
            r = r[~np.isnan(r)]
            SC4[i, k] = 1.4826 * np.median(np.abs(r - np.median(r))) if len(r) > 20 else overall
    SC4 = np.clip(SC4, 0.05, None)
    SCS = SC4[:, band]
    Z, ZR = np.clip(REL / SCS, -6, 6), np.clip(REL_RAW / SCS, -6, 6)   # ZR keeps closed stations (for events)

    # supply against usual, per line then per station
    SUPB = np.full(TRM.shape, np.nan)
    for li in range(len(TUBE)):
        df = pd.DataFrame({"dt": btype, "h": H, "tr": TRM[li], "st": STM[li]})
        ok = df[(df.st == 0) & df.tr.notna()]
        b1, b2 = ok.groupby(["dt", "h"]).tr.median(), ok.groupby("h").tr.median()
        SUPB[li] = [b1.get(k, b2.get(k[1], np.nan)) for k in zip(df.dt, df.h)]
    LSUP = np.where(SUPB >= 2, (TRM / SUPB - 1) * 100, np.nan)
    SS = np.full((N, NS), np.nan)
    for i in range(N):
        if LINES_OF[i]:
            SS[i] = np.nanmean(LSUP[LINES_OF[i]], axis=0)

    # ---------------------------------------------------------------- system.json
    c = np.nanmean(LEVEL, axis=0)
    n = np.sum(~np.isnan(LEVEL), axis=0)
    c[n < MIN_STATIONS] = np.nan
    tr = np.nansum(TRM, axis=0).astype(float)
    tr[np.sum(~np.isnan(TRM), axis=0) < MIN_LINES] = np.nan
    lb = np.sum((STM >= 1) & (STM <= 4), axis=0).astype(float)
    lb[np.sum(STM != 9, axis=0) < MIN_LINES] = np.nan
    slots = pd.DataFrame({"t": slots_idx.strftime("%Y-%m-%dT%H:%M"), "c": c, "tr": tr, "lb": lb, "n": n})
    slots = slots[(slots.n > 0) | slots.tr.notna()].reset_index(drop=True)
    s = slots.copy()
    s["date"], s["hour"] = s.t.str[:10], s.t.str[11:13].astype(int)
    svc = s[(s.hour >= 6) & (s.hour < 22) & s.c.notna()]
    hourly = svc.groupby(["date", "hour"]).c.mean().reset_index()
    daily = svc.groupby("date").agg(c=("c", "mean"), tr=("tr", "mean"), bad=("lb", "mean"), n=("c", "size"))
    daily["pk"] = hourly.groupby("date").c.max()
    daily["bad"] = daily.bad * 16
    daily["dow"] = pd.to_datetime(daily.index).strftime("%a")
    daily["date"] = daily.index
    write("system.json", {
        "note": "c: average station crowding, % of own busiest week; tr: trains with a live prediction; "
                "lb: tube lines not on good service; n: stations reporting",
        "slots": table(slots, ["t", "c", "tr", "lb", "n"]),
        "daily": table(daily.reset_index(drop=True), ["date", "dow", "c", "pk", "tr", "bad", "n"]),
    })

    # ---------------------------------------------------------------- lines.json
    ss = read("station_supply", ["run_utc", "naptan", "line_id", "direction", "trains_next_15m", "next_arrival_s"])
    ss = ss[ss.naptan.isin(IDX) & ss.line_id.isin(TUBE)].copy()
    ss["slot"] = to_local_slot(ss.run_utc)
    ss = first_per(ss, ["naptan", "line_id", "direction", "slot"])
    ss["wait"] = pd.to_numeric(ss.next_arrival_s, errors="coerce") / 60
    ss["tph"] = pd.to_numeric(ss.trains_next_15m, errors="coerce") * 4
    freq = ss[ss.direction.isin(["inbound", "outbound"])].groupby(["line_id", "slot"]).tph.median()
    recs = []
    for li, ln in enumerate(TUBE):
        idx = [i for i in range(N) if li in LINES_OF[i]]
        d = pd.DataFrame({"slot": slots_idx, "c": np.nanmean(LEVEL[idx], axis=0), "tr": TRM[li], "st": STM[li]})
        fl = freq.xs(ln, level="line_id") if ln in freq.index.get_level_values(0) else pd.Series(dtype=float)
        d["f"] = d.slot.map(fl)
        d["rank"] = [WORST_RANK.get(int(v), -1) if v != 9 else -1 for v in d.st]
        d["hour"] = d.slot.dt.floor("h")
        g = d.groupby("hour").agg(c=("c", "mean"), tr=("tr", "median"), f=("f", "mean"), rank=("rank", "max"))
        g["st"] = g["rank"].map(lambda r: RANK_TO_STATUS.get(r, np.nan) if r >= 0 else np.nan)
        g["line"], g["t"] = ln, g.index.strftime("%Y-%m-%dT%H:00")
        recs.append(g.reset_index(drop=True))
    lines = pd.concat(recs)
    lines = lines[lines.c.notna() | lines.tr.notna() | lines.st.notna()]
    write("lines.json", {
        "note": "c: mean crowding of the line's stations; tr: median trains with a live prediction; f: trains per hour past a "
                "station (median over stations); st: worst status (0 good .. 4 suspended, 5 closed for the night)",
        "lines": table(lines, ["line", "t", "c", "tr", "f", "st"]),
    })

    # ---------------------------------------------------------------- weekly.json and typical.json
    dow = slots_idx.dayofweek.to_numpy()                     # 0 = Monday
    dates_arr = slots_idx.strftime("%Y-%m-%d").to_numpy()
    svc_slots = (H >= 6) & (H < 22) & ~np.isnan(c)
    per_day = pd.Series(svc_slots).groupby(dates_arr).sum()
    comp = np.isin(dates_arr, per_day[per_day >= 56].index)  # only complete days go into a typical week
    obs = (STM != 9) & (STM != 5)                            # a line that is observed and not closed for the night
    planned = GRPM == 1
    cat = {"dm": obs & (STM == 1) & ~planned, "ds": obs & (STM == 2) & ~planned,
           "dp": obs & ((STM == 3) | (STM == 4)) & ~planned, "dl": obs & planned}

    def crowd_stats(idx, need):
        sub = LEVEL[idx]
        cnt = np.sum(~np.isnan(sub), axis=0)
        ok = cnt >= need
        md = np.where(ok, np.nanmedian(sub, axis=0), np.nan)
        sb = np.where(ok, np.sum(sub >= 40, axis=0) / np.maximum(cnt, 1) * 100, np.nan)      # TfL: below 40% of record is quiet
        sv = np.where(ok, np.sum(sub >= 70, axis=0) / np.maximum(cnt, 1) * 100, np.nan)
        return md, sb, sv

    series = {}
    md, sb, sv = crowd_stats(list(range(N)), MIN_STATIONS)
    n_obs = np.maximum(obs.sum(axis=0), 1)
    series["all"] = dict(c=c, md=md, sb=sb, sv=sv, tr=tr, **{k: v.sum(axis=0) / n_obs * 100 for k, v in cat.items()})
    for li, ln in enumerate(TUBE):
        idx = [i for i in range(N) if li in LINES_OF[i]]
        md, sb, sv = crowd_stats(idx, 3)
        series[ln] = dict(c=np.nanmean(LEVEL[idx], axis=0), md=md, sb=sb, sv=sv, tr=TRM[li],
                          **{k: np.where(obs[li], v[li] * 100.0, np.nan) for k, v in cat.items()})
    wk_rows = []
    for name, d in series.items():
        df = pd.DataFrame({"dow": dow, "tod": tod, **d})[comp]
        g = df.groupby(["dow", "tod"]).agg(c=("c", "median"), tr=("tr", "median"), dm=("dm", "mean"), ds=("ds", "mean"),
                                           dp=("dp", "mean"), dl=("dl", "mean"), n=("c", "count")).reset_index()
        g["line"] = name
        wk_rows.append(g)
    wk = pd.concat(wk_rows)
    write("weekly.json", {"note": "Typical week from complete days (medians across days). c: mean crowding index over the "
                                  "stations; tr: trains with a live prediction; dm, ds, dp, dl: % of in-service hours with minor delays, severe delays or "
                                  "reduced service, suspensions (unplanned), planned closures (for 'all': % of lines); n: days behind "
                                  "the cell. dow 0 = Monday, tod = quarter-hour of the day.",
                          "weekly": table(wk, ["line", "dow", "tod", "c", "tr", "dm", "ds", "dp", "dl", "n"])})
    LINE_MAXTR = wk[wk.line != "all"].groupby("line").tr.max().to_dict()      # a line's most trains in the typical week
    epi = {}
    for li, ln in enumerate(TUBE):
        code_arr = np.where(obs[li] & (STM[li] >= 1) & (STM[li] <= 4) & (GRPM[li] > 0), STM[li].astype(int) * 10 + GRPM[li], 0)
        for i0_, i1_, v_ in runs_of(code_arr):                 # one disruption = a run of quarter-hours with the same severity and reason
            e_ = epi.setdefault((ln, v_ // 10, v_ % 10), [0, 0.0])
            e_[0] += 1
            e_[1] += (i1_ - i0_) * 0.25
    write("reliability.json", {"note": "Disruptions per line, by severity (cls: 1 minor delays, 2 severe delays or reduced service, 3 part "
                                       "suspended or part closed, 4 suspended or closed) and reason (grp, see groups). hours: total length; "
                                       "episodes: how many separate disruptions; days: how long the data covers.",
                               "groups": GROUPS, "days": NS * 0.25 / 24,
                               "rows": {"cols": ["line", "cls", "grp", "hours", "episodes"], "rows": [[k[0], k[1], k[2], v[1], v[0]] for k, v in epi.items()]}})
    TY = np.full((N, 7, 96), np.nan, np.float32)
    TYN = np.zeros((N, 7, 96), np.float32)                  # days behind each cell
    for d in range(7):
        for t in range(96):
            cols = np.where(comp & (dow == d) & (tod == t))[0]
            if len(cols):
                TY[:, d, t] = np.nanmedian(LEVEL[:, cols], axis=1)
                TYN[:, d, t] = np.sum(~np.isnan(LEVEL[:, cols]), axis=1)
    write("typical.json", {"note": "Median crowding index per station, weekday (0 = Monday) x quarter-hour, complete days only. "
                                   "int8 percent, -128 missing; index = station * 672 + dow * 96 + quarter-hour. "
                                   "tn: how many days sit behind each cell (int8, same index).",
                           "stations": stations.naptan.tolist(), "ty": b64(TY.reshape(N, -1), 1, 0, 127), "tn": b64(TYN.reshape(N, -1), 1, 0, 127)})
    SP = np.full((N, NS), np.nan, np.float32)
    stp = ss.groupby(["naptan", "slot"]).tph.sum().reset_index()           # trains per hour past the station, all lines and directions
    put(SP, stp.naptan.map(IDX), stp.slot.map(SI), stp.tph.to_numpy())
    TS = np.full((N, 7, 96), np.nan, np.float32)
    TSN = np.zeros((N, 7, 96), np.float32)
    for d in range(7):
        for t in range(96):
            cols = np.where(comp & (dow == d) & (tod == t))[0]
            if len(cols):
                TS[:, d, t] = np.nanmedian(SP[:, cols], axis=1)
                TSN[:, d, t] = np.sum(~np.isnan(SP[:, cols]), axis=1)
    write("typical_supply.json", {"note": "Median trains per hour past each station (all lines, both directions), weekday x quarter-hour. "
                                          "int8, -128 missing; index = station * 672 + dow * 96 + quarter-hour. "
                                          "tpn: how many days sit behind each cell (int8, same index).",
                                  "stations": stations.naptan.tolist(), "tp": b64(TS.reshape(N, -1), 1, 0, 127), "tpn": b64(TSN.reshape(N, -1), 1, 0, 127)})

    # ---------------------------------------------------------------- lines15.json
    # Plots 1 and 5: the whole network and every line, every 15-minute slot from 05:00 to 23:45, one row per complete day.
    # c: mean crowding index over the line's open, reporting stations (at least 3 must report; the network needs MIN_STATIONS);
    # tr: trains with a live arrival prediction (the network total needs MIN_LINES lines reporting). null = no reading.
    Q0, NQ = 20, 76
    cdays = sorted(per_day[per_day >= 56].index)
    skipped = sorted(set(dates_arr) - set(cdays))

    def day_grid(a):
        df = pd.DataFrame({"d": dates_arr, "t": tod, "v": np.asarray(a, float)})
        df = df[df.d.isin(cdays) & (df.t >= Q0) & (df.t < Q0 + NQ)]
        return df.pivot(index="d", columns="t", values="v").reindex(index=cdays, columns=range(Q0, Q0 + NQ)).to_numpy()

    l15 = {}
    for name, cc, tt in [("all", c, tr)] + [(ln, None, TRM[li]) for li, ln in enumerate(TUBE)]:
        if cc is None:
            idx = [i for i in range(N) if lidx[name] in LINES_OF[i]]
            cnt = np.sum(~np.isnan(LEVEL[idx]), axis=0)
            cc = np.where(cnt >= 3, np.nanmean(LEVEL[idx], axis=0), np.nan)
        l15[name] = {"c": [[None if np.isnan(v) else round(float(v), 1) for v in row] for row in day_grid(cc)],
                     "tr": [[None if np.isnan(v) else int(round(v)) for v in row] for row in day_grid(tt)]}
    write("lines15.json", {"note": "Crowding (c, TfL index, %) and trains with a live prediction (tr) for the whole network (all) and each line, "
                                   "every 15 minutes from 05:00 (slot k is 05:00 + 15 min x k) on each complete day in dates. "
                                   "A complete day has at least 56 of the 64 quarter-hours between 06:00 and 22:00 with a network crowding value; "
                                   "skipped lists the other days.",
                           "q0": Q0, "nq": NQ, "dates": cdays, "skipped": skipped, "series": l15})

    # ---------------------------------------------------------------- stations.json
    def mean_of(mask):
        return np.nanmean(LEVEL[:, mask], axis=1) if mask.any() else np.full(N, np.nan)

    wk = dtype == 0
    prof = stations[["naptan", "name", "lat", "lon", "lines"]].copy()
    prof["lat"], prof["lon"] = lat, lon
    prof["wk"] = mean_of(wk & (H >= 6) & (H < 22))
    prof["am"] = mean_of(wk & (H >= 7) & (H < 10))
    prof["pm"] = mean_of(wk & (H >= 16) & (H < 19))
    prof["mid"] = mean_of(wk & (H >= 11) & (H < 15))
    prof["sat"] = mean_of((dtype == 1) & (H >= 8) & (H < 20))
    prof["sun"] = mean_of((dtype == 2) & (H >= 8) & (H < 20))
    prof["n"] = np.sum(~np.isnan(LEVEL[:, wk & (H >= 6) & (H < 22)]), axis=1)
    am = wk & (H >= 7) & (H < 10)
    good, busy, lift = [], [], []
    for i in range(N):
        L = LINES_OF[i]
        known = (STM[L] != 9).all(axis=0) & am if L else np.zeros(NS, bool)
        good.append(100 * np.mean((STM[L] == 0).all(axis=0)[known]) if known.sum() >= 8 else np.nan)
        zi = Z[i, am]
        zi = zi[~np.isnan(zi)]
        busy.append(100 * np.mean(zi > 2) if len(zi) >= 8 else np.nan)
        nl = pd.to_numeric(stations.lifts[i], errors="coerce")
        lift.append(100 * np.mean(LFM[i, am] > 0) if nl and nl > 0 else np.nan)
    prof["good"], prof["busy"], prof["lift"] = good, busy, lift
    j_of = ss.slot.map(SI)
    w = ss[j_of.notna() & am[j_of.fillna(0).astype(int).to_numpy()]]
    wm = w.groupby("naptan").wait.agg(["median", "size"])
    prof["wait"] = prof.naptan.map(wm["median"].where(wm["size"] >= 4))
    write("stations.json", {
        "note": "Average crowding (% of own busiest week) by day type: wk Mon-Fri 06-22, am 07-10, pm 16-19, mid 11-15, "
                "sat and sun 08-20. Weekday 07-10: good = share of slots with good service on all the station's lines, "
                "busy = share busier than usual, wait = median minutes to the next train, lift = share with a lift out.",
        "stations": table(prof, ["naptan", "name", "lat", "lon", "lines", "wk", "am", "pm", "mid", "sat", "sun", "n",
                                 "good", "busy", "wait", "lift"], 1, keep=("lat", "lon")),
    })

    # ---------------------------------------------------------------- recent.json
    a = max(0, NS - RECENT_SLOTS)
    code = (CLM + 3 * LFM).astype(float)
    write("recent.json", {
        "note": "rel: crowding against usual, % (-100..100); sup: supply against usual, %; code: closure (0 open, 1 closed, "
                "2 exit only) + 3 x lift (0 fine, 1 out, 2 partly out); lstat: line status; lsup: line supply % vs usual. "
                "int8, -128 missing, stations x slots (lines x slots for l*).",
        "t0": slots_idx[a].strftime("%Y-%m-%dT%H:%M"), "ns": NS - a, "stations": stations.naptan.tolist(), "lines": TUBE,
        "rel": b64(REL[:, a:] * 100, 1, -100, 100), "sup": b64(SS[:, a:], 1, -100, 100), "code": b64(code[:, a:], 1, 0, 8),
        "lstat": b64(np.where(STM[:, a:] == 9, np.nan, STM[:, a:]).astype(float), 1, 0, 9),
        "lsup": b64(LSUP[:, a:], 1, -100, 100),
    })

    # ---------------------------------------------------------------- events.json
    kx, ky = 111.32 * np.cos(np.radians(51.5)), 110.57
    X, Y = (lon - lon.mean()) * kx, (lat - lat.mean()) * ky
    D = np.hypot(X[:, None] - X[None, :], Y[:, None] - Y[None, :])
    RELP = REL_RAW * 100          # crowding against usual, %, closed stations included

    def profile(idx, s_, M):
        if len(idx) == 0:
            return None
        out = np.nanmean(M[idx, s_ - PRE:s_ + POST + 1], axis=0)
        return None if np.all(np.isnan(out)) else [None if np.isnan(v) else int(round(v)) for v in out]

    def run_len(arr, s_, ok):
        e_ = s_
        while e_ < NS and ok(arr[e_]):
            e_ += 1
        return (e_ - s_) * 0.25

    EV = {"minor": [], "severe": [], "susp": [], "closure": [], "control": []}
    for li, ln in enumerate(TUBE):
        onl = np.array([li in L for L in LINES_OF])
        near = (~onl) & (D[:, onl].min(axis=1) <= 0.8)
        rings = [np.where(onl)[0], np.where(near)[0], np.where(~onl & ~near)[0]]
        st = STM[li]
        for s_ in range(PRE, NS - POST):
            if st[s_] in (1, 2, 3, 4) and st[s_ - 1] == 0 and not (st[s_ - PRE:s_] != 0).any() and 6 <= H[s_] < 22:
                nxt = [x for x in st[s_:s_ + 4] if x not in (9, 5)]
                worst = max(nxt) if nxt else st[s_]
                key = "minor" if worst == 1 else "severe" if worst == 2 else "susp"
                EV[key].append({"kind": "line", "name": ln, "lines": ln, "t": slots_idx[s_].strftime("%Y-%m-%dT%H:%M"),
                                "label": f"{LNAME[ln]} line, {slots_idx[s_]:%a %d %b %H:%M}", "grp": int(GRPM[li, s_]), "cause": None,
                                "dur": run_len(st, s_, lambda v: v in (1, 2, 3, 4)),
                                "crowd": [profile(r, s_, RELP) for r in rings], "trains": [profile(r, s_, SS) for r in rings]})
    for i in range(N):
        for s_ in range(PRE, NS - POST):
            if CLM[i, s_] > 0 and CLM[i, s_ - 1] == 0 and CAUSE.get((i, s_)) in (UNPLANNED | {"Overcrowding control"}) and 6 <= H[s_] < 23:
                me = np.array([i])
                near = np.where((D[i] <= 1.0) & (np.arange(N) != i))[0]
                rest = np.setdiff1d(np.arange(N), np.concatenate([me, near]))
                rings = [me, near, rest]
                EV["control" if CAUSE[(i, s_)] == "Overcrowding control" else "closure"].append({
                    "kind": "station", "name": NAME[i], "lines": stations.lines[i], "t": slots_idx[s_].strftime("%Y-%m-%dT%H:%M"),
                    "label": f"{NAME[i]}, {slots_idx[s_]:%a %d %b %H:%M} ({CAUSE[(i, s_)].lower()})", "grp": None, "cause": CAUSE[(i, s_)],
                    "dur": run_len(CLM[i], s_, lambda v: v > 0),
                    "crowd": [profile(r, s_, RELP) for r in rings], "trains": [profile(r, s_, SS) for r in rings]})
    ev_rows = [[shock, e["kind"], e["name"], e["lines"], e["t"], e["label"], e["grp"], e["cause"], e["dur"], *e["crowd"], *e["trains"]] for shock, evs in EV.items() for e in evs]
    write("events.json", {"note": "Each row is one event: a line going from good service to a disruption (shock: minor, severe, susp; grp: why, see groups; "
                                  "dur: hours until the line is back to good service), or a station closing or going exit-only (cause). crowd_* and trains_* are "
                                  "the average crowding and trains against usual (%) for the stations on the line or the closed station (aff), within 800 m / 1 km "
                                  "(near) and everywhere else (rest), at -60, -45, ..., +60 minutes from the start.",
                          "offsets": [(k - PRE) * 15 for k in range(PRE + POST + 1)], "groups": GROUPS, "days": NS * 0.25 / 24, "counts": {k: len(v) for k, v in EV.items()},
                          "events": {"cols": ["shock", "kind", "name", "lines", "t", "label", "grp", "cause", "dur", "crowd_aff", "crowd_near", "crowd_rest",
                                              "trains_aff", "trains_near", "trains_rest"], "rows": ev_rows}})

    # ---------------------------------------------------------------- strain.json
    valid = ~np.isnan(Z) & ~np.isnan(SS) & (H >= 6)[None, :]
    low = (SS < -20) | (CLM == 1)
    high = Z > 2
    ndays = max(1, len(set(daynum[valid.any(axis=0)])))
    k = 0.25 * 7 / ndays
    sl_, dl_, cp_ = (valid & low & ~high).sum(1) * k, (valid & ~low & (np.abs(SS) <= 20) & high).sum(1) * k, (valid & low & high).sum(1) * k
    st_df = pd.DataFrame({"naptan": stations.naptan, "name": NAME, "lat": lat, "lon": lon, "lines": stations.lines,
                          "sl": sl_, "dl": dl_, "cp": cp_, "ok": valid.sum(1) > 20})
    ln_df = pd.DataFrame([{"line": ln, "sl": np.mean(sl_[[i for i in range(N) if li in LINES_OF[i]]]),
                           "dl": np.mean(dl_[[i for i in range(N) if li in LINES_OF[i]]]),
                           "cp": np.mean(cp_[[i for i in range(N) if li in LINES_OF[i]]])} for li, ln in enumerate(TUBE)])
    write("strain.json", {"note": f"Hours per week under strain, from {ndays} days with own-baseline readings. sl: supply-led "
                                  "(fewer trains than usual, or closed), dl: demand-led (much busier than usual, trains normal), "
                                  "cp: both. Line rows are the average over the line's stations.",
                          "stations": table(st_df, ["naptan", "name", "lat", "lon", "lines", "sl", "dl", "cp", "ok"], 1, keep=("lat", "lon")),
                          "lines": table(ln_df, ["line", "sl", "dl", "cp"], 1)})

    # ---------------------------------------------------------------- strained.json
    # Same construction as the week grids: crowding is a station's reading as % of its own busiest quarter-hour of the typical week;
    # supply is the trains on its lines as % of the most trains those lines run in the typical week. The critical zone is the corner
    # where crowding is among the highest 10% of all station moments while supply is among the lowest 10%. Exit-only stations stay in
    # (their count is capped, so they show a floor); closed stations are out.
    TYf = TY.reshape(N, -1)
    maxTY = np.nanmax(np.where(np.isnan(TYf), -1, TYf), axis=1).astype(float)
    maxTY[maxTY < 5] = np.nan
    LEVEL_EX = LEVEL_RAW.copy()
    LEVEL_EX[(CLM == 1) | dead] = np.nan
    CI = LEVEL_EX / maxTY[:, None] * 100
    SI = np.full((N, NS), np.nan)
    for i in range(N):
        if LINES_OF[i]:
            SI[i] = np.nanmean(np.vstack([TRM[l] / LINE_MAXTR[TUBE[l]] * 100 for l in LINES_OF[i]]), axis=0)
    inserv = (H >= 6) & (H < 22)
    c_thr, s_thr = float(np.nanpercentile(CI[:, inserv], 90)), float(np.nanpercentile(SI[:, inserv], 10))
    K = (CI >= c_thr) & (SI <= s_thr) & inserv[None, :]
    disrupted = np.zeros((N, NS), bool)                           # a line serving the station is delayed, suspended or closed
    for i in range(N):
        if LINES_OF[i]:
            disrupted[i] = np.any((STM[LINES_OF[i]] >= 1) & (STM[LINES_OF[i]] <= 4), axis=0)
    nk = max(int(K.sum()), 1)
    stats = {"n": int(K.sum()), "line": float((K & disrupted).sum() / nk), "exit": float((K & (CLM == 2)).sum() / nk),
             "neither": float((K & ~disrupted & (CLM != 2)).sum() / nk)}
    dts = pd.to_datetime(slots_idx.strftime("%Y-%m-%d"))
    last = dts.max()
    periods = {"today": np.asarray(dts == last), "week": np.asarray(dts > last - pd.Timedelta(days=7)),
               "month": np.asarray(dts > last - pd.Timedelta(days=30)), "all": np.ones(NS, bool)}
    moments, mindex, picks = [], {}, {}
    for scope in ["all"] + TUBE:
        idx = list(range(N)) if scope == "all" else [i for i in range(N) if TUBE.index(scope) in LINES_OF[i]]
        score = K[idx].sum(axis=0) * 1000 + np.nan_to_num(np.nanmean(CI[idx], axis=0))
        picks[scope] = {}
        for pname, pm in periods.items():
            cand = np.where(pm & inserv)[0]
            ids = []
            for j in (top_moments(score, cand) if len(cand) else []):
                if j not in mindex:
                    mindex[j] = len(moments)
                    moments.append({"t": slots_idx[j].strftime("%Y-%m-%dT%H:%M"), "ci": b64(CI[:, j], 1, 0, 127), "si": b64(SI[:, j], 1, 0, 127),
                                    "cl": b64(CLM[:, j].astype(float), 1, 0, 2),
                                    "lines": [[TUBE[li], int(STM[li, j]), int(GRPM[li, j])] for li in range(len(TUBE)) if STM[li, j] in (1, 2, 3, 4)],
                                    "ctl": sorted([[NAME[i], int(CLM[i, j]), CAUSE.get((i, j), "")] for i in range(N) if CLM[i, j] > 0])[:20]})
                ids.append(mindex[j])
            picks[scope][pname] = ids
    write("strained.json", {"note": "ci: crowding as % of the station's busiest typical-week quarter-hour; si: supply as % of the line's busiest "
                                    "typical-week quarter-hour; cl: 0 open, 1 closed, 2 exit only (int8, -128 missing). Critical zone: ci at or above "
                                    "c_thr (the highest 10% of in-service station moments) and si at or below s_thr (the lowest 10%). picks: the five moments "
                                    "with most stations in the critical zone, per line and period. lines: lines with a disruption at that moment (severity, "
                                    "reason group); ctl: stations closed or exit-only (state, cause). stats: how critical station moments overall "
                                    "split between a disrupted line, exit-only entry and neither.",
                            "groups": GROUPS, "asof": str(last.date()), "c_thr": c_thr, "s_thr": s_thr, "stats": stats, "stations": stations.naptan.tolist(),
                            "moments": moments, "picks": picks})

    # ---------------------------------------------------------------- closures.json
    cl = sd.drop_duplicates(["atco_code", "slot"]).copy()
    cl["name"] = cl.atco_code.map(dict(zip(stations.naptan, NAME)))
    cl["lines"] = cl.atco_code.map(dict(zip(stations.naptan, stations.lines)))
    cl["peak"] = (cl.slot.dt.dayofweek < 5) & (((cl.slot.dt.hour >= 7) & (cl.slot.dt.hour < 10)) | ((cl.slot.dt.hour >= 16) & (cl.slot.dt.hour < 19)))
    g = cl.groupby(["cause", "name", "lines"]).agg(hours=("slot", "size"), peak=("peak", "sum")).reset_index()
    g["hours"], g["peak"] = g.hours * 0.25, g.peak * 0.25
    write("closures.json", {"note": "Hours a station was closed or exit-only, by cause (read from TfL's text), station and line. "
                                    "peak: hours on weekdays 07-10 and 16-19.",
                            "closures": table(g, ["cause", "name", "lines", "hours", "peak"], 2)})

    # ---------------------------------------------------------------- controls.json
    ctl_rows = []
    for cause in sorted(set(CAUSE.values())):
        cnt = np.zeros(NS)
        for (i, j), cz in CAUSE.items():
            if cz == cause and CLM[i, j] > 0:
                cnt[j] += 1
        g2 = pd.DataFrame({"dow": dow, "tod": tod, "n": cnt})[comp].groupby(["dow", "tod"]).n.mean().reset_index()
        g2["cause"] = cause
        ctl_rows.append(g2)
    write("controls.json", {"note": "Average number of stations closed or exit-only at each weekday and quarter-hour, by cause.",
                            "controls": table(pd.concat(ctl_rows), ["cause", "dow", "tod", "n"], 2)})

    # ---------------------------------------------------------------- lifts.json
    peak = (dtype == 0) & (((H >= 7) & (H < 10)) | ((H >= 16) & (H < 19)))
    hubname = {h: re.sub(r" \(.*", "", NAME[ix[0]]) for h, ix in hub.items()}
    summary, segs = [], []
    for key, arr in LK.items():
        members = [IDX[key]] if key in IDX else hub[key]
        ln_set = sorted({TUBE[l] for i in members for l in LINES_OF[i]})
        summary.append({"key": key, "name": NAME[IDX[key]] if key in IDX else hubname[key], "hours": float((arr > 0).sum() * 0.25),
                        "full": float((arr == 1).sum() * 0.25), "peak": float(((arr > 0) & peak).sum() * 0.25),
                        "lines": ";".join(ln_set), "lat": float(lat[members[0]]), "lon": float(lon[members[0]])})
    summary.sort(key=lambda d: -d["hours"])
    for d in summary[:24]:
        for i0, i1, kind in runs_of(LK[d["key"]]):
            segs.append([d["name"], slots_idx[i0].strftime("%Y-%m-%dT%H:%M"), slots_idx[i1 - 1].strftime("%Y-%m-%dT%H:%M"), kind])
    eps = []
    for d in summary:
        for i0_, i1_, _ in runs_of((LK[d["key"]] > 0).astype(int)):
            eps.append([d["name"], d["lines"], d["lat"], d["lon"], slots_idx[i0_].strftime("%Y-%m-%dT%H:%M"),
                        slots_idx[i1_ - 1].strftime("%Y-%m-%dT%H:%M"), (i1_ - i0_) * 0.25, bool(i0_ == 0), bool(i1_ == NS)])
    write("lifts.json", {"note": "Lifts out of service. summary lists every station with an outage; episodes are each separate outage "
                                 "(left: already out when collection began, right: still out at the last reading); segments are for the 24 "
                                 "with most hours lost (kind 1: no step-free access, 2: partly). Hub-coded entries may be another mode's lift.",
                         "summary": summary, "episodes": {"cols": ["name", "lines", "lat", "lon", "start", "end", "hours", "left", "right"], "rows": eps}, "segments": {"cols": ["name", "start", "end", "kind"], "rows": segs},
                         "from": slots_idx[0].strftime("%Y-%m-%dT%H:%M"), "to": slots_idx[-1].strftime("%Y-%m-%dT%H:%M")})

    # ---------------------------------------------------------------- waits/<id>.json, with each direction named
    # TfL labels directions "inbound" and "outbound", which means different things on different lines. We work out which way each one
    # is heading from the data itself. For two neighbouring stations A and B: if trains in a direction go from A to B, the next train at
    # B is usually later than the next train at A, so the median of (B - A) is positive; in the opposite direction it is negative. We
    # use both directions together (their difference), so the two directions can never be given the same next stop. Where the data
    # cannot say, the layout of the line fills the gap and the label is just "Next stop: X", with no compass heading.
    towards = {}
    net_path = ROOT / "assets" / "data" / "network.json"
    if net_path.exists():
        net = json.loads(net_path.read_text(encoding="utf-8"))
        adj = {}
        for a_, b_, l_ in net["edges"]:
            adj.setdefault((l_, a_), set()).add(b_)
            adj.setdefault((l_, b_), set()).add(a_)
        ssd = ss[ss.direction.isin(["inbound", "outbound"]) & ss.wait.notna()]
        piv = {}
        for ln in TUBE:
            for d_ in ("inbound", "outbound"):
                part = ssd[(ssd.line_id == ln) & (ssd.direction == d_)]
                if not part.empty:
                    piv[(ln, d_)] = part.pivot_table(index="slot", columns="naptan", values="wait", aggfunc="min")
        ahead, behind = {}, {}
        for ln in TUBE:
            for a_, b_ in [(x, y) for x, y, l_ in net["edges"] if l_ == ln]:
                ms = {}
                for d_ in ("inbound", "outbound"):
                    P_ = piv.get((ln, d_))
                    if P_ is not None and a_ in P_ and b_ in P_:
                        diff = (P_[b_] - P_[a_]).dropna()
                        diff = diff[diff.abs() < 10]
                        if len(diff) >= 12:
                            ms[d_] = float(diff.median())
                if len(ms) == 2:
                    if ms["inbound"] * ms["outbound"] >= 0:      # both directions say the same: no information
                        continue
                    score = (ms["inbound"] - ms["outbound"]) / 2
                elif "inbound" in ms:
                    score = ms["inbound"]
                elif "outbound" in ms:
                    score = -ms["outbound"]
                else:
                    continue
                if abs(score) < 0.15:
                    continue
                src, dst = (a_, b_) if score > 0 else (b_, a_)    # inbound runs src -> dst, outbound runs dst -> src
                for d_, (p_, q_) in (("inbound", (src, dst)), ("outbound", (dst, src))):
                    ahead.setdefault((ln, d_, p_), set()).add(q_)
                    behind.setdefault((ln, d_, q_), set()).add(p_)
        final, sure = {}, {}
        for (ln, sid), nb in adj.items():
            if sid not in IDX:
                continue
            for d_ in ("inbound", "outbound"):
                ah, bh = set(ahead.get((ln, d_, sid), set())), set(behind.get((ln, d_, sid), set()))
                firm = bool(ah)
                if not ah and bh:
                    ah = nb - bh
                    firm = len(nb) == 2
                final[(ln, sid, d_)], sure[(ln, sid, d_)] = (ah, bh), firm
        for _ in range(3):                                       # fill gaps from the other direction, then from the neighbours
            for (ln, sid), nb in adj.items():
                if sid not in IDX:
                    continue
                for d_, o_ in (("inbound", "outbound"), ("outbound", "inbound")):
                    ah, bh = final.get((ln, sid, d_), (set(), set()))
                    if ah or bh:
                        continue
                    oah, obh = final.get((ln, sid, o_), (set(), set()))
                    if oah:
                        ah, bh = nb - oah, set(oah)
                    elif obh:
                        ah, bh = set(obh), nb - obh
                    else:
                        for nbr in nb:
                            nah, nbh = final.get((ln, nbr, d_), (set(), set()))
                            if sid in nbh:
                                ah = {nbr}
                            elif sid in nah:
                                bh = {nbr}
                    final[(ln, sid, d_)], sure[(ln, sid, d_)] = (ah, bh), False
        for (ln, sid, d_), (ah, bh) in list(final.items()):        # one side known: the other is the line's remaining neighbour(s)
            nb_ = adj[(ln, sid)]
            if not ah and bh:
                ah = nb_ - bh
            elif ah and not bh:
                bh = nb_ - ah
            final[(ln, sid, d_)] = (ah, bh)
        for (ln, sid), nb_ in adj.items():                       # a station with two neighbours whose directions are mirror images is certain
            if sid in IDX and len(nb_) == 2:
                (ai, bi), (ao, bo) = final.get((ln, sid, "inbound"), (set(), set())), final.get((ln, sid, "outbound"), (set(), set()))
                if len(ai) == 1 and len(ao) == 1 and not (ai & ao) and (ai | ao) == nb_:
                    sure[(ln, sid, "inbound")] = sure[(ln, sid, "outbound")] = True
        for (ln, sid, d_), (ah, bh) in final.items():
            o_ = "outbound" if d_ == "inbound" else "inbound"
            oah = final.get((ln, sid, o_), (set(), set()))[0]
            if ah and ah & oah and len(adj[(ln, sid)]) >= 2:     # the same next stop both ways cannot be right: say nothing rather than guess
                continue
            if ah:
                names_ = " / ".join(sorted(NAME[IDX[v]] for v in ah))
                if sure[(ln, sid, d_)] and len(ah) == 1:
                    v = next(iter(ah))
                    dx = (lon[IDX[v]] - lon[IDX[sid]]) * np.cos(np.radians(51.5))
                    dy = lat[IDX[v]] - lat[IDX[sid]]
                    ang = np.degrees(np.arctan2(dx, dy)) % 360          # 0 = north, 90 = east
                    word = ["North", "North-east", "East", "South-east", "South", "South-west", "West", "North-west"][int((ang + 22.5) // 45) % 8]
                    towards[(sid, ln, d_)] = f"{word}bound, next stop {names_}"
                else:
                    towards[(sid, ln, d_)] = f"Next stop: {names_}"
            elif bh:
                towards[(sid, ln, d_)] = f"Trains ending here, arriving from {' / '.join(sorted(NAME[IDX[v]] for v in bh))}"
    # TfL's own stop order for every route, when it has been fetched (code/fetch_routes.py): name each direction by where it is heading
    routes_path = RAW / "reference" / "routes.json"
    if routes_path.exists():
        try:
            routes = json.loads(routes_path.read_text(encoding="utf-8"))
        except Exception:
            routes = {}
        nxt, dst, prv, ends = {}, {}, {}, set()
        for ln, dd in routes.items():
            for d_, rs in dd.items():
                for stops in rs:
                    stops = [s for s in stops if s in IDX]
                    for i, s in enumerate(stops):
                        k = (s, ln, d_)
                        if i + 1 < len(stops):
                            nxt.setdefault(k, set()).add(stops[i + 1])
                            dst.setdefault(k, set()).add(stops[-1])
                        else:
                            ends.add(k)
                        if i > 0:
                            prv.setdefault(k, set()).add(stops[i - 1])
        for k in set(nxt) | ends:
            sid, ln, d_ = k
            if k in nxt:
                nx = sorted(NAME[IDX[x]] for x in nxt[k])
                ds = sorted({NAME[IDX[x]] for x in dst[k]})
                to = " / ".join(ds[:3]) + (f" + {len(ds) - 3} more" if len(ds) > 3 else "")
                if len(nxt[k]) == 1:
                    v = next(iter(nxt[k]))
                    ang = np.degrees(np.arctan2((lon[IDX[v]] - lon[IDX[sid]]) * np.cos(np.radians(51.5)), lat[IDX[v]] - lat[IDX[sid]])) % 360
                    word = ["North", "North-east", "East", "South-east", "South", "South-west", "West", "North-west"][int((ang + 22.5) // 45) % 8]
                    towards[k] = f"{word}bound to {to}, next stop {nx[0]}"
                else:
                    towards[k] = f"To {to}, next stop {' / '.join(nx)}"
            else:
                towards[k] = "Trains ending here" + (f", arriving from {' / '.join(sorted(NAME[IDX[x]] for x in prv[k]))}" if k in prv else "")
        print(f"  routes.json: {len(nxt)} directions named from TfL's route sequences")
    w0 = ss[ss.direction.isin(["inbound", "outbound"]) & ss.wait.notna() & (ss.slot.dt.hour >= 6)].copy()
    w0["dow"] = w0.slot.dt.dayofweek
    w0["tod"] = w0.slot.dt.hour * 4 + w0.slot.dt.minute // 15
    w0["grp"] = w0.dow.astype(str)
    wd_, we_ = w0[w0.dow < 5].copy(), w0[w0.dow >= 5].copy()
    wd_["grp"], we_["grp"] = "wd", "we"
    w = pd.concat([w0, wd_, we_])
    keys = ["naptan", "line_id", "direction", "grp", "tod"]
    grp = w.groupby(keys).wait
    g = grp.agg(n="size", p50="median", mn="min", mx="max", vals=list).reset_index()
    qs = grp.quantile([0.1, 0.9]).unstack().reset_index()
    qs.columns = keys + ["p10", "p90"]
    g = g.merge(qs, on=keys)
    g["lo"] = np.where(g.n < 10, g.mn, g.p10)
    g["hi"] = np.where(g.n < 10, g.mx, g.p90)
    nshards = 0
    for nid, part in g.groupby("naptan"):
        groups_ = {}
        for (ln, d_, gp), sub in part.groupby(["line_id", "direction", "grp"]):
            rows_ = {int(r.tod) - 24: r for r in sub.itertuples()}
            groups_[f"{ln}|{d_}|{gp}"] = {
                "n": [rows_[k].n if k in rows_ else None for k in range(72)],
                "a": [round(float(rows_[k].lo), 1) if k in rows_ else None for k in range(72)],
                "m": [round(float(rows_[k].p50), 1) if k in rows_ else None for k in range(72)],
                "b": [round(float(rows_[k].hi), 1) if k in rows_ else None for k in range(72)],
                "v": [[round(float(x), 1) for x in rows_[k].vals] if k in rows_ and rows_[k].n <= 4 else None for k in range(72)]}
        tw = {f"{ln}|{d_}": towards[(nid, ln, d_)] for ln, d_ in part[["line_id", "direction"]].drop_duplicates().itertuples(index=False) if (nid, ln, d_) in towards}
        write(f"waits/{nid}.json", {"groups": groups_, "towards": tw}, quiet=True)
        nshards += 1
    print(f"  waits/<id>.json  {nshards} stations, {len(towards)} direction labels")

if __name__ == "__main__":
    main()
