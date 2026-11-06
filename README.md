# London Underground: supply, demand and crowding

PP434 *Automated Data Visualisation for Policymaking*, LSE, 2026/27.
Live site: <https://ibrahimjahwari.github.io/project.html>

An automated pipeline collects live London Underground data from the TfL Unified API every 15 minutes, turns it into small
analysis files once a day, and a static website draws every chart in the browser from those files. Nothing is edited by hand.

## Folders

| Folder | What is in it |
|---|---|
| `code/` | Everything that runs: the collector (`collect.py`, `process.py`, `build_reference.py`, `tfl_common.py`), the daily build (`build.py`), the route fetch (`fetch_routes.py`), the one-off network builder (`build_network.py`), requirements and the CI helper scripts in `code/ci/`. |
| `data/` | `README.md`, a data dictionary. The data itself lives on the `data` branch (below), not on `main`. |
| `output/` | Figures: `output/figures/` holds PNG snapshots of the plots. |
| `assets/` | The website's CSS, JavaScript (`assets/js/`) and two small static files (`assets/data/`). |
| `.github/workflows/` | `collect.yml` (every 15 minutes), `build.yml` (daily), `reference.yml` (monthly). |
| root | `index.html`, `project.html` (the graded project page), `portfolio.html`, `tfl-status.html` (collection health). |

GitHub Pages publishes from the repository root, so the web pages stay there.

## How the data flows

1. **Collect** (`collect.yml` runs `code/collect.py`): calls the TfL Unified API and appends raw CSV files to the **`data` branch**
   (`raw/YYYY-MM-DD/*.csv`). The data branch keeps about 100 bot commits a day out of `main` and out of the Pages build.
2. **Build** (`build.yml` runs `code/fetch_routes.py` then `code/build.py`): recomputes the files in `processed/` on the `data`
   branch from all the raw files, so numbers always match the data.
3. **Site**: `assets/js/charts.js` (Vega-Lite and D3) reads the processed files from
   `https://raw.githubusercontent.com/IbrahimJahwari/IbrahimJahwari.github.io/data/processed/` and draws the plots.

## Run it yourself

```
git clone --branch data --single-branch https://github.com/IbrahimJahwari/IbrahimJahwari.github.io.git data-branch
pip install -r code/requirements-build.txt
DATA_DIR=data-branch python code/build.py      # rewrites data-branch/processed/
python -m http.server                          # then open http://localhost:8000/project.html
```

The collector needs a TfL API key in the `TFL_APP_KEY` environment variable (a GitHub secret in the workflow) and the packages in
`code/requirements.txt`. See `data/README.md` for every file and column.

## Sources and credits

- Powered by TfL Open Data (TfL Unified API): crowding, arrivals, line status, station disruptions, lift disruptions, route sequences.
- Station connections for the network diagram: the open dataset github.com/nicola/tubemaps, matched to TfL station IDs (`code/build_network.py`).
- London borough outlines, simplified (see `code/build_network.py`).
- Charts: Vega-Lite, Vega, D3 (loaded from jsDelivr).
