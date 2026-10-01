"""Map-match raw AVL pings to GTFS route shapes and split them into trips.

The DataSF AVL archive has no route/trip id, so we infer it:
  1. every ping gets candidate (route-direction, distance-along) pairs from a
     KD-tree over densified shapes, filtered by heading;
  2. per vehicle, we keep the set of shapes the bus is consistently progressing
     along; when none survive, the trip ends and a new one starts;
  3. among surviving shapes (e.g. 38 vs 38R on Geary) we pick by stop pattern:
     a bus that halts at local-only stops is a local.

Realtime feeds (511) carry a route id; if the input has a `route_id` column,
candidates are restricted to that route.

Output: data/processed/trips_<day>.parquet (one row per matched ping) and
        data/processed/vehicles_<day>.parquet (vehicle day timelines).
"""
import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from geo import angle_diff, to_xy

ROOT = Path(__file__).resolve().parent.parent
PROC = ROOT / "data" / "processed"
RAW = ROOT / "data" / "raw"

RADIUS = 30.0          # m, max ping-to-shape distance
HEADING_TOL = 55.0     # deg
MAX_MISSES = 4         # consecutive unmatched pings before a shape is dropped
MAX_GAP = 600          # s without a match closes the trip
BACKSLIDE = 120.0      # m of backwards GPS jitter tolerated
JOIN_PINGS = 6          # shapes may join a trip during its first pings
MERGE_GAP = 600        # s; stitch same-route fragments separated by less


def load_network():
    with open(PROC / "network.pkl", "rb") as f:
        return pickle.load(f)


def build_index(routes):
    keys = list(routes)
    xs, ys, ds, bs, sid = [], [], [], [], []
    for i, k in enumerate(keys):
        r = routes[k]
        xs.append(r["x"]); ys.append(r["y"]); ds.append(r["d"]); bs.append(r["bearing"])
        sid.append(np.full(len(r["x"]), i, dtype=np.int32))
    xs, ys = np.concatenate(xs), np.concatenate(ys)
    return keys, cKDTree(np.c_[xs, ys]), np.concatenate(ds), np.concatenate(bs), np.concatenate(sid)


def vehicle_class_from_routes(p, routes):
    """Realtime feeds say which route a vehicle serves; classify per vehicle by that route's mode."""
    mode_of = {r["route_id"]: r["mode"] for r in routes.values()}
    row = p.route_id.map(mode_of).fillna("other").where(p.route_id != "", "")
    known = row[row != ""]
    per_vehicle = known.groupby(p.vehicle_id[known.index]).agg(lambda x: x.mode().iat[0])
    return p.vehicle_id.map(per_vehicle).fillna("other").values


def vehicle_class(vid):
    """Archive feeds have no route ids: classify by Muni fleet-number ranges.

    Light rail (14xx Breda, 2xxx Siemens) is left out of archive matching:
    subway positions there are unreliable and trains can't be told apart by route.
    """
    v = np.asarray(vid)
    bus = (v >= 5000) & (v < 9000)
    streetcar = (v >= 100) & (v < 1100)  # historic F-line cars
    return np.where(bus, "bus", np.where(streetcar, "streetcar", "other"))


def candidates(p, keys, routes, tree, pd_, pb, psid):
    """Long table of (ping, shape, along, offset) for plausible matches."""
    shape_mode = np.array([routes[k]["mode"] for k in keys])
    route_ids = np.array([routes[k]["route_id"] for k in keys])
    dir_ids = np.array([routes[k]["direction_id"] for k in keys])
    out = []
    xy = np.c_[p.x.values, p.y.values]
    K = 160
    for s in range(0, len(p), 100_000):
        dist, idx = tree.query(xy[s:s + 100_000], k=K, distance_upper_bound=RADIUS)
        ok = np.isfinite(dist)
        pi, kk = np.nonzero(ok)
        ix = idx[pi, kk]
        gi = pi + s
        sh = psid[ix]
        head = p.heading.values[gi]
        spd = p.average_speed.values[gi]
        head_ok = (angle_diff(head, pb[ix]) <= HEADING_TOL) | ((spd == 0) & (head == 0))
        m = head_ok & (shape_mode[sh] == p.vclass.values[gi])  # buses only on bus routes, etc.
        if "route_id" in p:  # realtime feed: trust the reported route (and direction)
            rid = p.route_id.values[gi]
            m &= route_ids[sh] == rid  # no trip assigned = out of service: never a trip
            if "direction_id" in p:
                did = p.direction_id.values[gi]
                m &= (did < 0) | (dir_ids[sh] == did)
        out.append(pd.DataFrame({"i": gi[m], "s": sh[m], "along": pd_[ix[m]], "off": dist[pi, kk][m]}))
    c = pd.concat(out).sort_values(["i", "s", "off"]).drop_duplicates(["i", "s"])
    return c


