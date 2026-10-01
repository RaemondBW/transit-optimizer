"""Collect live Muni vehicle positions from 511.org's GTFS-realtime feed.

Get a free key at https://511.org/open-data/token and put it in .env:
    MUNI_511_KEY=...
Then:
    python pipeline/collect_511.py [--days 7] [--interval 61]

Each poll appends to data/raw/live/avl_<local date>.csv using the same columns
as the other sources (plus route_id, direction_id, trip_id), so the files drop
straight into match.py / analyze.py. Positions whose timestamp hasn't changed
since the last poll are skipped. The collector exits cleanly after --days.

511's default quota is 60 requests/hour per key, so the default interval is 61 s.
Status (last poll, counts, errors) is written to data/raw/live/status.json.
"""
import argparse
import csv
import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from google.transit import gtfs_realtime_pb2

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "live"
URL = "https://api.511.org/transit/vehiclepositions"
TZ = ZoneInfo("America/Los_Angeles")
COLS = ["vehicle_position_date_time", "vehicle_id", "loc_x", "loc_y", "heading", "average_speed",
        "route_id", "direction_id", "trip_id"]


def load_key():
    key = os.environ.get("MUNI_511_KEY")
    env = ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("MUNI_511_KEY="):
                key = line.split("=", 1)[1].strip()
    if not key:
        raise SystemExit("Set MUNI_511_KEY in the environment or .env")
    return key


def poll(key):
    r = requests.get(URL, params={"api_key": key, "agency": "SF"}, timeout=60)
    if r.status_code == 429:
        raise RuntimeError("rate limited (429)")
    r.raise_for_status()
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(r.content)
    rows = []
    for e in feed.entity:
        v = e.vehicle
        if not v.HasField("position"):
            continue
        try:
            vid = int(v.vehicle.id)
        except ValueError:
            continue
        ts = datetime.fromtimestamp(v.timestamp or feed.header.timestamp, TZ)
        trip = v.trip if v.HasField("trip") else None
        rows.append({
            "ts": ts, "vehicle_id": vid,
            "lon": round(v.position.longitude, 6), "lat": round(v.position.latitude, 6),
            "heading": int(round(v.position.bearing)) % 360,
            "mph": int(round(v.position.speed * 2.23694)),  # GTFS-RT speed is m/s
            "route_id": trip.route_id if trip else "",
            "direction_id": trip.direction_id if trip and trip.HasField("direction_id") else "",
            "trip_id": trip.trip_id if trip else "",
        })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--interval", type=float, default=61)
    ap.add_argument("--until", help="ISO local datetime to stop at (overrides --days; survives restarts)")
    args = ap.parse_args()
    key = load_key()
    OUT.mkdir(parents=True, exist_ok=True)
    stop_file = OUT / "stop_at.txt"
    if args.until:
        stop_at = datetime.fromisoformat(args.until).replace(tzinfo=TZ)
    elif stop_file.exists():  # restarted by launchd: keep the original deadline
        stop_at = datetime.fromisoformat(stop_file.read_text().strip())
    else:
        stop_at = datetime.now(TZ) + timedelta(days=args.days)
    stop_file.write_text(stop_at.isoformat())
    print(f"collecting until {stop_at:%a %b %d %H:%M} ({args.interval:.0f}s interval)", flush=True)

    last_ts = {}
    status = {"started": datetime.now(TZ).isoformat(), "stop_at": stop_at.isoformat(), "polls": 0,
              "rows": 0, "errors": 0, "last_error": None}
    while datetime.now(TZ) < stop_at:
        t0 = time.time()
        try:
            rows = poll(key)
            written = 0
            by_day = {}
            for r in rows:
                if last_ts.get(r["vehicle_id"]) == r["ts"]:
                    continue
                last_ts[r["vehicle_id"]] = r["ts"]
                by_day.setdefault(r["ts"].strftime("%Y-%m-%d"), []).append(r)
            for day, rs in by_day.items():
                path = OUT / f"avl_{day}.csv"
                new = not path.exists()
                with open(path, "a", newline="") as f:
                    w = csv.writer(f)
                    if new:
                        w.writerow(COLS)
                    for r in rs:
                        w.writerow([r["ts"].strftime("%Y-%m-%dT%H:%M:%S.000"), r["vehicle_id"], r["lon"], r["lat"],
                                    r["heading"], r["mph"], r["route_id"], r["direction_id"], r["trip_id"]])
                written += len(rs)
            status.update(polls=status["polls"] + 1, rows=status["rows"] + written,
                          last_poll=datetime.now(TZ).isoformat(), last_vehicles=len(rows))
            print(f"{datetime.now(TZ):%m-%d %H:%M:%S} {len(rows)} vehicles, {written} new", flush=True)
        except Exception as e:  # network blips, 5xx, rate limits: log and keep going
            status.update(errors=status["errors"] + 1, last_error=f"{datetime.now(TZ):%m-%d %H:%M} {e}")
            print(f"{datetime.now(TZ):%m-%d %H:%M:%S} error: {e}", flush=True)
            if "429" in str(e):
                time.sleep(300)
        (OUT / "status.json").write_text(json.dumps(status, indent=1))
        time.sleep(max(0, args.interval - (time.time() - t0)))
    print("done", flush=True)


if __name__ == "__main__":
    main()
