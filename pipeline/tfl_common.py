"""Shared helpers for the TfL pipeline: API client, key loading, station discovery."""
import os
import time
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE = "https://api.tfl.gov.uk"
ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR") or ROOT / "_data")  # CI: the checked-out data branch
RAW = DATA / "raw"
PROCESSED = DATA / "processed"
TUBE_LINES = [
    "bakerloo", "central", "circle", "district", "hammersmith-city", "jubilee",
    "metropolitan", "northern", "piccadilly", "victoria", "waterloo-city",
]
RAIL_MODES = "tube,elizabeth-line,overground,dlr,tram"
WORKERS = 8  # parallel requests; the whole station sweep takes a few seconds


def get_key():
    """API key from the environment (GitHub secret) or a local .env file."""
    key = os.environ.get("TFL_APP_KEY")
    env = ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.strip().startswith("TFL_APP_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    return key


class Api:
    """Thin client. get() never raises: it returns status, body, err and seconds."""

    def __init__(self, key):
        self.key = key
        self.session = requests.Session()
        retry = Retry(total=3, backoff_factor=1.0, status_forcelist=(429, 500, 502, 503, 504),
                      allowed_methods=("GET",), raise_on_status=False)
        self.session.mount("https://", HTTPAdapter(max_retries=retry, pool_maxsize=WORKERS))

    def get(self, path, **params):
        params["app_key"] = self.key
        t0 = time.time()
        status, body, err = None, None, None
        try:
            r = self.session.get(BASE + path, params=params, timeout=20)
            status = r.status_code
            if not 200 <= status < 300:
                err = f"HTTP {status}"
            else:
                try:
                    body = r.json()
                except ValueError:
                    err = "bad JSON"
        except requests.RequestException as e:
            err = type(e).__name__
        return {"status": status, "body": body, "err": err, "secs": round(time.time() - t0, 2)}


def discover_stations(api):
    """Underground stations from the 11 line StopPoint lists, keyed by naptanId."""
    stations = {}
    for line in TUBE_LINES:
        r = api.get(f"/Line/{line}/StopPoints")
        if r["err"] or not isinstance(r["body"], list):
            continue
        for sp in r["body"]:
            nid = sp.get("naptanId", "")
            if not nid.startswith("940GZZLU"):
                continue
            rec = stations.setdefault(nid, {
                "name": (sp.get("commonName") or "").replace(" Underground Station", ""),
                "hub": sp.get("hubNaptanCode") or "",
                "lat": sp.get("lat"), "lon": sp.get("lon"), "lines": set(),
            })
            rec["lines"].add(line)
    return stations
