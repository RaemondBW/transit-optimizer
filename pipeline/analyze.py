"""Turn matched trips into the JSON the dashboard reads (web/data/).

Outputs
  network.json        routes, simplified geometry, stops with stop-level stats
  route/<key>.json    speed heatmap (distance x hour), time budget, runtimes,
                      Marey/playback trips for one sample day
  hotspots.json       citywide places where buses lose the most time
  vehicles.json       per-bus day timelines (what each bus spent its time on)
  market.json         inputs for the Market St surface-bus -> subway transfer scenario
  calibration.json    observed seconds saved per skipped stop (Rapid vs local)
"""
import json
import os
import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from geo import angle_diff, bearing_deg, to_lonlat, to_xy

ROOT = Path(__file__).resolve().parent.parent
PROC = ROOT / "data" / "processed"
GTFS = ROOT / "data" / "gtfs"
WEB = ROOT / "web" / "data"

BIN = 100            # m, heatmap resolution along a route
HOURS = range(5, 24)
MAX_DT = 180         # s, longer ping gaps are not interpolated
HALF_CAP = 45        # s, max time a single ping can represent on each side
ZONE_UP, ZONE_DOWN = 40, 30   # m, stop zone around a stop (near/far side)
SAMPLE_DAY = None  # set in main(): the most recent day processed
TERMINAL_ZONE = 300  # m at each route end excluded from hotspot ranking
MPS_TO_MPH = 2.23694

STATES = ["moving", "crawl", "dwell", "stopped"]  # in-trip ping states



def write_atomic(path, text):
    """Write via a temp file + rename so the dashboard never reads a half-written file."""
    path = Path(path)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text)  # noqa
    os.replace(tmp, path)


def key(rid, d):
    return f"{rid}_{d}"


def load(patterns=("*",)):
    with open(PROC / "network.pkl", "rb") as f:
        net = pickle.load(f)
    trips = pd.concat([pd.read_parquet(p) for p in sorted({q for pat in patterns for q in PROC.glob(f"trips_{pat}.parquet")})], ignore_index=True)
    # trip ids are per-day; make them global
    trips["trip"] = trips.day.str.replace("-", "").astype(np.int64) * 100_000 + trips.trip
    if "lead" in trips:  # trailing cars of multi-car trains duplicate the lead car
        trips = trips[trips.lead]
    if "mode" not in trips:
        trips["mode"] = trips.route_id.map({r["route_id"]: r["mode"] for r in net["routes"].values()})
    trips = trips.sort_values(["trip", "t"]).reset_index(drop=True)
    return net, drop_layovers(trips)


def drop_layovers(trips, min_hold=300, tol=20):
    """Remove the interior of long stationary holds (short-turn / mid-route layovers).

    A bus that sits within `tol` m for over `min_hold` s is laying over, not
    delayed. Dropping the interior pings leaves a gap longer than MAX_DT, so
    the heatmap does not interpolate across it.
    """
    g = trips.groupby("trip")
    moved = (g.along.diff().fillna(np.inf) > tol) | (trips.trip != trips.trip.shift())
    run = moved.cumsum()
    span = trips.groupby(run).t.transform(lambda s: s.max() - s.min())
    first = trips.groupby(run).t.transform("min") == trips.t
    last = trips.groupby(run).t.transform("max") == trips.t
    drop = (span >= min_hold) & ~first & ~last
    print(f"dropping {drop.sum():,} layover pings ({drop.mean():.1%})")
    return trips[~drop].reset_index(drop=True)


# ---------------------------------------------------------------- subway geometry
UNDERGROUND_STATIONS = ("Metro ", "Van Ness Station", "Forest Hill Station", "West Portal Station",
                        "Yerba Buena/Moscone Station", "Union Square/Market St Station", "Chinatown - Rose Pak Station")
PORTALS = {  # where Muni Metro enters/leaves a tunnel (lat, lon)
    "Duboce": (37.76965, -122.42680), "Embarcadero": (37.79220, -122.39150),
    "Central Subway (4th St)": (37.77880, -122.39780),
}


def underground_ranges(routes):
    """(route, dir) -> (d0, d1) stretch of a rail route that runs in a tunnel."""
    px, py = to_xy([p[1] for p in PORTALS.values()], [p[0] for p in PORTALS.values()])
    out = {}
    for key_, r in routes.items():
        if r["mode"] != "rail":
            continue
        ds = [s["d"] for s in r["stops"] if s["name"].startswith(UNDERGROUND_STATIONS)]
        if not ds:
            continue
        for x, y in zip(px, py):
            dist = np.hypot(r["x"] - x, r["y"] - y)
            if dist.min() < 60:
                ds.append(float(r["d"][dist.argmin()]))
        d0, d1 = min(ds), max(ds)
        names = [s["name"] for s in r["stops"]]
        if names[0].startswith(UNDERGROUND_STATIONS):
            d0 = 0.0  # terminal inside the tunnel
        if names[-1].startswith(UNDERGROUND_STATIONS):
            d1 = r["length"]
        out[key_] = (d0, d1)
    return out


def stop_zone_mask(along, stop_d):
    """True where a position lies inside any stop zone."""
    if len(stop_d) == 0:
        return np.zeros(len(along), bool)
    j = np.searchsorted(stop_d, along + ZONE_UP)  # first stop beyond reach
    ok = np.zeros(len(along), bool)
    for k in (j - 1, j - 2):
        kk = np.clip(k, 0, len(stop_d) - 1)
        dd = stop_d[kk] - along  # positive: stop is ahead
        ok |= (k >= 0) & (dd <= ZONE_UP) & (dd >= -ZONE_DOWN)
    return ok


def ping_states(trips, routes):
    """Classify each in-trip ping and give it a time weight (half-interval rule)."""
    g = trips.groupby("trip")
    dtp = g.t.diff().fillna(0).clip(upper=HALF_CAP * 2)
    dtn = (-g.t.diff(-1)).fillna(0).clip(upper=HALF_CAP * 2)
    trips["w"] = (dtp + dtn) / 2
    trips["in_zone"] = False
    for (rid, d), idx in trips.groupby(["route_id", "direction_id"]).groups.items():
        sd = np.array([s["d"] for s in routes[(rid, d)]["stops"]])
        trips.loc[idx, "in_zone"] = stop_zone_mask(trips.loc[idx, "along"].values, sd)
    sp = trips.average_speed.values
    state = np.where(sp >= 5, 0, np.where(sp > 0, 1, np.where(trips.in_zone.values, 2, 3)))
    trips["state"] = state.astype(np.int8)
    return trips


