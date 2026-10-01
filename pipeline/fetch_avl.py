"""Download historical Muni AVL (vehicle location) pings from DataSF.

Dataset: "SFMTA - Transit Vehicle Location History (2021)" (9722-grnf).
Each row: timestamp (local time), vehicle_id, lon/lat, heading, speed (mph).
There is no route/trip ID; match.py infers routes by map-matching to GTFS shapes.

Usage: python pipeline/fetch_avl.py 2021-10-19 2021-10-20 ...
"""
import sys
import time
from pathlib import Path

import requests

DATASETS = {"2021": "9722-grnf", "2020": "48aa-8sj9"}
RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
PAGE = 400_000

# Rough SF bounding box, drops the occasional (0,0) or yard-test garbage ping.
BBOX = "loc_x between -122.53 and -122.35 AND loc_y between 37.70 and 37.84"


def fetch_day(day: str) -> Path:
    out = RAW / f"avl_{day}.csv"
    if out.exists() and out.stat().st_size > 1_000_000:
        print(f"{day}: cached ({out.stat().st_size / 1e6:.0f} MB)")
        return out
    ds = DATASETS[day[:4]]
    url = f"https://data.sf.gov/resource/{ds}.csv"
    where = (f"vehicle_position_date_time >= '{day}T03:00:00' AND "
             f"vehicle_position_date_time < '{day}T23:59:59' AND {BBOX}")
    tmp = out.with_suffix(".part")
    offset, total = 0, 0
    t0 = time.time()
    with open(tmp, "w") as f:
        while True:
            params = {"$where": where, "$order": "vehicle_position_date_time,vehicle_id",
                      "$limit": PAGE, "$offset": offset}
            for attempt in range(5):
                try:
                    r = requests.get(url, params=params, timeout=600)
                    r.raise_for_status()
                    break
                except requests.RequestException as e:
                    print(f"  retry {attempt + 1}: {e}")
                    time.sleep(5 * (attempt + 1))
            else:
                raise RuntimeError(f"failed to fetch {day} offset {offset}")
            lines = r.text.splitlines(keepends=True)
            header, rows = lines[0], lines[1:]
            if offset == 0:
                f.write(header)
            f.writelines(rows)
            total += len(rows)
            print(f"  {day}: {total:,} rows ({time.time() - t0:.0f}s)")
            if len(rows) < PAGE:
                break
            offset += PAGE
    tmp.rename(out)
    return out


if __name__ == "__main__":
    RAW.mkdir(parents=True, exist_ok=True)
    days = sys.argv[1:] or ["2021-10-19", "2021-10-20", "2021-10-21",
                            "2021-10-13", "2021-11-03", "2021-11-04"]
    for d in days:
        fetch_day(d)