def local_only_stops(routes):
    """For each Rapid/local pair: positions (on the local shape) of stops the Rapid skips."""
    out = {}
    for (rid, d), r in routes.items():
        if not rid.endswith("R") or (rid[:-1], d) not in routes:
            continue
        loc = routes[(rid[:-1], d)]
        rap_xy = np.array([(r["x"][min(int(s["d"] // 10), len(r["x"]) - 1)],
                            r["y"][min(int(s["d"] // 10), len(r["y"]) - 1)]) for s in r["stops"]])
        lo = []
        for s in loc["stops"]:
            k = min(int(s["d"] // 10), len(loc["x"]) - 1)
            if np.hypot(rap_xy[:, 0] - loc["x"][k], rap_xy[:, 1] - loc["y"][k]).min() > 60:
                lo.append(s["d"])
        out[(rid[:-1], d)] = np.array(lo)
    return out


def pick_shape(active, retired, members, trip_pings, keys, routes, lonly):
    """Choose among surviving shapes (most matched pings wins).

    Local vs Rapid share streets, so they tie on hits; there we count halts at
    stops only the local serves. Rapids rarely halt at them, locals usually do.
    """
    best_hits = max(a["hits"] for a in active.values())
    choice = max(active, key=lambda s: active[s]["hits"])
    # siblings may have been retired when the bus ran past their terminus
    both = {**retired, **active}
    fam = [s for s, a in both.items() if a["hits"] >= 0.6 * best_hits
           and routes[keys[s]]["family"] == routes[keys[choice]]["family"]]
    if len(fam) > 1:
        loc = next((s for s in fam if not routes[keys[s]]["route_id"].endswith("R")), None)
        rap = next((s for s in fam if routes[keys[s]]["route_id"].endswith("R")), None)
        if loc is not None and rap is not None:
            lo = lonly.get(keys[loc], np.array([]))
            a = members[loc]
            lo = lo[(lo >= a.min()) & (lo <= a.max())]
            halted = a[a.index.isin(trip_pings.index[trip_pings.average_speed == 0])]
            n = int((np.abs(halted.values[:, None] - lo[None, :]).min(axis=1) <= 30).sum()) if len(lo) and len(halted) else 0
            choice = loc if n >= max(3, 0.2 * len(lo)) else rap
    return choice


def segment_vehicle(g, cand_by_ping, keys, routes, lonly):
    """Greedy trip segmentation for one vehicle-day. Yields (shape, ping_rows)."""
    idx = g.index.values
    t = g.t.values
    fam_of = {s: (routes[k]["family"], routes[k]["direction_id"]) for s, k in enumerate(keys)}
    n = len(idx)
    i = 0
    while i < n:
        c = cand_by_ping.get(idx[i])
        if not c:
            i += 1
            continue
        active = {s: {"last": a, "miss": 0, "hits": 1, "t": t[i]} for s, a in c.items()}
        hits = {s: {idx[i]: a} for s, a in c.items()}
        retired = {}
        last_hit = i
        j = i + 1
        while j < n:
            if t[j] - t[last_hit] > MAX_GAP:
                break
            c = cand_by_ping.get(idx[j], {})
            nxt = {}
            for s, a in active.items():
                al = c.get(s)
                dt = t[j] - a["t"]
                if al is not None and al >= a["last"] - BACKSLIDE and al - a["last"] <= 25 * dt + 200:
                    nxt[s] = {"last": max(a["last"], al), "miss": 0, "hits": a["hits"] + 1, "t": t[j]}
                    hits[s][idx[j]] = al
                elif a["miss"] < MAX_MISSES:
                    nxt[s] = dict(a, miss=a["miss"] + 1)
                else:
                    retired[s] = a
            fams = {fam_of[s] for s in nxt}
            for s, al in c.items():
                # late joiners: early on (first ping may be off-shape), or a
                # local/rapid sibling of a shape we're already following
                if s not in nxt and s not in hits and (j - i < JOIN_PINGS or fam_of[s] in fams):
                        nxt[s] = {"last": al, "miss": 0, "hits": 1, "t": t[j]}
                        hits[s] = {idx[j]: al}
            if not nxt:
                break
            if any(v["miss"] == 0 for v in nxt.values()):
                last_hit = j
            active = nxt
            j += 1
        if active:
            members = {s: pd.Series(h) for s, h in hits.items()}
            s = pick_shape(active, retired, members, g.loc[idx[i:last_hit + 1]], keys, routes, lonly)
            yield s, members[s]
        i = last_hit + 1


def stitch(segs, times):
    """Join consecutive fragments of the same route-direction (GPS gaps, detours)."""
    out = []
    # stationary blobs (terminal layovers) would otherwise sit between the pieces of a trip
    segs = [(s, m) for s, m in segs if m.max() - m.min() >= 30]
    for s, m in segs:
        if out and out[-1][0] == s:
            ps, pm = out[-1]
            gap = times[m.index.min()] - times[pm.index.max()]
            if gap <= MERGE_GAP and m.iloc[0] >= pm.max() - 300:
                out[-1] = (s, pd.concat([pm, m]))
                continue
        out.append((s, m))
    return out


def trim_layover(member, times):
    """Drop terminal layover: pings before the bus leaves / after it arrives."""
    a = member.cummax()
    dep = np.nonzero(a.values <= a.values[0] + 30)[0][-1]
    arr = np.nonzero(a.values >= a.values[-1] - 30)[0][0]
    if arr <= dep:
        return member.iloc[:0]
    return a.iloc[dep:arr + 1]


def segment_by_trip_id(g, cand_by_ping, keys, key_index):
    """Realtime feeds label every ping with its GTFS trip: one segment per (vehicle, trip).

    Positions are projected onto that trip's route shape; pings that jump
    backwards (GPS noise, loop geometry) beyond BACKSLIDE are dropped.
    """
    for (tid, rid, did), h in g.groupby(["trip_id", "route_id", "direction_id"], sort=False):
        s = key_index.get((rid, did))
        if s is None:
            continue
        al = {i: cand_by_ping[i][s] for i in h.index if s in cand_by_ping.get(i, {})}
        if len(al) < 2:
            continue
        m = pd.Series(al).sort_index()
        keep = m >= m.cummax() - BACKSLIDE
        yield s, m[keep]


def lead_vehicle(trips):
    """Multi-car trains report every car under one GTFS trip; keep one car per trip.

    Returns a per-row flag: True for the car with the most pings on that trip
    (and for every row when the feed has no trip ids). Followers stay in the
    vehicle timelines but are excluded from speed and runtime statistics.
    """
    if "trip_id" not in trips:
        return True
    per = trips.groupby("trip").agg(gtfs=("trip_id", lambda s: s.mode().iat[0] if s.notna().any() else None),
                                    n=("t", "size"))
    per = per.dropna(subset=["gtfs"]).sort_values("n", ascending=False)
    followers = per[per.duplicated("gtfs")].index
    return ~trips.trip.isin(followers)


def match_day(path: Path, net):
    routes = net["routes"]
    keys, tree, pd_, pb, psid = build_index(routes)
    p = pd.read_csv(path, dtype={"route_id": str})
    p = p.rename(columns={"vehicle_position_date_time": "ts"})
    if "route_id" in p:
        p["route_id"] = p.route_id.fillna("")
        if "direction_id" in p:
            p["direction_id"] = p.direction_id.fillna(-1).astype(int)
        p["vclass"] = vehicle_class_from_routes(p, routes)
    else:
        p["vclass"] = vehicle_class(p.vehicle_id.values)
    p = p[p.vclass != "other"].copy()
    ts = pd.to_datetime(p.ts)
    day = ts.dt.normalize().iloc[0]
    p["t"] = (ts - day).dt.total_seconds().astype(int)
    p["x"], p["y"] = to_xy(p.loc_x.values, p.loc_y.values)
    p = p.sort_values(["vehicle_id", "t"]).drop_duplicates(["vehicle_id", "t"]).reset_index(drop=True)
    print(f"{path.name}: {len(p):,} pings, {p.vehicle_id.nunique()} vehicles {p.groupby('vclass').vehicle_id.nunique().to_dict()}")

    c = candidates(p, keys, routes, tree, pd_, pb, psid)
    print(f"  {len(c):,} candidate matches for {c.i.nunique():,} pings")
    cand_by_ping = {}
    for i, s, a in zip(c.i.values, c.s.values, c.along.values):
        cand_by_ping.setdefault(i, {})[s] = a

    lonly = local_only_stops(routes)
    by_trip = "trip_id" in p and "direction_id" in p
    key_index = {k: i for i, k in enumerate(keys)}
    if by_trip:
        p["trip_id"] = p.trip_id.fillna("")
    rows, trip_id = [], 0
    for vid, g in p.groupby("vehicle_id"):
        if by_trip:
            pieces = segment_by_trip_id(g, cand_by_ping, keys, key_index)
        else:
            pieces = stitch(list(segment_vehicle(g, cand_by_ping, keys, routes, lonly)), g.t)
        for s, member in pieces:
            r = routes[keys[s]]
            member = trim_layover(member.sort_index(), g.t)
            span = member.max() - member.min()
            # short lines (cable cars) can't clear a fixed 1.5 km bar
            if span < max(min(1500, 0.5 * r["length"]), 0.3 * r["length"]) or len(member) < 6:
                continue
            trip_id += 1
            cols = ["vehicle_id", "t", "x", "y", "average_speed"] + (["trip_id"] if "trip_id" in p else [])
            sub = p.loc[member.index, cols].copy()
            sub["along"] = member.values
            sub["trip"] = trip_id
            sub["route_id"] = r["route_id"]
            sub["direction_id"] = r["direction_id"]
            rows.append(sub)
    trips = pd.concat(rows, ignore_index=True)
    trips["mode"] = trips.route_id.map({r["route_id"]: r["mode"] for r in routes.values()})
    trips["lead"] = lead_vehicle(trips)
    trips["day"] = day.strftime("%Y-%m-%d")
    out = PROC / f"trips_{day:%Y-%m-%d}.parquet"
    trips.to_parquet(out)
    by_mode = trips[trips.lead].groupby("mode").trip.nunique().to_dict()
    print(f"  {trip_id:,} trips {by_mode}, {len(trips):,} pings matched ({len(trips) / len(p):.0%}) -> {out.name}")

    # Vehicle timelines: raw pings plus which trip (if any) each belongs to.
    tmap = pd.Series(trips.trip.values, index=pd.MultiIndex.from_arrays([trips.vehicle_id, trips.t]))
    p["trip"] = tmap.reindex(pd.MultiIndex.from_arrays([p.vehicle_id, p.t])).fillna(0).astype(int).values
    p[["vehicle_id", "vclass", "t", "x", "y", "average_speed", "trip"]].to_parquet(
        PROC / f"vehicles_{day:%Y-%m-%d}.parquet")
    return trips


if __name__ == "__main__":
    net = load_network()
    files = [Path(a) for a in sys.argv[1:]] or sorted(RAW.glob("avl_*.csv"))
    for f in files:
        match_day(f, net)