def interval_bins(trips):
    """Spread every ping-to-ping interval over the distance bins it covers.

    Returns a frame of (route, dir, bin, hour, time_s, dist_m) contributions.
    """
    g = trips.groupby("trip")
    nxt_t = g.t.shift(-1)
    nxt_a = g.along.shift(-1)
    iv = pd.DataFrame({
        "route_id": trips.route_id, "direction_id": trips.direction_id, "trip": trips.trip,
        "t0": trips.t, "t1": nxt_t, "a0": trips.along, "a1": nxt_a}).dropna()
    iv = iv[(iv.t1 - iv.t0 <= MAX_DT) & (iv.t1 > iv.t0)]
    iv["dt"] = iv.t1 - iv.t0
    iv["dd"] = (iv.a1 - iv.a0).clip(lower=0)
    b0 = (iv.a0 // BIN).astype(int).values
    b1 = (np.maximum(iv.a1.values - 1e-6, iv.a0.values) // BIN).astype(int)
    n = b1 - b0 + 1
    rep = np.repeat(np.arange(len(iv)), n)
    offs = np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
    b = b0[rep] + offs
    a0, a1 = iv.a0.values[rep], iv.a1.values[rep]
    lo = np.maximum(a0, b * BIN)
    hi = np.minimum(np.maximum(a1, a0), (b + 1) * BIN)
    seg = np.maximum(hi - lo, 0)
    ddr = iv.dd.values[rep]
    frac = np.where(ddr > 0.5, seg / np.maximum(ddr, 1e-9), 1.0)
    frac = np.where((ddr <= 0.5) & (offs > 0), 0, frac)
    mid_t = (iv.t0.values[rep] + iv.t1.values[rep]) / 2
    return pd.DataFrame({
        "route_id": iv.route_id.values[rep], "direction_id": iv.direction_id.values[rep],
        "trip": iv.trip.values[rep], "bin": b, "hour": (mid_t // 3600).astype(int),
        "time": iv.dt.values[rep] * frac, "dist": np.where(ddr > 0.5, seg, 0.0)})


def simplify_line(x, y, d, step=25):
    k = np.unique(np.r_[np.arange(0, len(d), max(1, int(step // 10))), len(d) - 1])
    lon, lat = to_lonlat(x[k], y[k])
    return [[round(float(a), 5), round(float(o), 5), round(float(dd))] for a, o, dd in zip(lat, lon, d[k])]


def point_at(r, d):
    k = int(np.clip(round(d / 10), 0, len(r["x"]) - 1))
    lon, lat = to_lonlat(r["x"][k], r["y"][k])
    return float(lat), float(lon)


def main():
    WEB.mkdir(parents=True, exist_ok=True)
    (WEB / "route").mkdir(exist_ok=True)
    net, trips = load(sys.argv[1:] or ["*"])  # optional day globs, e.g. 2026-09-3* 2026-10-*
    routes, meta = net["routes"], net["route_meta"]
    days = sorted(trips.day.unique())
    n_days = len(days)
    global SAMPLE_DAY
    SAMPLE_DAY = days[-1]
    # describe the data source (composite-day exports carry a meta file)
    metas = [json.loads(p.read_text()) for d in days for p in [ROOT / "data" / "raw" / f"{d}.meta.json"] if p.exists()]
    source = {"days": days, "composite_of": [m["composite_of"] for m in metas],
              "realtime": bool(metas), "year": int(days[-1][:4])}
    print(f"{len(trips):,} pings, {trips.trip.nunique():,} trips, {n_days} days")

    trips = ping_states(trips, routes)
    contrib = interval_bins(trips)
    trips["hour"] = trips.t // 3600
    trips["bin"] = (trips.along // BIN).astype(int)

    # Per-trip extent (for traversal counts and runtimes)
    ext = trips.groupby("trip").agg(route_id=("route_id", "first"), direction_id=("direction_id", "first"),
                                    vehicle_id=("vehicle_id", "first"), day=("day", "first"),
                                    t0=("t", "min"), t1=("t", "max"), a0=("along", "min"), a1=("along", "max"))
    ext["len"] = [routes[(r, d)]["length"] for r, d in zip(ext.route_id, ext.direction_id)]
    ext["cov"] = (ext.a1 - ext.a0) / ext["len"]

    # ---- reference (free-flow-ish) speed per route-bin: 90th pct of hourly speeds
    hb = contrib.groupby(["route_id", "direction_id", "bin", "hour"]).agg(
        time=("time", "sum"), dist=("dist", "sum"), trips=("trip", "nunique")).reset_index()
    hb = hb[hb.hour.isin(HOURS)]
    hb["speed"] = hb.dist / hb.time.replace(0, np.nan)
    ok = hb[hb.trips >= 3]
    vref = ok.groupby(["route_id", "direction_id", "bin"]).speed.quantile(0.9)
    # trains run 40+ mph in tunnels and on reserved track; buses rarely beat 30
    rail_ids = {r["route_id"] for r in routes.values() if r["mode"] == "rail"}
    cap = np.where(vref.index.get_level_values(0).isin(rail_ids), 50, 30) / MPS_TO_MPH
    vref = vref.clip(lower=8 / MPS_TO_MPH).clip(upper=pd.Series(cap, index=vref.index))
    hb = hb.join(vref.rename("vref"), on=["route_id", "direction_id", "bin"])
    hb["delay"] = (hb.time - hb.dist / hb.vref).clip(lower=0)

    # ping-state time per route-bin (all hours) and per route-hour
    st_bin = trips.pivot_table(index=["route_id", "direction_id", "bin"], columns="state", values="w",
                               aggfunc="sum", fill_value=0)
    st_hour = trips.pivot_table(index=["route_id", "direction_id", "hour"], columns="state", values="w",
                                aggfunc="sum", fill_value=0)

    route_list, calib_rows = [], []
    for (rid, d), r in sorted(routes.items(), key=lambda kv: (kv[0][0].zfill(4), kv[0][1])):
        k = key(rid, d)
        mine = trips[(trips.route_id == rid) & (trips.direction_id == d)]
        e = ext[(ext.route_id == rid) & (ext.direction_id == d)]
        if len(e) < 3 * n_days:  # route barely ran in fall 2021 (COVID suspensions)
            continue
        nb = int(np.ceil(r["length"] / BIN))
        # traversals per bin = trips whose extent covers it
        cover = np.zeros(nb + 1)
        for a0, a1 in zip((e.a0 // BIN).astype(int), (e.a1 // BIN).astype(int)):
            cover[a0:min(a1, nb) + 1] += 1

        # -- heatmap grid (speed mph per bin x hour)
        h = hb[(hb.route_id == rid) & (hb.direction_id == d)]
        grid = {}
        for row in h.itertuples():
            if row.trips >= 3 and row.bin < nb and row.time > 0:
                grid.setdefault(int(row.hour), {})[int(row.bin)] = [
                    round(row.speed * MPS_TO_MPH, 1), int(row.trips), round(row.delay / row.trips, 1)]
        heat = {str(hr): [grid.get(hr, {}).get(b) for b in range(nb)] for hr in HOURS}

        # -- time budget per bin (seconds per traversal, all day) and per hour (share)
        sb = st_bin.loc[(rid, d)] if (rid, d) in st_bin.index.droplevel(2) else None
        budget_bin = []
        for b in range(nb):
            if sb is not None and b in sb.index and cover[b] > 0:
                v = sb.loc[b]
                budget_bin.append([round(float(v.get(s, 0)) / cover[b], 1) for s in range(4)])
            else:
                budget_bin.append(None)
        sh = st_hour.loc[(rid, d)] if (rid, d) in st_hour.index.droplevel(2) else None
        budget_hour = {}
        if sh is not None:
            for hr in HOURS:
                if hr in sh.index:
                    v = sh.loc[hr]
                    tot = float(v.sum())
                    if tot > 0:
                        budget_hour[str(hr)] = [round(float(v.get(s, 0)) / tot, 3) for s in range(4)]

        # -- runtimes by departure hour (full trips only)
        full = e[e["cov"] >= 0.85].copy()
        full["hour"] = full.t0 // 3600
        full["min"] = (full.t1 - full.t0) / 60 / full["cov"]  # normalize to full length
        rt = full.groupby("hour")["min"].agg(["median", lambda s: s.quantile(0.9), "size"])
        runtime = {str(int(hr)): [round(m, 1), round(p, 1), int(n)] for hr, (m, p, n) in rt.iterrows()
                   if hr in HOURS and n >= 2}
        sched = {str(hr): round(v / 60, 1) for hr, v in r["sched_runtime_by_hour"].items()}

        # -- stops: expected stopped time and chance a bus halts there
        sd = np.array([s["d"] for s in r["stops"]])
        zero = mine[mine.average_speed == 0]
        stops_out = []
        for i, s in enumerate(r["stops"]):
            lo_, hi_ = s["d"] - ZONE_UP, s["d"] + ZONE_DOWN
            traversals = e[(e.a0 <= lo_ + 5) & (e.a1 >= hi_ - 5)]
            n_tr = len(traversals)
            if i == 0 or i == len(r["stops"]) - 1 or n_tr == 0:
                p_halt, stopped = None, None
            else:
                z = zero[(zero.along >= lo_) & (zero.along <= hi_) & zero.trip.isin(traversals.index)]
                p_halt = round(z.trip.nunique() / n_tr, 3)
                stopped = round(float(z.w.sum()) / n_tr, 1)
            lat, lon = point_at(r, s["d"])
            stops_out.append({"id": s["stop_id"], "name": s["name"], "d": round(s["d"]), "lat": round(lat, 6),
                              "lon": round(lon, 6), "p": p_halt, "stopped": stopped,
                              "routes": [x for x in s["routes"] if x != rid]})

        # -- Marey / playback: sample day, compact [t, along, state]
        md = mine[mine.day == SAMPLE_DAY]
        md = md[~stale_repeat(md.trip.values, md.x.values, md.y.values, md.average_speed.values)]
        marey = []
        for tid, g in md.groupby("trip"):
            marey.append({"v": int(g.vehicle_id.iat[0]),
                          "p": np.c_[g.t.values, g.along.values.round(), g.state.values].astype(int).tolist()})

        out = {"key": k, "heat": heat, "bin": BIN, "budget_bin": budget_bin, "budget_hour": budget_hour,
               "runtime": runtime, "sched_runtime": sched, "stops": stops_out, "marey": marey,
               "sample_day": SAMPLE_DAY}
        write_atomic(WEB / "route" / f"{k}.json", json.dumps(out, separators=(",", ":")))

        m = meta.get(rid, {})
        route_list.append({
            "key": k, "route": rid, "dir": d, "family": r["family"], "mode": r["mode"], "name": m.get("route_long_name", ""),
            "headsign": r["headsign"], "color": "#" + str(m.get("route_color", "666666")).strip(),
            "length": round(r["length"]), "line": simplify_line(r["x"], r["y"], r["d"]),
            "trips_obs": round(len(e) / n_days, 1), "trips_per_hour": r["trips_per_hour"],
            "sched_runtime": sched,
            "stops": [{kk: s[kk] for kk in ("id", "name", "d", "lat", "lon", "p", "stopped", "routes")}
                      for s in stops_out],
        })
        print(f"{k:>6}: {len(e) / n_days:5.1f} trips/day, {len(marey)} sample trips")

        # -- calibration pairs (Rapid vs local over shared stretch)
        if rid.endswith("R") and (rid[:-1], d) in routes:
            calib_rows.append((rid, d))

    # every route's hourly speed grid in one small file (the city map needs only this)
    write_atomic(WEB / "heat_all.json", json.dumps({r["key"]: json.loads((WEB / "route" / f"{r['key']}.json").read_text())["heat"]
                                                    for r in route_list}, separators=(",", ":")))
    write_atomic(WEB / "network.json", json.dumps(
        {"routes": route_list, "days": days, "sample_day": SAMPLE_DAY, "bin": BIN, "source": source,
         "states": STATES}, separators=(",", ":")))

    fleet_budget(trips, n_days)
    hotspots(hb, trips, routes, n_days)
    calibration(calib_rows, routes, contrib, ext, n_days)
    vehicles(routes)
    market(routes, trips, ext, n_days)
    signals(routes, trips, ext, n_days)
    trunk(routes, trips, n_days)


def fleet_budget(trips, n_days):
    """Citywide in-service time by mode and hour: [moving, crawl, at stop, stopped] vehicle-hours/day.

    Drives the headline split (moving / at stops / stuck) and the timeline's
    "share of fleet stuck each hour" bars, for whichever mode is selected.
    """
    out = {}
    for mode, g in list(trips.groupby("mode")) + [("all", trips)]:
        p = g.pivot_table(index="hour", columns="state", values="w", aggfunc="sum", fill_value=0).reindex(columns=range(4), fill_value=0)
        out[mode] = {str(int(h)): [round(float(v) / 3600 / n_days, 2) for v in row] for h, row in p.iterrows() if 0 <= h <= 24}
    write_atomic(WEB / "fleet_budget.json", json.dumps(out, separators=(",", ":")))
    a = trips.groupby("state").w.sum()
    print("fleet budget: " + ", ".join(f"{n} {a.get(i, 0) / a.sum():.0%}" for i, n in enumerate(["moving", "crawl", "stop", "stopped"])))


def hotspots(hb, trips, routes, n_days):
    """Where buses lose the most time vs free-flow, grouped across routes by place."""
    agg = hb.groupby(["route_id", "direction_id", "bin"]).agg(delay=("delay", "sum"), time=("time", "sum")).reset_index()
    # terminal loops and layover zones are not "delay"; keep route ends out of the ranking
    lengths = np.array([routes[(r, d)]["length"] for r, d in zip(agg.route_id, agg.direction_id)])
    agg = agg[(agg.bin * BIN >= TERMINAL_ZONE) & ((agg.bin + 1) * BIN <= lengths - TERMINAL_ZONE)]
    st = trips.pivot_table(index=["route_id", "direction_id", "bin"], columns="state", values="w",
                           aggfunc="sum", fill_value=0).reindex(columns=range(4), fill_value=0)
    agg = agg.join(st, on=["route_id", "direction_id", "bin"])
    rows = []
    for row in agg.itertuples(index=False):
        r = routes[(row.route_id, row.direction_id)]
        dmid = min((row.bin + 0.5) * BIN, r["length"] - 1)
        k = int(dmid // 10)
        x, y, brg = r["x"][k], r["y"][k], r["bearing"][k]
        rows.append((row.route_id, row.direction_id, row.bin, x, y, brg, row.delay, row.time,
                     row[4], row[5], row[6], row[7]))
    df = pd.DataFrame(rows, columns=["route_id", "dir", "bin", "x", "y", "brg", "delay", "time",
                                     "moving", "crawl", "dwell", "stopped"])
    # tunnel sections are their own places, not the street above them
    ug = underground_ranges(routes)
    df["subway"] = [((r, d) in ug and ug[(r, d)][0] <= (b + 0.5) * BIN <= ug[(r, d)][1])
                    for r, d, b in zip(df.route_id, df.dir, df.bin)]
    df["cell"] = list(zip((df.x // 150).astype(int), (df.y // 150).astype(int), ((df.brg + 22.5) // 45 % 8).astype(int),
                          df.subway))
    stops_all = []
    for r in routes.values():
        for s in r["stops"]:
            k = min(int(s["d"] // 10), len(r["x"]) - 1)
            stops_all.append((r["x"][k], r["y"][k], s["name"], s["name"].startswith(UNDERGROUND_STATIONS)))
    sx = np.array([s[0] for s in stops_all]); sy = np.array([s[1] for s in stops_all])
    s_ug = np.array([s[3] for s in stops_all])
    mode_of = {r["route_id"]: r["mode"] for r in routes.values()}
    out = []
    for cell, g in df.groupby("cell"):
        delay_h = g.delay.sum() / n_days / 3600
        if delay_h < 0.5:
            continue
        x, y = np.average(g.x, weights=g.delay + 1e-6), np.average(g.y, weights=g.delay + 1e-6)
        # street-level places are named after street stops, tunnel places after stations
        near = int(np.argmin(np.hypot(sx - x, sy - y) + np.where(s_ug == bool(cell[3]), 0, 1e9)))
        lon, lat = to_lonlat(x, y)
        tot = g[["moving", "crawl", "dwell", "stopped"]].sum()
        slow = tot.sum() - tot.moving
        out.append({
            "lat": round(float(lat), 5), "lon": round(float(lon), 5),
            "name": stops_all[near][2].replace("Metro ", "") + (" (subway)" if cell[3] else ""), "subway": bool(cell[3]), "heading": ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][cell[2]],
            "bus_hours": round(float(delay_h), 2),
            # same lost time split by mode, so the dashboard can filter (bus / rail / streetcar / cable)
            "by_mode": {m: round(float(v) / n_days / 3600, 3) for m, v in
                        g.groupby(g.route_id.map(lambda r: mode_of.get(r, "bus"))).delay.sum().items() if v > 0},
            "routes": sorted({f"{a}" for a in g.route_id}),
            "cause": {k: round(float(tot[k] / slow), 3) if slow else 0 for k in ("crawl", "dwell", "stopped")},
        })
    out.sort(key=lambda o: -o["bus_hours"])
    write_atomic(WEB / "hotspots.json", json.dumps(out[:600], separators=(",", ":")))
    print(f"hotspots: {len(out)} cells, top: {out[0]['name']} {out[0]['bus_hours']} bus-h/day")


def calibration(pairs, routes, contrib, ext, n_days):
    """Observed time difference Local - Rapid per skipped stop, on the stretch both serve."""
    out = []
    for rid, d in pairs:
        loc, rap = routes[(rid[:-1], d)], routes[(rid, d)]
        # map rapid bins onto local bins through geometry
        from scipy.spatial import cKDTree
        tree = cKDTree(np.c_[loc["x"], loc["y"]])
        dist, ix = tree.query(np.c_[rap["x"], rap["y"]])
        shared = dist < 25
        if shared.sum() < 200:
            continue
        rap_bins = np.unique((rap["d"][shared] // BIN).astype(int))
        loc_bins = np.unique((loc["d"][ix[shared]] // BIN).astype(int))
        # only use bins with the whole 100 m shared
        res = {}
        for label, rr, bins in (("local", rid[:-1], loc_bins), ("rapid", rid, rap_bins)):
            c = contrib[(contrib.route_id == rr) & (contrib.direction_id == d) & contrib.bin.isin(bins)]
            c = c[c.hour.between(7, 19)]
            per = c.groupby(["trip", "bin"]).time.sum().groupby("bin").mean()
            res[label] = per
        n_len = min(len(loc_bins), len(rap_bins))
        t_loc, t_rap = res["local"].sum(), res["rapid"].sum()
        # stops on the shared stretch
        lo_d = loc["d"][ix[shared]]
        a, b = lo_d.min(), lo_d.max()
        n_loc = sum(1 for s in loc["stops"] if a <= s["d"] <= b)
        ra = rap["d"][shared]
        n_rap = sum(1 for s in rap["stops"] if ra.min() <= s["d"] <= ra.max())
        if n_loc - n_rap <= 0:
            continue
        per_stop = (t_loc - t_rap) / (n_loc - n_rap)
        n_trips = {lab: int(ext[(ext.route_id == rr) & (ext.direction_id == d)].shape[0] / n_days)
                   for lab, rr in (("local", rid[:-1]), ("rapid", rid))}
        out.append({"pair": f"{rid[:-1]} vs {rid}", "dir": d, "km": round(n_len * BIN / 1000, 1),
                    "trips_per_day": n_trips, "headsign": rap["headsign"],
                    "local_min": round(float(t_loc) / 60, 1), "rapid_min": round(float(t_rap) / 60, 1),
                    "local_stops": n_loc, "rapid_stops": n_rap, "sec_per_skipped_stop": round(float(per_stop), 1)})
        print(f"calibration {rid[:-1]}/{rid} d{d}: {out[-1]}")
    write_atomic(WEB / "calibration.json", json.dumps(out, separators=(",", ":")))


def vehicles(routes):
    """What every bus did all day on the sample day, as merged state segments."""
    v = pd.read_parquet(PROC / f"vehicles_{SAMPLE_DAY}.parquet")
    tr = pd.read_parquet(PROC / f"trips_{SAMPLE_DAY}.parquet")
    tr = ping_states(tr, routes)
    st = pd.Series(tr.state.values, index=pd.MultiIndex.from_arrays([tr.vehicle_id, tr.t]))
    lab = pd.Series((tr.route_id + "_" + tr.direction_id.astype(str)).values,
                    index=pd.MultiIndex.from_arrays([tr.vehicle_id, tr.t]))
    mi = pd.MultiIndex.from_arrays([v.vehicle_id, v.t])
    v["state"] = st.reindex(mi).values
    v["label"] = lab.reindex(mi).values
    # distance along the route shape, so playback can follow the street between pings
    al = pd.Series(tr.along.values, index=pd.MultiIndex.from_arrays([tr.vehicle_id, tr.t]))
    v["along"] = al[~al.index.duplicated()].reindex(mi).values
    if "route_along" in v:  # pings outside matched trips: use their reported route
        fill = v.along.isna() & v.route_along.notna()
        v.loc[fill, "along"] = v.loc[fill, "route_along"]
        v["shape_label"] = v.label.where(v.label.notna(), v.route_key.where(fill, None))
    else:
        v["shape_label"] = v.label
    v = v.sort_values(["vehicle_id", "t"])
    # outside trips: layover (short stationary gap between trips), deadhead, parked
    # codes: 0-3 = in-trip states, 4 layover, 5 deadhead/other moving, 6 parked, 7 no data
    out = {}
    summary = []
    pos_rows = []
    for vid, g in v.groupby("vehicle_id"):
        t = g.t.values
        s = g.state.values
        trip = g.trip.values
        codes = np.empty(len(g), np.int8)
        in_trip = trip > 0
        codes[in_trip] = s[in_trip].astype(np.int8)
        # trip index before/after each ping to spot layovers
        last_trip_t = pd.Series(np.where(in_trip, t, np.nan)).ffill().values
        next_trip_t = pd.Series(np.where(in_trip, t, np.nan)).bfill().values
        between = ~in_trip & ~np.isnan(last_trip_t) & ~np.isnan(next_trip_t) & ((next_trip_t - last_trip_t) < 45 * 60)
        slow = g.average_speed.values < 3
        codes[~in_trip] = np.where(between[~in_trip] & slow[~in_trip], 4, np.where(slow[~in_trip], 6, 5))
        labels = g.label.values
        segs = []
        for i in range(len(g)):
            t0 = t[i]
            t1 = t[i + 1] if i + 1 < len(g) else t0 + 30
            c = int(codes[i])
            if t1 - t0 > 600:  # data gap
                segs.append([int(t0), int(t0 + 30), c, labels[i] if isinstance(labels[i], str) else ""])
                segs.append([int(t0 + 30), int(t1), 7, ""])
                continue
            lb = labels[i] if isinstance(labels[i], str) else ""
            if segs and segs[-1][2] == c and segs[-1][3] == lb and segs[-1][1] >= t0 - 1:
                segs[-1][1] = int(t1)
            else:
                segs.append([int(t0), int(t1), c, lb])
        # drop micro-segments into neighbours for size
        if g.vclass.iat[0] == "other" or in_trip.sum() == 0:
            continue
        tot = np.zeros(8)
        for a, b, c, _ in segs:
            tot[c] += b - a
        main_routes = pd.Series([sg[3].split("_")[0] for sg in segs if sg[3]]).value_counts()
        out[str(vid)] = segs
        pos_rows.append(pd.DataFrame({"v": int(vid), "t": t, "x": g.x.values, "y": g.y.values, "c": codes,
                                      "al": np.nan_to_num(g.along.values, nan=-1).round().astype(int),
                                      "sp": g.average_speed.values,
                                      "lb": [x if isinstance(x, str) and x else "" for x in g.shape_label.values],
                                      "m": g.vclass.iat[0]}))
        summary.append({"v": int(vid), "mode": g.vclass.iat[0], "routes": main_routes.index[:3].tolist(),
                        "hours": [round(x / 3600, 2) for x in tot]})
    write_atomic(WEB / "vehicles.json", json.dumps({"day": SAMPLE_DAY, "summary": summary, "segments": out},
                                                  separators=(",", ":")))
    print(f"vehicles: {pd.Series([b['mode'] for b in summary]).value_counts().to_dict()}")
    positions(pd.concat(pos_rows, ignore_index=True))


def stale_repeat(vid, x, y, speed):
    """Pings that repeat the vehicle's previous position while it reports moving.

    The feed re-sends the last GPS fix (~25% of pings), then the next fix jumps
    ahead; animating through those makes vehicles stall and then dash. Keeping
    the first time each position was reported gives steady motion. Repeats at
    0 mph are real stops and are kept.
    """
    same = np.r_[False, (vid[1:] == vid[:-1]) & (x[1:] == x[:-1]) & (y[1:] == y[:-1])]
    return same & (speed > 2)


def positions(p, min_gap=20, pad=1200):
    """Every vehicle's GPS track for the sample day, in hourly files for map playback.

    web/data/positions/<HH>.json = {"routes": [labels], "v": {vehicle: [mode, [[t, lat*1e5, lon*1e5, code, route_idx, along_m, mph], ...]]}}
    along_m is the distance along that route's shape (-1 when not on a trip).
    Pings are thinned to one per `min_gap` s; each file also holds `pad` s on
    either side of its hour so the client can interpolate (and bridge GPS dropouts
    of up to 20 minutes) across the boundary.
    Parked/yard pings (code 6) are dropped.
    """
    p = p[p.c != 6].sort_values(["v", "t"])
    p = p[~stale_repeat(p.v.values, p.x.values, p.y.values, p.sp.values)]
    # thin to >= min_gap s per vehicle
    keep = np.ones(len(p), bool)
    last_v, last_t = None, -1e9
    for i, (vv, tt) in enumerate(zip(p.v.values, p.t.values)):
        if vv == last_v and tt - last_t < min_gap:
            keep[i] = False
        else:
            last_v, last_t = vv, tt
    p = p[keep]
    lon, lat = to_lonlat(p.x.values, p.y.values)
    p = p.assign(lat=np.round(lat * 1e5).astype(int), lon=np.round(lon * 1e5).astype(int))
    labels = sorted(set(p.lb) - {""})
    idx = {lb: i + 1 for i, lb in enumerate(labels)}
    p["ri"] = p.lb.map(idx).fillna(0).astype(int)
    d = WEB / "positions"
    d.mkdir(exist_ok=True)
    written = set()
    total = 0
    for h in range(0, 25):
        sel = p[(p.t >= h * 3600 - pad) & (p.t < (h + 1) * 3600 + pad)]
        if sel.empty:
            continue
        veh = {str(vv): [g.m.iat[0], g[["t", "lat", "lon", "c", "ri", "al", "sp"]].astype(int).values.tolist()]
               for vv, g in sel.groupby("v")}
        path = d / f"{h:02d}.json"
        write_atomic(path, json.dumps({"routes": labels, "v": veh}, separators=(",", ":")))
        written.add(path.name)
        total += path.stat().st_size
    for old in d.glob("*.json"):  # only now drop hours that no longer have data
        if old.name not in written:
            old.unlink()
    print(f"positions: {len(p):,} pings, {total / 1e6:.1f} MB in hourly files")


def market(routes, trips, ext, n_days):
    """Market St surface buses vs the Muni Metro subway underneath."""
    stations = [("Castro", "5728", "6991"), ("Church", "5726", "6998"), ("Van Ness", "5419", "6996"),
                ("Civic Center", "5727", "6997"), ("Powell", "5417", "6995"),
                ("Montgomery", "5731", "6994"), ("Embarcadero", "6992", "7217")]
    stops = pd.read_csv(GTFS / "stops.txt", dtype={"stop_id": str}).set_index("stop_id")
    sxy = {name: to_xy(stops.loc[ib, "stop_lon"], stops.loc[ib, "stop_lat"]) for name, ib, _ in stations}
    names = [s[0] for s in stations]

    # --- subway schedule: runtime between stations and trains per hour (weekday)
    tr = pd.read_csv(GTFS / "trips.txt", dtype=str)
    rt = pd.read_csv(GTFS / "routes.txt", dtype=str)
    rail = rt[(rt.route_type == "0") & (rt.route_id != "F")].route_id
    tr = tr[(tr.service_id == "M11") & tr.route_id.isin(rail)]
    st = pd.read_csv(GTFS / "stop_times.txt", dtype={"trip_id": str, "stop_id": str},
                     usecols=["trip_id", "stop_id", "departure_time"])
    st = st[st.trip_id.isin(tr.trip_id)]
    idmap = {}
    for name, ib, ob in stations:
        idmap[ib] = (name, "in"); idmap[ob] = (name, "out")
    idmap["7217"] = ("Embarcadero", "in")  # platform ids are shared at the terminal
    idmap["6992"] = ("Embarcadero", "out")
    st = st[st.stop_id.isin(idmap)]
    hms = st.departure_time.str.split(":", expand=True).astype(int)
    st["t"] = hms[0] * 3600 + hms[1] * 60 + hms[2]
    st["station"] = st.stop_id.map(lambda s: idmap[s][0])
    subway = {"in": {}, "out": {}}
    for tid, g in st.groupby("trip_id"):
        g = g.sort_values("t")
        seq = g.station.tolist()
        pos = [names.index(s) for s in seq]
        direction = "in" if pos[-1] > pos[0] else "out"
        for i in range(len(g)):
            for j in range(i + 1, len(g)):
                a, b = seq[i], seq[j]
                if a == b:
                    continue
                subway[direction].setdefault(f"{a}|{b}", []).append((int(g.t.iat[i] // 3600), int(g.t.iat[j] - g.t.iat[i])))
    sub_out = {}
    for direction, pairs in subway.items():
        for pair, v in pairs.items():
            df = pd.DataFrame(v, columns=["hour", "sec"])
            by_h = df.groupby("hour").agg(n=("sec", "size"), sec=("sec", "median"))
            sub_out.setdefault(direction, {})[pair] = {str(h): [int(r.n), round(r.sec / 60, 1)] for h, r in by_h.iterrows()}

    # --- which bus routes run on Market (shape within 30 m of the station line, aligned)
    line_x = np.array([sxy[n][0] for n in names]); line_y = np.array([sxy[n][1] for n in names])
    seg_d = np.r_[0, np.cumsum(np.hypot(np.diff(line_x), np.diff(line_y)))]
    fine = np.arange(0, seg_d[-1], 5.0)
    fx, fy = np.interp(fine, seg_d, line_x), np.interp(fine, seg_d, line_y)
    from scipy.spatial import cKDTree
    mk = cKDTree(np.c_[fx, fy])
    mk_brg = bearing_deg(np.gradient(fx), np.gradient(fy))
    res = []
    rail_times = {"in": {}, "out": {}}  # measured subway station-to-station times, all Metro lines pooled
    for (rid, d), r in routes.items():
        if r["mode"] == "cable":
            continue
        dist, ix = mk.query(np.c_[r["x"], r["y"]])
        brg_ok = angle_diff(r["bearing"], mk_brg[ix]) < 30
        brg_ok |= angle_diff(r["bearing"], (mk_brg[ix] + 180) % 360) < 30
        on = (dist < 40) & brg_ok
        if on.sum() * 10 < 800:
            continue
        # longest contiguous run on Market
        idx = np.nonzero(on)[0]
        breaks = np.nonzero(np.diff(idx) > 10)[0]
        runs = np.split(idx, breaks + 1)
        run = max(runs, key=len)
        d_on, d_off = float(r["d"][run[0]]), float(r["d"][run[-1]])
        m_on, m_off = fine[ix[run[0]]], fine[ix[run[-1]]]
        inbound = m_off > m_on
        # stations along the bus's Market stretch (by position on the station line)
        st_pos = {n: seg_d[i] for i, n in enumerate(names)}
        lo, hi = min(m_on, m_off), max(m_on, m_off)
        served = [n for n in names if lo - 250 <= st_pos[n] <= hi + 250]
        if len(served) < 2:
            continue
        # observed bus time from each station to each other along the stretch, by hour
        e = ext[(ext.route_id == rid) & (ext.direction_id == d)]
        mine = trips[(trips.route_id == rid) & (trips.direction_id == d)]
        def along_of_station(n):
            j = int(np.argmin(np.abs(fine[ix] - st_pos[n]) + np.where(on, 0, 1e9)))
            return float(r["d"][j])
        st_along = {n: along_of_station(n) for n in served}
        times = {}
        for tid, g in mine.groupby("trip"):
            a, t = g.along.values, g.t.values
            for i, n1 in enumerate(served):
                for n2 in served[i + 1:]:
                    x1, x2 = sorted((st_along[n1], st_along[n2]))
                    if a.min() > x1 or a.max() < x2:
                        continue
                    t1, t2 = np.interp([x1, x2], a, t)
                    first, second = (n1, n2) if st_along[n1] < st_along[n2] else (n2, n1)
                    times.setdefault(f"{first}|{second}", []).append((int(t1 // 3600), t2 - t1))
        if r["mode"] == "rail":
            for pair, v in times.items():
                rail_times["in" if inbound else "out"].setdefault(pair, []).extend(v)
            print(f"market: {rid} d{d} subway stations {sorted(served, key=lambda n: st_along[n])}")
            continue
        pair_out = {}
        for pair, v in times.items():
            df = pd.DataFrame(v, columns=["hour", "sec"])
            g = df.groupby("hour").sec.agg(["median", lambda s: s.quantile(0.9), "size"])
            pair_out[pair] = {str(h): [round(m / 60, 1), round(p / 60, 1), int(n)] for h, (m, p, n) in g.iterrows()
                              if n >= 3}
        # bus time on the Market stretch downstream of the first station (what truncation removes)
        res.append({"key": key(rid, d), "route": rid, "dir": d, "inbound": bool(inbound),
                    "headsign": r["headsign"], "on_market_m": round(abs(d_off - d_on)),
                    "d_on": round(d_on), "d_off": round(d_off), "length": round(r["length"]),
                    "stations": sorted(served, key=lambda n: st_along[n]),
                    "station_along": {n: round(v) for n, v in st_along.items()},
                    "trips_per_hour": r["trips_per_hour"], "bus_pair_min": pair_out,
                    "sched_runtime": {str(h): round(v / 60, 1) for h, v in r["sched_runtime_by_hour"].items()}})
        print(f"market: {rid} d{d} on Market {abs(d_off - d_on) / 1000:.1f} km, stations {res[-1]['stations']}")
    # observed: median / 90th pct minutes, trips measured, trains per hour (per weekday)
    sub_obs = {}
    for direction, pairs in rail_times.items():
        for pair, v in pairs.items():
            df = pd.DataFrame(v, columns=["hour", "sec"])
            g = df.groupby("hour").sec.agg(["median", lambda x: x.quantile(0.9), "size"])
            sub_obs.setdefault(direction, {})[pair] = {
                str(h): [round(m / 60, 1), round(p / 60, 1), int(n), round(n / n_days, 1)]
                for h, (m, p, n) in g.iterrows() if n >= 3}
    write_atomic(WEB / "market.json", json.dumps({"stations": names, "subway": sub_out, "subway_obs": sub_obs, "routes": res,
                                                 "station_ll": {n: list(map(float, to_lonlat(*sxy[n])))[::-1] for n in names}},
                                                separators=(",", ":")))


TRUNK_STATIONS = ["Embarcadero", "Montgomery", "Powell", "Civic Center", "Van Ness", "Church", "Castro", "Forest Hill", "West Portal"]
TRUNK_LINES = ["J", "K", "L", "M", "N"]   # the T uses the Central Subway, not Market St
APPROACH = 400                             # m of surface track before a portal, where merges queue


def trunk(routes, trips, n_days):
    """Inputs for "one train line in the Market St subway, everything else transfers".

    For each Metro line (inbound), from the GPS traces:
      - merge delay: time from 400 m before its tunnel portal to the portal, vs the
        free-flow time (10th percentile) on that stretch
      - today's ride from that point to each downtown station (median / 90th pct)
    Pooled across lines: station-to-station subway ride times, and how bunched
    trains are at Van Ness (expected wait vs. the average gap).
    """
    ug = underground_ranges(routes)
    lines, pooled, passings = [], {}, []
    for line in TRUNK_LINES:
        key_ = (line, 1)
        if key_ not in routes or key_ not in ug:
            continue
        r = routes[key_]
        entry = ug[key_][0]
        st_d = {}
        for name in TRUNK_STATIONS:
            m = [s["d"] for s in r["stops"] if name in s["name"] and s["name"].startswith(UNDERGROUND_STATIONS)]
            if m:
                st_d[name] = m[0]
        order = sorted(st_d, key=st_d.get)                  # stations in travel order
        transfer = next((n for n in order if st_d[n] >= entry - 50), None)
        P = max(entry - APPROACH, 0)
        mine = trips[(trips.route_id == line) & (trips.direction_id == 1)]
        rows = []
        for tid, g in mine.groupby("trip"):
            a, t = g.along.values, g.t.values
            if a.min() > P or a.max() < entry:
                continue
            tP, tE = np.interp([P, entry], a, t)
            rec = {"hour": int(tP // 3600), "approach": tE - tP}
            for n in order:
                if a.max() >= st_d[n] >= entry - 50:
                    rec[n] = float(np.interp(st_d[n], a, t)) - tP
            rows.append(rec)
            if "Van Ness" in st_d and a.min() <= st_d["Van Ness"] <= a.max():
                passings.append(float(np.interp(st_d["Van Ness"], a, t)))
        if not rows:
            continue
        df = pd.DataFrame(rows)
        ff = float(df.approach.quantile(0.10))
        stat = lambda col: {str(h): [round(g[col].median() / 60, 2), round(g[col].quantile(0.9) / 60, 2), int(g[col].count())]
                            for h, g in df.groupby("hour") if g[col].count() >= 2}
        to_station = {n: stat(n) for n in order if n in df}
        # pooled subway ride between stations (any line that runs both)
        for i, x in enumerate(order):
            for y in order[i + 1:]:
                if x in df and y in df:
                    d = df[["hour", x, y]].dropna()
                    pooled.setdefault(f"{x}|{y}", []).extend(zip(d.hour, d[y] - d[x]))
        lat, lon = to_lonlat(r["x"][min(int(entry // 10), len(r["x"]) - 1)], r["y"][min(int(entry // 10), len(r["y"]) - 1)])
        lines.append({"route": line, "key": key(line, 1), "headsign_out": routes.get((line, 0), {}).get("headsign", ""),
                      "portal": "West Portal" if transfer == "West Portal" else "Duboce", "transfer": transfer,
                      "entry_d": round(entry), "approach_m": APPROACH, "station_d": {n: round(v) for n, v in st_d.items()},
                      "free_flow_min": round(ff / 60, 2), "approach_min": stat("approach"), "to_station": to_station,
                      "trips_per_hour": r["trips_per_hour"], "portal_ll": [round(float(lat), 6), round(float(lon), 6)]})
        print(f"trunk: {line} enters at {lines[-1]['portal']} (transfer {transfer}); approach free-flow {ff/60:.1f} min, "
              f"median {df.approach.median()/60:.1f} min over {len(df)} trips")
    pairs = {}
    for pair, v in pooled.items():
        d = pd.DataFrame(v, columns=["hour", "sec"])
        pairs[pair] = {str(h): [round(g.sec.median() / 60, 2), round(g.sec.quantile(0.9) / 60, 2), int(len(g))]
                       for h, g in d.groupby("hour") if len(g) >= 3}
    # bunching at Van Ness (inbound): expected wait = E[h^2] / 2E[h] for a rider arriving at random
    p = np.sort(np.array(passings))
    h = np.diff(p)
    vn = {}
    for hr in range(5, 24):
        sel = h[(p[:-1] >= hr * 3600) & (p[:-1] < (hr + 1) * 3600) & (h < 1800)]
        if len(sel) >= 3:
            vn[str(hr)] = [int(len(sel) / n_days), round(float(sel.mean()) / 60, 2), round(float((sel ** 2).mean() / (2 * sel.mean())) / 60, 2)]
    # station coordinates for the map (from any line that serves them)
    st_ll = {}
    for line in TRUNK_LINES:
        for s in routes.get((line, 1), {}).get("stops", []):
            for n in TRUNK_STATIONS:
                if n not in st_ll and n in s["name"] and s["name"].startswith(UNDERGROUND_STATIONS):
                    r = routes[(line, 1)]; k = min(int(s["d"] // 10), len(r["x"]) - 1)
                    lo, la = to_lonlat(r["x"][k], r["y"][k]); st_ll[n] = [round(float(la), 6), round(float(lo), 6)]
    write_atomic(WEB / "trunk.json", json.dumps({"stations": TRUNK_STATIONS, "station_ll": st_ll, "lines": lines,
                                                 "pairs": pairs, "van_ness": vn}, separators=(",", ":")))
    if "8" in vn:
        print(f"trunk: Van Ness inbound at 8am: {vn['8'][0]} trains/h, avg gap {vn['8'][1]} min, expected wait {vn['8'][2]} min")


SIGNAL_TYPES = {"SIGNAL", "SIGNAL (CONTRACTOR MAINTAINED)", "CALTRANS", "CALTRANS (BY CONTRACTOR CONSORTIUM GLC)",
                "PENDING SIGNAL", "CALTRANS - HAWK"}
QUEUE_UP, QUEUE_DOWN = 75, 12   # m: the approach where vehicles queue for a light


def signals(routes, trips, ext, n_days):
    """Time vehicles spend held at each traffic signal.

    Signals come from SFMTA's inventory (DataSF ybh5-27n2). For every route
    passing within 20 m of a signal, pings in the ~75 m approach are attributed
    to it (to the nearest signal ahead when signals are close together):
      wait      = stopped away from a bus stop, or crawling (<5 mph): queueing for the light
      near_side = stopped at a bus stop inside the approach: boarding and red light overlap
    Trains inside tunnels are excluded (a signal above the subway isn't holding them).
    """
    path = ROOT / "data" / "signals" / "traffic_signals.json"
    if not path.exists():
        print("signals: data/signals/traffic_signals.json missing, skipping")
        return
    raw = [x for x in json.loads(path.read_text()) if x.get("type") in SIGNAL_TYPES and x.get("shape")]
    lon = np.array([x["shape"]["coordinates"][0] for x in raw]); lat = np.array([x["shape"]["coordinates"][1] for x in raw])
    sx, sy = to_xy(lon, lat)
    names = [f"{titlecase(x.get('street1', ''))} & {titlecase(x.get('street2', ''))}" for x in raw]
    ug = underground_ranges(routes)
    from scipy.spatial import cKDTree
    stree = cKDTree(np.c_[sx, sy])
    acc = {}  # signal index -> aggregates
    for key_, r in routes.items():
        rid, d = key_
        near = stree.query_ball_point(np.c_[r["x"], r["y"]], 20)
        best = {}
        for k, lst in enumerate(near):
            for j in lst:
                dd = np.hypot(r["x"][k] - sx[j], r["y"][k] - sy[j])
                if j not in best or dd < best[j][1]:
                    best[j] = (float(r["d"][k]), dd)
        if not best:
            continue
        sig = sorted((a, j) for j, (a, _) in best.items()
                     if 150 < a < r["length"] - 150 and not (key_ in ug and ug[key_][0] <= a <= ug[key_][1]))
        if not sig:
            continue
        sig_d = np.array([a for a, _ in sig]); sig_j = np.array([j for _, j in sig])
        mine = trips[(trips.route_id == rid) & (trips.direction_id == d)]
        e = ext[(ext.route_id == rid) & (ext.direction_id == d)]
        if mine.empty:
            continue
        a = mine.along.values
        k = np.searchsorted(sig_d, a - QUEUE_DOWN)  # first signal at or just behind the vehicle
        k = np.clip(k, 0, len(sig_d) - 1)
        ahead = sig_d[k] - a
        inq = (ahead <= QUEUE_UP) & (ahead >= -QUEUE_DOWN)
        st = mine.state.values
        wait = inq & ((st == 3) | (st == 1))
        nside = inq & (st == 2)
        w = mine.w.values
        hrs = mine.hour.values
        for idx_sig in range(len(sig_d)):
            sel_w = wait & (k == idx_sig)
            sel_n = nside & (k == idx_sig)
            lo, hi = sig_d[idx_sig] - QUEUE_UP, sig_d[idx_sig] + QUEUE_DOWN
            passes = int(((e.a0 <= lo + 5) & (e.a1 >= hi - 5)).sum())
            if passes == 0:
                continue
            j = int(sig_j[idx_sig])
            g = acc.setdefault(j, {"wait": 0.0, "nside": 0.0, "passes": 0, "by_mode": {}, "hours": np.zeros(24),
                                   "approaches": []})
            ws, ns = float(w[sel_w].sum()), float(w[sel_n].sum())
            g["wait"] += ws; g["nside"] += ns; g["passes"] += passes
            g["by_mode"][r["mode"]] = g["by_mode"].get(r["mode"], 0) + ws
            np.add.at(g["hours"], np.clip(hrs[sel_w], 0, 23), w[sel_w])
            g["approaches"].append({"route": rid, "dir": d, "key": key(rid, d), "mode": r["mode"],
                                    "headsign": r["headsign"], "wait_s": round(ws / passes, 1),
                                    "passes": round(passes / n_days, 1), "hours": round(ws / 3600 / n_days, 2),
                                    "near_side_s": round(ns / passes, 1), "along": round(sig_d[idx_sig])})
    out = []
    for j, g in acc.items():
        if g["wait"] <= 0:
            continue
        g["approaches"].sort(key=lambda x: -x["hours"])
        out.append({"id": raw[j].get("cnn") or str(j), "name": names[j], "lat": round(float(lat[j]), 6),
                    "lon": round(float(lon[j]), 6), "type": raw[j].get("type"),
                    "veh_hours": round(g["wait"] / 3600 / n_days, 2),
                    "near_side_hours": round(g["nside"] / 3600 / n_days, 2),
                    "passes": round(g["passes"] / n_days, 1),
                    "avg_wait_s": round(g["wait"] / g["passes"], 1),
                    "by_mode": {m: round(v / 3600 / n_days, 2) for m, v in g["by_mode"].items()},
                    "hours": [round(h / 3600 / n_days, 3) for h in g["hours"]],
                    "approaches": g["approaches"][:8]})
    out.sort(key=lambda o: -o["veh_hours"])
    write_atomic(WEB / "signals.json", json.dumps({"signals": out, "n_signals": len(raw),
                                                  "queue_m": QUEUE_UP}, separators=(",", ":")))
    tot = sum(o["veh_hours"] for o in out)
    print(f"signals: {len(out)} of {len(raw)} signals hold transit; {tot:.0f} vehicle-hours/day; "
          f"top: {out[0]['name']} {out[0]['veh_hours']} h/day, {out[0]['avg_wait_s']} s/pass")


def titlecase(s):
    """ELLIS -> Ellis, 04TH ST -> 4th St."""
    import re
    return re.sub(r"\b0+(\d)", r"\1", " ".join(w.capitalize() for w in str(s).lower().split()))


if __name__ == "__main__":
    main()
