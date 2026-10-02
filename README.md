# Muni Time Lab

Where SF Muni buses spend their time, where they get stuck, and what stop
consolidation or a Market St subway-transfer network would buy.

```
make setup      # venv + deps (uses uv)
make all        # GTFS -> download AVL -> map-match -> analyze   (~3 min)
make serve      # http://localhost:8765
```

## Data

| Source | What | Notes |
|---|---|---|
| **Cal-ITP public export** `gs://calitp-publish-data-analysis/ucd_transit_priority_2026/fct_vehicle_locations_2026-06-10/` | Muni GTFS-realtime vehicle positions (via 511) with **route, direction, trip**, GPS speed and heading, every ~15 s | **Default.** One UTC day = Pacific Tue Jun 9 5pm → Wed Jun 10 5pm, folded into one composite weekday (`data/raw/2026-06-10.meta.json`). ~1.5M Muni pings, 7k bus trips. |
| SFMTA GTFS (`muni_gtfs-current.zip`) | routes, shapes, stops, weekday schedule | the 2026 trip ids in the feed (`…_M11`) match it |
| DataSF `9722-grnf` (2021 archive) | older GPS without route ids | `make avl-2021`; raw and processed files kept in `data/*/2021/`. The matcher infers routes for it. |
| 511.org GTFS-realtime vehicle positions | live positions (buses, Metro, F, cable cars) | needs a free key; see below |
| DataSF `ybh5-27n2` "Traffic Signals" | 1,500 signalized intersections | `make signals`; used for the red-light ranking |

Other public Cal-ITP data worth knowing about (not wired in yet):
`mtc_collab_2025/speeds/` has stop-to-stop Muni speeds by time of day for ~20
dates from Nov 2024 to Nov 2025, useful for checking the single 2026 day against many days.
`gtfs-rt-raw-2024-07/` has raw GTFS-RT protobuf snapshots every 20 s for Jul 1–7 2024.

## Pipeline (`pipeline/`)

1. `gtfs.py` builds one representative weekday shape per route and direction (bus routes + F),
   with its stops projected onto it → `data/processed/network.pkl`.
2. `fetch_calitp.py` (default) or `fetch_avl.py` (2021) writes `data/raw/avl_<day>.csv`.
3. `match.py` infers which route each bus was running: pings get heading-filtered
   candidate shapes from a KD-tree, each vehicle is segmented into trips by
   following consistently progressing shapes, fragments are stitched and
   terminal layover is trimmed. Rapid vs local (38/38R, 14/14R, …) share
   streets, so it decides by whether the bus halted at local-only stops.
   Result: ~6.7k trips/day, runtimes within ~10% of schedule for most routes.
4. `analyze.py` writes `web/data/`:
   speed grids (100 m × hour), time budgets (moving / crawling / at stop /
   stopped elsewhere), stop-level stopped time, runtimes, per-bus day
   timelines, citywide hotspots, Rapid-vs-local calibration and Market St
   bus-vs-subway inputs.

## Live data (511.org capture)

The key lives in `.env` (`MUNI_511_KEY=...`, gitignored). The collector polls
511's GTFS-realtime vehicle positions for Muni once every 61 s (the key allows
60 requests/hour) and appends to `data/raw/live/avl_<date>.csv`.

It runs as a LaunchAgent (`~/Library/LaunchAgents/com.transit-optimizer.muni-capture.plist`),
wrapped in `caffeinate -i`, so it survives closing the terminal, restarts after a
crash or reboot, and stops itself at the deadline in `data/raw/live/stop_at.txt`.

```
make capture-status   # last poll, row counts, errors, files
make capture-stop     # stop early (remove the plist too if you're done for good)
make live             # match every captured day and rebuild the dashboard from them
```
A closed laptop lid still sleeps the Mac and leaves a gap. Keep it on power with the lid open, or accept gaps.

## Modes and signals

All Muni modes are analyzed: buses, Muni Metro (J K L M N T), the F streetcar and
cable cars. Multi-car trains report every car under one trip, so only the lead car
counts toward statistics. Tunnel sections are found from station names and portals
(`UNDERGROUND_STATIONS` / `PORTALS` in `analyze.py`).

`signals.json` ranks signals by vehicle-hours spent in the 75 m approach, either
stopped away from a bus stop or crawling under 5 mph. Near-side stop time is
reported separately, and trains in tunnels are excluded.

## Publishing on GitHub Pages

The dashboard is static (HTML + JS + JSON), so it runs on GitHub Pages as-is; all
paths are relative, so it works under a project subpath (`/transit-optimizer/`).

```
make deploy      # copies web/ + its data to the `gh-pages` branch (one commit, force-pushed)
```
The generated data (~65 MB) lives only on `gh-pages`, replaced on each deploy, so it
never piles up in `main`'s history. One-time setup: *Settings → Pages → Deploy from a
branch → `gh-pages` / root*. The site is then at `https://<user>.github.io/transit-optimizer/`.

A Pages site is **public**, even if the repo is private, and Pages on a private repo
needs a paid GitHub plan (Pro/Team/Enterprise).

## Known limitations

- The 2026 data is a single composite weekday. Hour-by-100 m cells rest on a
  handful of trips, so look for patterns rather than single cells. June is
  outside the school year. The day seam is at 5pm, which cuts some trips.
- Vehicles appear in the realtime feed only while assigned to a trip, so yard
  time is invisible.
- (2021 archive) COVID-era service with several routes suspended; routes
  inferred by map matching.
- Cable-car trip labels are unreliable (cars keep a trip while parked), so about half are usable.
- Signal attribution measures waiting in the approach, not the cause. A queue can
  come from the next intersection, and signal timing plans aren't public.
- ~15–30 s pings blur short events. Halt probability is derived from measured
  stopped time ÷ an assumed dwell per halt (adjustable in the UI).
- Market St scenario: bus times come from the GPS data, subway times and frequencies
  from the current schedule. Subway crowding/capacity isn't modeled.
