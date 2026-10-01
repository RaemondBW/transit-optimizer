"""Build the route network used for map-matching and scenario modelling.

For every bus, light-rail, streetcar and cable-car route and direction, pick the most
common weekday shape, densify it, project its stops onto it, and count scheduled
trips per hour. Output: data/processed/network.pkl
"""
import pickle
from pathlib import Path

import numpy as np
import pandas as pd

from geo import bearing_deg, to_xy

ROOT = Path(__file__).resolve().parent.parent
GTFS = ROOT / "data" / "gtfs"
OUT = ROOT / "data" / "processed"

WEEKDAY_SERVICE = "M11"
# Owl, express, bus-bridge and early-bird variants mostly duplicate daytime
# alignments and would only confuse the matcher.
SKIP = {"90", "91", "LOWL", "NOWL", "KBUS", "NBUS", "TBUS", "FBUS", "714",
        "1X", "8AX", "8BX", "30X", "15", "25"}
STEP = 10.0  # densify spacing, meters


def mode(route_id: str, route_type: str) -> str:
    if route_type == "5":
        return "cable"
    if route_type == "0":
        return "streetcar" if route_id == "F" else "rail"
    return "bus"


def family(route_id: str) -> str:
    """38R -> 38, 5R -> 5, 14R -> 14: locals and rapids share a corridor."""
    return route_id[:-1] if route_id.endswith("R") and route_id[:-1].isdigit() else route_id


def secs(hms: pd.Series) -> pd.Series:
    p = hms.str.split(":", expand=True).astype(int)
    return p[0] * 3600 + p[1] * 60 + p[2]


def densify(x, y):
    seg = np.hypot(np.diff(x), np.diff(y))
    cum = np.concatenate([[0], np.cumsum(seg)])
    d = np.arange(0, cum[-1], STEP)
    return np.interp(d, cum, x), np.interp(d, cum, y), d, cum


def project_stops_sequential(sx, sy, lx, ly, cum):
    """Project stops in trip order, never moving backwards (handles loops)."""
    ax, ay = lx[:-1], ly[:-1]
    dx, dy = lx[1:] - ax, ly[1:] - ay
    seglen = np.maximum(np.hypot(dx, dy), 1e-6)
    out, offs, last_seg = [], [], 0
    for px, py in zip(sx, sy):
        t = np.clip(((px - ax) * dx + (py - ay) * dy) / seglen ** 2, 0, 1)
        d = np.hypot(px - (ax + t * dx), py - (ay + t * dy))
        d[:last_seg] = np.inf
        i = int(d.argmin())
        last_seg = i
        out.append(cum[i] + t[i] * seglen[i])
        offs.append(d[i])
    return np.array(out), np.array(offs)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    routes = pd.read_csv(GTFS / "routes.txt", dtype=str)
    trips = pd.read_csv(GTFS / "trips.txt", dtype={"route_id": str, "shape_id": str, "trip_id": str})
    stops = pd.read_csv(GTFS / "stops.txt", dtype={"stop_id": str})
    shapes = pd.read_csv(GTFS / "shapes.txt", dtype={"shape_id": str}).sort_values(["shape_id", "shape_pt_sequence"])
    st = pd.read_csv(GTFS / "stop_times.txt", dtype={"trip_id": str, "stop_id": str},
                     usecols=["trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time"])

    keep = routes[routes.route_type.isin(["0", "3", "5"])]  # light rail, bus, cable car
    keep = keep[~keep.route_id.isin(SKIP)]
    wk = trips[(trips.service_id == WEEKDAY_SERVICE) & trips.route_id.isin(keep.route_id)]
    st = st[st.trip_id.isin(wk.trip_id)].sort_values(["trip_id", "stop_sequence"])
    st["t"] = secs(st.departure_time)
    first = st.groupby("trip_id").first().reset_index()[["trip_id", "t"]]
    last = st.groupby("trip_id").t.last().rename("t_end").reset_index()
    wk = wk.merge(first, on="trip_id").merge(last, on="trip_id")
    wk["runtime"] = wk.t_end - wk.t

    stop_xy = dict(zip(stops.stop_id, zip(*to_xy(stops.stop_lon, stops.stop_lat))))
    stop_name = dict(zip(stops.stop_id, stops.stop_name))
    stop_routes = st.merge(wk[["trip_id", "route_id"]], on="trip_id").groupby("stop_id").route_id.agg(lambda s: sorted(set(s)))

    rtype = dict(zip(routes.route_id, routes.route_type))
    network = {}
    for (rid, did), g in wk.groupby(["route_id", "direction_id"]):
        shape_id = g.shape_id.value_counts().index[0]
        sp = shapes[shapes.shape_id == shape_id]
        x, y = to_xy(sp.shape_pt_lon.values, sp.shape_pt_lat.values)
        dxs, dys, dd, cum = densify(x, y)
        # bearing of each densified point from a +-20 m window (smooths vertex noise)
        k = 2
        bx = np.r_[dxs[k:], [dxs[-1]] * k] - np.r_[[dxs[0]] * k, dxs[:-k]]
        by = np.r_[dys[k:], [dys[-1]] * k] - np.r_[[dys[0]] * k, dys[:-k]]
        brg = bearing_deg(bx, by)

        rep = g[g.shape_id == shape_id]
        # representative trip: the stop pattern most trips on this shape use
        patt = st[st.trip_id.isin(rep.trip_id)].groupby("trip_id").stop_id.agg(tuple)
        pattern = patt.value_counts().index[0]
        sx = np.array([stop_xy[s][0] for s in pattern])
        sy = np.array([stop_xy[s][1] for s in pattern])
        along, off = project_stops_sequential(sx, sy, x, y, cum)

        rep_trip = patt[patt == pattern].index[0]
        sched = st[st.trip_id == rep_trip].t.values
        by_hour = (rep.t // 3600).value_counts().sort_index()
        network[(rid, int(did))] = {
            "route_id": rid, "direction_id": int(did), "family": family(rid),
            "mode": mode(rid, rtype[rid]),
            "shape_id": shape_id, "headsign": rep.trip_headsign.mode().iat[0],
            "x": dxs, "y": dys, "d": dd, "bearing": brg, "length": float(cum[-1]),
            "stops": [{"stop_id": s, "name": stop_name[s], "d": float(a), "offset": float(o),
                       "sched_t": int(t - sched[0]), "routes": stop_routes.get(s, [])}
                      for s, a, o, t in zip(pattern, along, off, sched)],
            "trips_per_hour": {int(h): int(n) for h, n in by_hour.items()},
            "sched_runtime_by_hour": {int(h): float(v) for h, v in
                                      (rep.groupby(rep.t // 3600).runtime.median()).items()},
        }
        print(f"{rid:>4} dir{did}: {cum[-1] / 1000:5.1f} km, {len(pattern)} stops, "
              f"{len(g)} trips, max stop offset {off.max():.0f} m")

    meta = routes.set_index("route_id")[["route_short_name", "route_long_name", "route_color"]].to_dict("index")
    with open(OUT / "network.pkl", "wb") as f:
        pickle.dump({"routes": network, "route_meta": meta}, f)
    print(f"{len(network)} route-directions -> {OUT / 'network.pkl'}")


if __name__ == "__main__":
    main()
