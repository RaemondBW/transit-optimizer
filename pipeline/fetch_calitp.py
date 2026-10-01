"""Download recent Muni GPS pings from Cal-ITP's public California GTFS-RT exports.

Cal-ITP (Caltrans) archives every California agency's GTFS-realtime vehicle
positions. Some extracts are published in the public bucket
`calitp-publish-data-analysis`; the most recent full-state one is
`ucd_transit_priority_2026/fct_vehicle_locations_2026-06-10/` (400 gzipped JSONL
files, ~2.8 GB). Muni rows are mixed into every file, so we stream them all
and keep only "Bay Area 511 Muni VehiclePositions".

The export is partitioned by UTC date, so "2026-06-10" is Pacific time Tue Jun 9
17:00 -> Wed Jun 10 17:00. We fold both halves into one composite 24-hour
weekday (clock time kept, date set to the later day), which is what the
hour-of-day analysis needs. Each row keeps its real route/trip ids.

Output: data/raw/avl_<date>.csv (same columns as the DataSF archive + route_id,
direction_id, trip_id), plus data/raw/<date>.meta.json describing the composite.

Usage: python pipeline/fetch_calitp.py [2026-06-10]
"""
import gzip
import io
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import requests

BUCKET = "calitp-publish-data-analysis"
LIST = f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o"
GET = f"https://storage.googleapis.com/{BUCKET}/"
PREFIX = "ucd_transit_priority_2026/fct_vehicle_locations_{d}/"
FEED = '"gtfs_dataset_name":"Bay Area 511 Muni VehiclePositions"'
RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
TZ = ZoneInfo("America/Los_Angeles")
KEEP = ["vehicle_id", "trip_id", "trip_route_id", "trip_direction_id", "position_latitude",
        "position_longitude", "position_bearing", "position_speed", "location_timestamp"]


def list_files(day):
    names, token = [], None
    while True:
        params = {"prefix": PREFIX.format(d=day), "fields": "nextPageToken,items(name)", "maxResults": 1000}
        if token:
            params["pageToken"] = token
        r = requests.get(LIST, params=params, timeout=60)
        r.raise_for_status()
        j = r.json()
        names += [o["name"] for o in j.get("items", []) if o["name"].endswith(".jsonl.gz")]
        token = j.get("nextPageToken")
        if not token:
            return names


def fetch(name):
    for attempt in range(5):
        try:
            r = requests.get(GET + name, timeout=300)
            r.raise_for_status()
            break
        except requests.RequestException:
            time.sleep(3 * (attempt + 1))
    else:
        raise RuntimeError(f"failed: {name}")
    rows = []
    with gzip.open(io.BytesIO(r.content), "rt") as f:
        for line in f:
            if FEED not in line.replace(": ", ":"):  # cheap pre-filter before json parsing
                continue
            d = json.loads(line)
            rows.append({k: d.get(k) for k in KEEP})
    return rows


def main():
    day = sys.argv[1] if len(sys.argv) > 1 else "2026-06-10"
    out = RAW / f"avl_{day}.csv"
    if out.exists():
        print(f"{out.name} exists")
        return
    names = list_files(day)
    print(f"{len(names)} files for {day}")
    rows, t0 = [], time.time()
    with ThreadPoolExecutor(16) as ex:
        futs = [ex.submit(fetch, n) for n in names]
        for i, f in enumerate(as_completed(futs), 1):
            rows += f.result()
            if i % 25 == 0:
                print(f"  {i}/{len(names)} files, {len(rows):,} Muni rows ({time.time() - t0:.0f}s)")
    df = pd.DataFrame(rows).dropna(subset=["position_latitude", "location_timestamp"])
    ts = pd.to_datetime(df.location_timestamp.str.replace(" UTC", ""), utc=True).dt.tz_convert(TZ)
    df = df.assign(local=ts).drop_duplicates(["vehicle_id", "location_timestamp"])
    real_dates = df.local.dt.strftime("%a %b %-d").value_counts().to_dict()
    # composite weekday: keep clock time, stamp every row with the target date
    stamp = df.local.dt.strftime(f"{day}T%H:%M:%S.000")
    raw = pd.DataFrame({
        "vehicle_position_date_time": stamp,
        "vehicle_id": pd.to_numeric(df.vehicle_id, errors="coerce"),
        "loc_x": df.position_longitude, "loc_y": df.position_latitude,
        "heading": df.position_bearing.fillna(0).round().astype(int),
        "average_speed": (df.position_speed.fillna(0) * 2.23694).round().astype(int),  # m/s -> mph
        "route_id": df.trip_route_id.fillna(""), "direction_id": df.trip_direction_id,
        "trip_id": df.trip_id,
    }).dropna(subset=["vehicle_id"]).sort_values(["vehicle_position_date_time", "vehicle_id"])
    raw["vehicle_id"] = raw.vehicle_id.astype(int)
    RAW.mkdir(parents=True, exist_ok=True)
    raw.to_csv(out, index=False)
    meta = {"source": f"gs://{BUCKET}/{PREFIX.format(d=day)}", "composite_of": real_dates,
            "note": "UTC-day export: Pacific evening of the previous day + daytime of this day, folded into one clock day",
            "rows": len(raw), "vehicles": int(raw.vehicle_id.nunique())}
    (RAW / f"{day}.meta.json").write_text(json.dumps(meta, indent=1))
    print(f"{len(raw):,} Muni pings, {raw.vehicle_id.nunique()} vehicles -> {out.name}; {real_dates}")


if __name__ == "__main__":
    main()
