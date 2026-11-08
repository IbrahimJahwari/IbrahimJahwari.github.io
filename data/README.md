# Data dictionary

All data lives on the **`data` branch** of this repository (`git checkout data`, or browse it on GitHub), not on `main`:

```
raw/YYYY-MM-DD/*.csv      one folder per day (UTC), one CSV per source, one row per item per collection run
raw/reference/*           files built once or monthly (station list, typical profiles, disruption texts)
processed/*.json          small files built daily by code/build.py; the website reads these
processed/waits/<naptan>.json   one file per station
```

Times: `run_utc` is when a collection run started (about every 15 minutes, from Fri 30 Oct 2026 05:51 UTC; four test runs on 29 Oct).
The build assigns each run to the nearest 15 minutes on the London clock (a "slot") and uses the earlier run if two fall in one slot.

## Raw tables (`raw/YYYY-MM-DD/`)

| File | Columns | Notes |
|---|---|---|
| `crowding.csv` | `run_utc, naptan, data_available, pct_baseline, obs_utc, obs_local, error` | `pct_baseline` is TfL's live crowding index (API field percentageOfBaseline, endpoint `/crowding/{naptan}/Live`): how busy the station is as a proportion of the busiest it has been since data collection began (July 2019). Usually 0 to 1, can exceed 1. Wi-Fi based. Not comparable between stations. 17 of 270 stations never report. |
| `line_supply.csv` | `run_utc, line_id, direction, n_predictions, n_vehicles, n_stations` | From each line's Arrivals feed. `n_vehicles` = distinct trains with a live arrival prediction (close to trains running). The build uses the rows with `direction = all`. |
| `line_status.csv` | `run_utc, line_id, mode, status_index, severity, description, reason` | TfL line status. `severity` is TfL's status code (see below); `reason` is TfL's text. |
| `station_disruptions.csv` | `run_utc, atco_code, type, appearance, from_date, to_date, lines, text_id` | Station closures and exit-only periods. `appearance` is RealTime or PlannedWork. `text_id` points to `disruption_texts.csv`. |
| `lifts.csv` | `run_utc, station_id, lift_ids, n_lifts_out, message` | Lifts reported out of service (only lifts that are out are listed). |
| `station_supply.csv` | `run_utc, naptan, line_id, direction, trains_next_15m, next_arrival_s` | Trains predicted at a station by line and direction. Stored hourly until 4 Nov 2026 about 18:30 UTC, every run after that. |
| `collection_log.csv` | `run_utc, source, ok, http_status, n_items, n_errors, seconds, note` | What each call returned. |

## Reference files (`raw/reference/`)

| File | Columns |
|---|---|
| `stations.csv` | `naptan, name, hub_code, lat, lon, lines, lifts, has_typical` (270 Underground stations; `lines` is semicolon-separated) |
| `disruption_texts.csv` | `text_id, first_seen_utc, description, additional_information` |
| `typical_crowding.csv.gz` | `naptan, day, time_band, pct_baseline` (TfL's own typical profile; not used by the final plots) |
| `routes.json` | `{line: {direction: [[naptan, ...], ...]}}`: the ordered stops of every route, from TfL's Route/Sequence, written by `code/fetch_routes.py` in the build workflow (may be absent) |

## Processed files (`processed/`), and which plot uses them

Tables are `{"cols": [...], "rows": [[...], ...]}`; matrices are base64 int8 (`-128` = missing).

| File | What it holds | Used by |
|---|---|---|
| `system.json` | The whole network, one row per 15-minute slot (crowding, trains, status), plus one row per day | The status line at the top of the page (no plot reads it now) |
| `lines.json` | One row per line per hour: crowding, trains, frequency, worst status | None now (Plots 1 and 5 use `lines15.json`) |
| `lines15.json` | The whole network (`all`) and every line, every 15 minutes from 05:00 to 23:45, one row per complete day: `c` crowding index (%), `tr` trains with a live prediction; `dates` lists the complete days and `skipped` the others; `null` = no reading | Plots 1, 5 |
| `stations.json` | Per station: average crowding index by window (`wk` Mon-Fri 06-22, `am` 07-10, `mid` 11-15, `pm` 16-19, `sat`, `sun` 08-20), `n` readings, and weekday-morning measures | Plot 3 |
| `typical.json` | Median crowding per station, weekday x quarter-hour (complete days); `tn` holds the number of days behind each cell | Plot 2 |
| `typical_supply.json` | Median trains per hour per station, weekday x quarter-hour; `tpn` holds the number of days behind each cell | Plot 2 |
| `waits/<naptan>.json` | Waits at one station by line, direction and day group (weekdays, weekend, each weekday), 72 15-minute bins from 06:00; per bin `n` days, band bounds `a` and `b`, median `m`, single-day values `v`; plus `towards` (direction labels) | Plot 4 |
| `strain.json` | Per station and per line: hours per week supply-led, demand-led, both | Plot 6, 6b (and tooltips in Appendix A) |
| `strained.json` | The five most strained, distinct moments per line and period, with what was going on; thresholds | Appendix A |
| `events.json` | Every line disruption and station closure with crowding and trains from 60 minutes before to 60 after | Appendix B |
| `weekly.json`, `recent.json`, `reliability.json`, `closures.json`, `controls.json`, `lifts.json` | Typical week, last 7 days, disruption hours by reason, closure hours by cause, closures by cause and time, lift outages | built daily, not used by a current plot |

## Definitions (also in the docstring of `code/build.py`)

- **Complete day**: at least 56 of the 64 quarter-hours between 06:00 and 22:00 have a network crowding value.
- **Masked readings**: a station's crowding is left out while it is closed or exit-only, or while all its lines are suspended or closed.
- **Usual**: a station's median in the same quarter-hour and the 15 minutes either side, on other days of the same type (Monday to Thursday, Friday, Saturday or Sunday: Fridays are compared with other Fridays since 8 Nov 2026 because they are shaped differently from Monday to Thursday); needs 2 other days of the type, so Saturdays and Sundays fill in from the second weekend and Fridays from the third Friday.
- **Deviation**: (reading minus usual) / max(usual, 8), divided by the station's own spread for that time band (1.4826 x median absolute deviation; capped at plus or minus 6).
- **Supply against usual**: a line's trains against the median for the same hour and day type with disrupted hours left out; a station takes the mean over its lines.
- **Line status classes**: 0 good, 1 minor delays, 2 severe delays or reduced service, 3 part suspended or part closed, 4 suspended or closed, 5 closed for the night. TfL codes: 10, 18, 19 good; 9 minor delays; 6, 7 severe or reduced; 3, 5 part; 2, 4 suspended or closed; 20 closed for the night. Planned works = TfL codes 4 and 5.
- **Disruption reasons** (from TfL's text, by keyword): planned works; signal, track or power fault; train fault or cancellation; customer incident; knock-on from an earlier incident; other or not stated.
- **Closure causes** (from TfL's text): overcrowding control, staff unavailable, fire alert, equipment fault, lift fault, planned works.
