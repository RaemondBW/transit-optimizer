"""Tiny local-projection helpers (equirectangular around SF, fine at city scale)."""
import numpy as np

LAT0, LON0 = 37.76, -122.44
KX = 111_320 * np.cos(np.radians(LAT0))  # meters per degree lon
KY = 110_540                              # meters per degree lat


def to_xy(lon, lat):
    return (np.asarray(lon) - LON0) * KX, (np.asarray(lat) - LAT0) * KY


def to_lonlat(x, y):
    return np.asarray(x) / KX + LON0, np.asarray(y) / KY + LAT0


def bearing_deg(dx, dy):
    """Compass bearing (0 = north, clockwise) of a displacement."""
    return (np.degrees(np.arctan2(dx, dy)) + 360) % 360


def angle_diff(a, b):
    d = np.abs(np.asarray(a) - np.asarray(b)) % 360
    return np.minimum(d, 360 - d)


def project_to_polyline(px, py, lx, ly, cum):
    """Project points onto a polyline; returns (dist_along, perpendicular_dist).

    Brute force over segments, only used for small inputs (stops).
    """
    ax, ay = lx[:-1], ly[:-1]
    dx, dy = lx[1:] - ax, ly[1:] - ay
    seglen2 = np.maximum(dx * dx + dy * dy, 1e-9)
    t = ((px[:, None] - ax) * dx + (py[:, None] - ay) * dy) / seglen2
    t = np.clip(t, 0, 1)
    qx, qy = ax + t * dx, ay + t * dy
    d = np.hypot(px[:, None] - qx, py[:, None] - qy)
    i = d.argmin(axis=1)
    rows = np.arange(len(px))
    along = cum[i] + t[rows, i] * np.sqrt(seglen2[i])
    return along, d[rows, i]
