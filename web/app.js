/* Muni Time Lab — dashboard over web/data/*.json produced by pipeline/analyze.py */
"use strict";
const dark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;

const $ = (s) => document.querySelector(s);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtH = (h) => `${((h + 11) % 12) + 1}${h < 12 || h === 24 ? "am" : "pm"}`;
const fmtClock = (t) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`; };
const fmtMin = (m) => (m == null || !isFinite(m) ? "–" : `${m.toFixed(1)} min`);
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);

// In-trip activity states (codes from the pipeline) and vehicle-day extras.
const STATE = [
  { k: "moving", label: "Moving", v: "--s-moving" },
  { k: "crawl", label: "Crawling (<5 mph)", v: "--s-crawl" },
  { k: "dwell", label: "Stopped at a bus stop", v: "--s-dwell" },
  { k: "stopped", label: "Stopped elsewhere (signals, traffic)", v: "--s-stopped" },
  { k: "layover", label: "Layover between trips", v: "--s-layover" },
  { k: "deadhead", label: "Moving, no route matched (deadhead/detour)", v: "--s-deadhead" },
  { k: "parked", label: "Parked / yard", v: "--s-parked" },
  { k: "nodata", label: "No data", v: "--grid" },
];
// Stack order follows the categorical slot order (blue, orange, aqua, yellow).
const STACK = [0, 3, 2, 1];
const stColor = (i) => css(STATE[i].v);

// Sequential "slowness" ramp: one hue, light = fast, dark = slow.
const SPEED_BREAKS = [6, 8, 10, 13, 16, 20];
// On dark surfaces the ramp inverts in lightness so slow (the signal) stays the most prominent.
const SPEED_RAMP = dark()
  ? ["#ffd2b8", "#ffab7e", "#f5824f", "#d9612f", "#a9471f", "#763219", "#4a2415"]
  : ["#732a0b", "#a13d13", "#c9531f", "#e2733f", "#ee9a6c", "#f6c19f", "#fbe3d4"];
function speedColor(mph) {
  if (mph == null) return null;
  let i = SPEED_BREAKS.findIndex((b) => mph < b);
  if (i < 0) i = SPEED_BREAKS.length;
  return SPEED_RAMP[i];
}
function speedLegend(el) {
  const labels = ["<6", "6–8", "8–10", "10–13", "13–16", "16–20", "20+"];
  el.innerHTML = `<span class="ramp">slow ${SPEED_RAMP.map((c, i) => `<span class="sw" style="background:${c}" title="${labels[i]} mph"></span>`).join("")} fast</span> <span class="muted">mph: ${labels.join(" · ")}</span>`;
}

// ---------- tooltip ----------
const tip = $("#tip");
function showTip(ev, html) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
  if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
const hideTip = () => (tip.hidden = true);

// ---------- data ----------
const DATA = { routeCache: {}, rd: {} };
// Fetch JSON with a few retries: one dropped request (flaky link, a rebuild in
// progress) shouldn't break a whole tab.
async function getJSON(p, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(p);
      if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((res) => setTimeout(res, 300 * 2 ** i));
    }
  }
}
async function routeData(key) {
  if (!DATA.routeCache[key]) DATA.routeCache[key] = getJSON(`data/route/${key}.json`).then((d) => (DATA.rd[key] = d))
    .catch((e) => { delete DATA.routeCache[key]; throw e; });  // allow a later retry
  return DATA.routeCache[key];
}
const routeByKey = (k) => DATA.net.routes.find((r) => r.key === k);
let ROUTE_INDEX = null;
const routeByKeyFast = (k) => (ROUTE_INDEX ||= new Map(DATA.net.routes.map((r) => [r.key, r]))).get(k);
function routeLabel(r) { return `${r.route} ${titleCase(r.name)} → ${r.headsign}`; }
function titleCase(s) { return (s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()); }

// ---------- maps ----------
// MapLibre GL (WebGL): continuous, GPU-smooth zoom. A thin wrapper keeps the
// dashboard code simple: named sets of lines / circles, each one GeoJSON source,
// replaced wholesale with lines()/points(); tooltips via the shared #tip.
// Zoom numbers in this file use the familiar web-map scale (Leaflet/Google);
// MapLibre's is one lower, which the wrapper handles.
class GLMap {
  constructor(id, { center = [37.765, -122.44], zoom = 12.5 } = {}) {
    const style = dark() ? "Dark_Gray_Base" : "Light_Gray_Base";
    this.map = new maplibregl.Map({
      container: id, center: [center[1], center[0]], zoom: zoom - 1, maxZoom: 18,
      attributionControl: { compact: true },
      style: {
        version: 8,
        sources: { base: { type: "raster", tileSize: 256, maxzoom: 16,
          tiles: [`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${style}/MapServer/tile/{z}/{y}/{x}`],
          attribution: "Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors" } },
        layers: [{ id: "base", type: "raster", source: "base" }],
      },
      preserveDrawingBuffer: true,
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    this.map.dragRotate.disable();
    this.map.touchZoomRotate.disableRotation();
    this.loaded = false;
    this.ready = new Promise((r) => this.map.on("load", () => { this.loaded = true; r(); }));
    this.sets = {};
  }
  _ensure(name, kind, opts) {
    if (this.sets[name]) return this.sets[name];
    const m = this.map, id = `set-${name}`;
    m.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    if (kind === "line") {
      m.addLayer({ id, type: "line", source: id, layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"],
                 ...(opts.dash ? { "line-dasharray": opts.dash } : {}) } });
    } else {
      m.addLayer({ id, type: "circle", source: id,
        paint: { "circle-radius": ["get", "radius"], "circle-color": ["get", "fill"], "circle-opacity": ["get", "fillOpacity"],
                 "circle-stroke-color": ["get", "stroke"], "circle-stroke-width": ["get", "strokeWidth"],
                 "circle-stroke-opacity": 1 } });
    }
    const set = { id, handlers: [] , hover: opts.hover !== false };
    m.on("mousemove", id, (e) => {
      const f = e.features[0];
      m.getCanvas().style.cursor = set.handlers[f.properties.i] ? "pointer" : "";
      if (set.hover && f.properties.tip) showTip(e.originalEvent, f.properties.tip);
    });
    m.on("mouseleave", id, () => { m.getCanvas().style.cursor = ""; hideTip(); });
    m.on("click", id, (e) => { const h = set.handlers[e.features[0].properties.i]; if (h) h(); });
    this.sets[name] = set;
    return set;
  }
  // features: [{ coords: [[lat, lon], ...], color, width, opacity, tip, onClick }]
  lines(name, features, opts = {}) {
    if (!this.loaded) { this.ready.then(() => this.lines(name, features, opts)); return; }
    const set = this._ensure(name, "line", opts);
    set.handlers = features.map((f) => f.onClick);
    this.map.getSource(set.id).setData({ type: "FeatureCollection", features: features.map((f, i) => ({
      type: "Feature", geometry: { type: "LineString", coordinates: f.coords.map((p) => [p[1], p[0]]) },
      properties: { i, color: f.color, width: f.width ?? 3, opacity: f.opacity ?? 0.9, tip: f.tip || "" } })) });
  }
  // features: [{ lat, lon, radius, fill, fillOpacity, stroke, strokeWidth, tip, onClick }]
  points(name, features, opts = {}) {
    if (!this.loaded) { this.ready.then(() => this.points(name, features, opts)); return; }
    const set = this._ensure(name, "circle", opts);
    set.handlers = features.map((f) => f.onClick);
    this.map.getSource(set.id).setData({ type: "FeatureCollection", features: features.map((f, i) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [f.lon, f.lat] },
      properties: { i, radius: f.radius ?? 4, fill: f.fill ?? "#888", fillOpacity: f.fillOpacity ?? 1,
                    stroke: f.stroke ?? "#fff", strokeWidth: f.strokeWidth ?? 1, tip: f.tip || "" } })) });
  }
  clear(name) { if (this.sets[name]) this.map.getSource(this.sets[name].id).setData({ type: "FeatureCollection", features: [] }); }
  fit(latlngs, pad = 30) {
    const lats = latlngs.map((p) => p[0]), lons = latlngs.map((p) => p[1]);
    this.map.fitBounds([[d3.min(lons), d3.min(lats)], [d3.max(lons), d3.max(lats)]], { padding: pad, duration: 0 });
  }
  view(latlng, zoom) { this.map.easeTo({ center: [latlng[1], latlng[0]], zoom: zoom - 1, duration: 600 }); }
  zoom() { return this.map.getZoom() + 1; }
  resize() { this.map.resize(); }
}
const makeMap = (id, opts) => new GLMap(id, opts);

// Top-down vehicle icons, nose pointing up (north), one per mode x activity color.
// Drawn at 2x for crisp edges; the map rotates them to the direction of travel.
const VEHICLE_SHAPES = { bus: [12, 26], rail: [12, 40], streetcar: [12, 30], cable: [12, 20] };
function vehicleIcon(mode, fill, outline) {
  const [w, h] = VEHICLE_SHAPES[mode] || VEHICLE_SHAPES.bus, k = 2, pad = 3;
  const c = document.createElement("canvas");
  c.width = (w + pad * 2) * k; c.height = (h + pad * 2) * k;
  const g = c.getContext("2d");
  g.scale(k, k); g.translate(pad, pad);
  const rr = (x, y, ww, hh, r) => { g.beginPath(); g.roundRect(x, y, ww, hh, r); };
  rr(0, 0, w, h, [5, 5, 3, 3]); g.fillStyle = fill; g.fill();
  g.lineWidth = 1.6; g.strokeStyle = outline; g.stroke();
  g.fillStyle = "rgba(255,255,255,0.85)";               // windshield at the front
  rr(2, 2.5, w - 4, 4, 1.5); g.fill();
  g.fillStyle = "rgba(255,255,255,0.35)";               // side windows
  for (let y = 9; y < h - 4; y += 5) { rr(1.6, y, 1.8, 3, 0.8); g.fill(); rr(w - 3.4, y, 1.8, 3, 0.8); g.fill(); }
  if (mode === "rail") { g.fillStyle = outline; g.fillRect(0, h / 2 - 0.6, w, 1.2); } // two-car joint
  return { width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
}
// One half of an articulated light-rail car: "front" has the nose and windshield,
// "rear" the tail; each joins the other at a bellows so a train can bend in the middle.
const HALF = [12, 20];
function trainHalfIcon(part, fill, outline) {
  const [w, h] = HALF, k = 2, pad = 3;
  const c = document.createElement("canvas");
  c.width = (w + pad * 2) * k; c.height = (h + pad * 2) * k;
  const g = c.getContext("2d");
  g.scale(k, k); g.translate(pad, pad);
  const front = part === "front";
  g.beginPath(); g.roundRect(0, 0, w, h, front ? [5, 5, 1, 1] : [1, 1, 4, 4]);
  g.fillStyle = fill; g.fill(); g.lineWidth = 1.6; g.strokeStyle = outline; g.stroke();
  g.fillStyle = "rgba(255,255,255,0.85)";
  if (front) { g.beginPath(); g.roundRect(2, 2.5, w - 4, 4, 1.5); g.fill(); }
  g.fillStyle = "rgba(255,255,255,0.35)";
  for (let y = front ? 9 : 3; y < h - 3; y += 5) {
    g.beginPath(); g.roundRect(1.6, y, 1.8, 3, 0.8); g.fill();
    g.beginPath(); g.roundRect(w - 3.4, y, 1.8, 3, 0.8); g.fill();
  }
  g.fillStyle = outline;                                   // bellows at the joint
  if (front) g.fillRect(1, h - 1.6, w - 2, 1.6); else g.fillRect(1, 0, w - 2, 1.6);
  return { width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
}
GLMap.prototype.ensureVehicleIcons = function () {
  if (this._icons) return;
  this._icons = true;
  for (const mode of Object.keys(VEHICLE_SHAPES)) {
    STATE.slice(0, 6).forEach((_, code) => {
      const outline = mode === "bus" ? css("--surface") : css("--text");
      this.map.addImage(`veh-${mode}-${code}`, vehicleIcon(mode, stColor(code), outline), { pixelRatio: 2 });
    });
  }
  STATE.slice(0, 6).forEach((_, code) => {
    for (const part of ["front", "rear"])
      this.map.addImage(`veh-rail${part}-${code}`, trainHalfIcon(part, stColor(code), css("--text")), { pixelRatio: 2 });
  });
};
// Icon scale used by the symbol layer at a given MapLibre zoom (keep in sync with icon-size).
const iconScale = (z) => (z <= 10 ? 0.45 : z <= 13 ? 0.45 + ((z - 10) / 3) * 0.3 : z <= 16 ? 0.75 + ((z - 13) / 3) * 0.5 : 1.25);
// features: [{ lat, lon, icon, rot, tip, onClick }]
GLMap.prototype.symbols = function (name, features, opts = {}) {
  if (!this.loaded) { this.ready.then(() => this.symbols(name, features, opts)); return; }
  this.ensureVehicleIcons();
  let set = this.sets[name];
  if (!set) {
    const m = this.map, id = `set-${name}`;
    m.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    m.addLayer({ id, type: "symbol", source: id, layout: {
      "icon-image": ["get", "icon"], "icon-rotate": ["get", "rot"], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.45, 13, 0.75, 16, 1.25] } });
    set = { id, handlers: new Map(), hover: true };
    // Icons are small and move during playback: pick the nearest one within
    // HIT px of the cursor, matched by vehicle key (not list position).
    const HIT = 12;
    const nearest = (pt) => {
      const hits = m.queryRenderedFeatures([[pt.x - HIT, pt.y - HIT], [pt.x + HIT, pt.y + HIT]], { layers: [id] });
      let best = null, bd = Infinity;
      for (const f of hits) {
        const p = m.project(f.geometry.coordinates), d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < bd) { bd = d; best = f; }
      }
      return best;
    };
    m.on("mousemove", (e) => {
      const f = nearest(e.point);
      if (f) {
        m.getCanvas().style.cursor = "pointer"; set.hovering = true;
        if (set.onHover) { if (set.hoverKey !== f.properties.k) { set.hoverKey = f.properties.k; set.onHover(f.properties.k); } }
        else if (f.properties.tip) showTip(e.originalEvent, f.properties.tip);
      } else if (set.hovering) {
        set.hovering = false; m.getCanvas().style.cursor = ""; hideTip();
        if (set.onHover) { set.hoverKey = null; set.onHover(null); }
      }
    });
    m.on("mouseout", () => { if (set.onHover && set.hoverKey != null) { set.hoverKey = null; set.onHover(null); } });
    m.on("click", (e) => { const f = nearest(e.point); const h = f && set.handlers.get(f.properties.k); if (h) { hideTip(); h(); } });
    this.sets[name] = set;
  }
  set.handlers = new Map(features.filter((f) => f.onClick).map((f) => [f.key, f.onClick]));
  if (opts.onHover) set.onHover = opts.onHover;
  this.map.getSource(set.id).setData({ type: "FeatureCollection", features: features.map((f, i) => ({
    type: "Feature", geometry: { type: "Point", coordinates: [f.lon, f.lat] },
    properties: { i, k: f.key ?? i, icon: f.icon, rot: f.rot || 0, tip: f.tip || "" } })) });
};
const bearingOf = (a, b) => (Math.atan2((b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), b[0] - a[0]) * 180) / Math.PI;
// Split a route line into 100 m pieces so each can take its bin's color.
function binPieces(route, binSize) {
  const pieces = [];
  let cur = [], curBin = 0;
  for (const [lat, lon, d] of route.line) {
    const b = Math.floor(d / binSize);
    if (b !== curBin && cur.length) {
      cur.push([lat, lon]);
      pieces.push({ bin: curBin, pts: cur });
      cur = [];
      curBin = b;
    }
    cur.push([lat, lon]);
  }
  if (cur.length > 1) pieces.push({ bin: curBin, pts: cur });
  return pieces;
}
// Point on a route line at distance d (linear interpolation).
function pointAt(route, d) {
  const L_ = route.line;
  let lo = 0, hi = L_.length - 1;
  if (d <= L_[0][2]) return [L_[0][0], L_[0][1]];
  if (d >= L_[hi][2]) return [L_[hi][0], L_[hi][1]];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L_[m][2] <= d) lo = m; else hi = m; }
  const a = L_[lo], b = L_[hi], f = (d - a[2]) / (b[2] - a[2] || 1);
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
}

// ---------- continuous time bar (under a map) ----------
// Calls onTime(t, hourChanged) whenever the clock moves; hourly summaries redraw
// only when hourChanged is true, vehicles move every frame.
function makeTimebar(el, { t = 8 * 3600, onTime }) {
  el.innerHTML = `<button class="tb-play" title="Play / pause">▶</button>
    <span class="clock"></span>
    <input type="range" min="${4 * 3600}" max="${24 * 3600 - 60}" step="10" value="${t}" aria-label="Time of day">
    <select class="tb-speed" title="Playback speed"><option value="30">30×</option><option value="60" selected>60×</option><option value="180">180×</option><option value="600">600×</option></select>
    <span class="tb-note"></span>`;
  const range = el.querySelector("input"), btn = el.querySelector(".tb-play"), clock = el.querySelector(".clock");
  const note = el.querySelector(".tb-note"), speed = el.querySelector(".tb-speed");
  const tb = { t, hour: null, playing: false };
  const set = (nt) => {
    const lo = +range.min, hi = +range.max;
    tb.t = nt > hi ? lo + (nt - hi) : Math.max(lo, nt);
    range.value = tb.t;
    clock.textContent = fmtClock(tb.t);
    const h = Math.floor(tb.t / 3600), changed = h !== tb.hour;
    tb.hour = h;
    note.textContent = `Line colors and charts: average for ${fmtH(h)}–${fmtH(h + 1)}. Vehicles: GPS positions on ${DATA.net.sample_day}.`;
    onTime(tb.t, changed);
  };
  range.addEventListener("input", () => set(+range.value));
  let last = 0;
  const frame = (now) => {
    if (!tb.playing) return;
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    set(tb.t + dt * +speed.value);
    requestAnimationFrame(frame);
  };
  btn.onclick = () => {
    tb.playing = !tb.playing;
    btn.textContent = tb.playing ? "❚❚" : "▶";
    if (tb.playing) { last = performance.now(); requestAnimationFrame(frame); }
  };
  tb.set = set;
  set(t);
  return tb;
}

// ---------- every vehicle's GPS track, animated ----------
// Hourly files (data/positions/HH.json) load on demand; positions are linearly
// interpolated between pings (hidden across gaps > 3 min).
const POS = {};
function positionsFor(h) {
  if (h < 0 || h > 24) return Promise.resolve(null);
  if (!POS[h]) POS[h] = getJSON(`data/positions/${String(h).padStart(2, "0")}.json`).catch(() => null);
  return POS[h];
}
// Where a vehicle is at time t: on a trip it travels along its route's geometry
// between pings; otherwise a straight line. Returns null when there's no data.
function fleetPosition(pts, t, data) {
  const i = d3.bisector((p) => p[0]).right(pts, t) - 1;
  if (i < 0 || i >= pts.length - 1) return null;
  const a = pts[i], b = pts[i + 1];
  if (b[0] - a[0] > 180) return null;
  const f = (t - a[0]) / (b[0] - a[0]);
  const label = a[4] ? data.routes[a[4] - 1] : null;
  const shape = label ? routeByKeyFast(label) : null;
  const onShape = shape && a[4] === b[4] && a[5] >= 0 && b[5] >= a[5] - 30;
  const along = onShape ? a[5] + f * (b[5] - a[5]) : (a[5] >= 0 ? a[5] : null);
  const ll = onShape ? pointAt(shape, along) : [(a[1] + f * (b[1] - a[1])) / 1e5, (a[2] + f * (b[2] - a[2])) / 1e5];
  return { lat: ll[0], lon: ll[1], a, b, f, label, shape, along };
}
const VEHICLE_NAME = { bus: "Bus", rail: "Train", streetcar: "Streetcar", cable: "Cable car" };
const fmtDist = (m) => (m < 300 ? `${Math.round(m * 3.281 / 10) * 10} ft` : `${(m / 1609).toFixed(m < 1609 ? 2 : 1)} mi`);

function makeFleetLayer(gl, { filter = () => true, name = "fleet" } = {}) {
  let data = null, dataHour = null, enabled = true, lastT = null;
  const heading = new Map();          // last known heading per vehicle (kept while stopped)
  let sel = null, popup = null, ui = null;

  // ---- detail panel that rides along with the selected vehicle:
  // a mini speedometer and one plain-language status.
  const GAUGE_MAX = { bus: 40, rail: 50, streetcar: 40, cable: 15 };
  const R = 52, CX = 70, CY = 64;
  const arcPt = (v) => { const a = Math.PI * (1 - v); return [CX + R * Math.cos(a), CY - R * Math.sin(a)]; };
  const arcPath = (v) => { const [x, y] = arcPt(Math.max(v, 0.001)); return `M${CX - R},${CY} A${R},${R} 0 0 1 ${x.toFixed(1)},${y.toFixed(1)}`; };
  const buildPanel = () => {
    const el = document.createElement("div");
    el.className = "vpanel";
    el.innerHTML = `<div class="vp-head"><span class="badge vp-route"></span><b class="vp-name"></b></div>
      <div class="vp-dest"></div>
      <svg class="vp-gauge" viewBox="0 0 140 76" width="168" height="91" aria-hidden="true">
        <path class="vp-track" d="${arcPath(1)}" />
        <path class="vp-value" d="${arcPath(0)}" />
        <g class="vp-ticks"></g>
        <line class="vp-needle" x1="${CX}" y1="${CY}" x2="${CX - R + 8}" y2="${CY}" />
        <circle cx="${CX}" cy="${CY}" r="3.5" class="vp-hub" />
      </svg>
      <div class="vp-speed"><span class="vp-num">0</span><span class="vp-unit">mph</span></div>
      <div class="vp-status"><i class="dot"></i><span class="vp-what"></span></div>
      <div class="vp-where"></div>`;
    const q = (c) => el.querySelector(c);
    return { el, route: q(".vp-route"), name: q(".vp-name"), dest: q(".vp-dest"), value: q(".vp-value"), needle: q(".vp-needle"),
             ticks: q(".vp-ticks"), num: q(".vp-num"), dot: q(".vp-status .dot"), what: q(".vp-what"), where: q(".vp-where"),
             shown: 0, max: 40 };
  };
  const drawTicks = (max) => {
    const step = max <= 15 ? 5 : 10;
    ui.ticks.innerHTML = d3.range(0, max + 1, step).map((v) => {
      const [x1, y1] = arcPt(v / max); const a = Math.PI * (1 - v / max);
      const x0 = CX + (R - 7) * Math.cos(a), y0 = CY - (R - 7) * Math.sin(a);
      const xl = CX + (R + 9) * Math.cos(a), yl = CY - (R + 9) * Math.sin(a);
      return `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/><text x="${xl.toFixed(1)}" y="${(yl + 3).toFixed(1)}">${v}</text>`;
    }).join("");
  };
  // signals along each route, from the signal analysis (approach position in m)
  let sigIndex = null;
  const signalsFor = (key) => {
    if (!sigIndex) {
      sigIndex = new Map();
      for (const o of DATA.sig?.signals || []) for (const a of o.approaches) {
        if (!sigIndex.has(a.key)) sigIndex.set(a.key, []);
        sigIndex.get(a.key).push({ d: a.along, name: o.name });
      }
    }
    return sigIndex.get(key) || [];
  };
  // One status for the vehicle, consistent with the speed shown.
  const describe = (p, mph) => {
    const code = Math.min((p.f < 0.5 ? p.a : p.b)[3], 5);
    if (!p.shape || p.along == null) {
      if (code === 4) return { key: 4, what: "Laying over", where: "between trips" };
      return mph >= 5 ? { key: 5, what: "Moving", where: "not in service" } : { key: 4, what: "Parked / not in service", where: "" };
    }
    if (mph >= 5) return { key: 0, what: "Moving", where: "" };
    const stop = p.shape.stops.find((st) => p.along >= st.d - 40 && p.along <= st.d + 30);
    if (stop) return { key: 2, what: "At a bus stop", where: stop.name };
    const sig = signalsFor(p.shape.key).find((sg) => sg.d - p.along >= -12 && sg.d - p.along <= 75);
    if (sig) return { key: 3, what: "At a red light", where: sig.name };
    return { key: 1, what: mph > 0.5 ? "Crawling in traffic" : "Stuck in traffic", where: "" };
  };
  // Hovering a vehicle shows its panel; clicking pins it (stays open, can Follow).
  let pinned = null, hovered = null, hideTimer = null, side = null;
  // Escape deselects (on whichever map is visible)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !sel || !gl.map.getContainer().offsetParent) return;
    pinned = null; hovered = null; show(null);
  });
  const show = (target) => {
    const changed = !sel || !target || sel.vid !== target.vid;
    sel = target;
    if (!sel) {
      if (popup) { popup._quiet = true; popup.remove(); popup._quiet = false; }
      gl.points(`${name}-sel`, [], { hover: false });
      return;
    }
    if (!popup) {
      ui = buildPanel();
      popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: 22, maxWidth: "240px", className: "vpopup",
                                     anchor: "left" })
        .setDOMContent(ui.el);
      popup.on("close", () => { if (popup._quiet) return; pinned = null; show(hovered); });
    }
    popup.getElement()?.classList.toggle("pinned", !!pinned && sel.vid === pinned.vid);
    if (changed) {
      ui.max = GAUGE_MAX[sel.mode] || 40;
      drawTicks(ui.max);
      ui.shown = null;      // jump straight to this vehicle's speed
      side = null;          // pick a side for the new vehicle
    }
    if (lastT != null) fl.update(lastT);
  };
  const select = (vid, mode) => { pinned = { vid, mode }; show(pinned); };
  const hover = (vid) => {
    clearTimeout(hideTimer);
    if (vid != null) {
      const mode = data?.v[vid]?.[0] || "bus";
      hovered = { vid, mode };
      show(hovered);
    } else {
      hovered = null;
      hideTimer = setTimeout(() => show(pinned), 150);  // brief grace so moving between icons doesn't flicker
    }
  };
  const updatePanel = (vid, mode, p) => {
    ui.name.textContent = `${VEHICLE_NAME[mode] || "Vehicle"} ${vid}`;
    if (p?.shape) {
      ui.route.textContent = p.shape.route; ui.route.style.background = p.shape.color; ui.route.hidden = false;
      ui.dest.textContent = `to ${p.shape.headsign}`;
    } else { ui.route.hidden = true; ui.dest.textContent = ""; }
    if (!p) { ui.what.textContent = "No GPS right now"; ui.where.textContent = ""; ui.dot.style.background = css("--text-3"); return; }
    const target = Math.max(0, p.a[6] + p.f * (p.b[6] - p.a[6]));   // reported speed, blended between fixes
    ui.shown = ui.shown == null ? target : ui.shown + (target - ui.shown) * 0.25;   // ease the needle
    const mph = ui.shown, frac = Math.min(mph / ui.max, 1);
    const st = describe(p, mph);
    const color = stColor(st.key);
    ui.value.setAttribute("d", arcPath(frac));
    ui.value.style.stroke = color;
    const [nx, ny] = arcPt(frac);
    ui.needle.setAttribute("x2", (CX + (nx - CX) * 0.85).toFixed(1));
    ui.needle.setAttribute("y2", (CY + (ny - CY) * 0.85).toFixed(1));
    ui.num.textContent = Math.round(mph);
    ui.dot.style.background = color;
    ui.what.textContent = st.what;
    ui.where.textContent = st.where;
  };

  const fl = {
    async update(t) {
      lastT = t;
      const h = Math.floor(t / 3600);
      if (h !== dataHour) {
        dataHour = h;
        data = await positionsFor(h);
        positionsFor(h + 1); // prefetch
        if (h !== dataHour) return;
      }
      if (!enabled || !data) { gl.symbols(name, []); if (popup) popup.remove(); return; }
      const feats = [];
      let selPos = null;
      const z = gl.map.getZoom(), scale = iconScale(z);
      const mpp = (40075016.686 * Math.cos((gl.map.getCenter().lat * Math.PI) / 180)) / (512 * 2 ** z);
      for (const [vid, [mode, pts]] of Object.entries(data.v)) {
        if (!filter(mode, undefined)) continue;  // cheap pre-check before positioning
        const p = fleetPosition(pts, t, data);
        if (!p || !filter(mode, p.label)) continue;
        // heading: where the vehicle will be a few seconds later
        const ahead = fleetPosition(pts, t + 8, data);
        let rot = heading.get(vid) ?? 0;
        if (ahead && Math.hypot((ahead.lat - p.lat) * 111000, (ahead.lon - p.lon) * 88000) > 1.5) {
          rot = bearingOf([p.lat, p.lon], [ahead.lat, ahead.lon]);
          heading.set(vid, rot);
          if (ahead.along != null && p.along != null && ahead.label === p.label && Math.abs(ahead.along - p.along) > 1)
            heading.set(`${vid}:dir`, ahead.along > p.along ? 1 : -1);
        }
        const code = Math.min((p.f < 0.5 ? p.a : p.b)[3], 5);
        const route = p.shape ? `${p.shape.route} → ${p.shape.headsign}` : "not on a trip";
        const common = { key: vid, tip: `${VEHICLE_NAME[mode] || mode} ${vid} · ${route}<br>${STATE[code].label} · click for details`,
          onClick: () => select(vid, mode) };
        if (mode === "rail" && p.shape && p.along != null) {
          // Articulated train: each half sits on the track at its own spot and turns
          // with its own piece of curve, so the train bends at the middle joint.
          const halfM = HALF[1] * scale * mpp;
          const dir = heading.get(`${vid}:dir`) ?? 1;  // +1: travelling toward higher "along"
          for (const [part, off] of [["front", halfM / 2], ["rear", -halfM / 2]]) {
            const c = Math.min(Math.max(p.along + dir * off, 0), p.shape.length);
            const at = pointAt(p.shape, c);
            const r = bearingOf(pointAt(p.shape, c - dir * 4), pointAt(p.shape, c + dir * 4));
            feats.push({ ...common, lat: at[0], lon: at[1], rot: r, icon: `veh-rail${part}-${code}` });
          }
        } else {
          feats.push({ ...common, lat: p.lat, lon: p.lon, rot, icon: `veh-${VEHICLE_SHAPES[mode] ? mode : "bus"}-${code}` });
        }
        if (sel && sel.vid === vid) selPos = p;
      }
      gl.symbols(name, feats, { onHover: hover });
      // highlight ring around the selected vehicle (drawn above the icons, see-through)
      gl.points(`${name}-sel`, sel && selPos ? [{ lat: selPos.lat, lon: selPos.lon, radius: 17, fill: css("--accent"),
        fillOpacity: 0.18, stroke: css("--accent"), strokeWidth: 3 }] : [], { hover: false });
      if (sel) {
        updatePanel(sel.vid, sel.mode, selPos);
        if (selPos) {
          // Keep the panel on one side of the vehicle; only flip when it would run off the map.
          const px = gl.map.project([selPos.lon, selPos.lat]).x, W = gl.map.getCanvas().clientWidth, need = 240;
          const want = side == null ? (px > W / 2 ? "right" : "left")
            : side === "left" && px > W - need - 10 ? "right"
            : side === "right" && px < need + 10 ? "left" : side;
          if (want !== side) { side = want; popup.options.anchor = side; }
          popup.setLngLat([selPos.lon, selPos.lat]);
          if (!popup.isOpen()) popup.addTo(gl.map);
          popup.getElement()?.classList.toggle("pinned", !!pinned && sel.vid === pinned.vid);
        }
      }
    },
    setEnabled(v) { enabled = v; },
  };
  return fl;
}
function fleetLegend(el) {
  el.innerHTML = [0, 3, 2, 1, 4, 5].map((i) => `<span><i style="background:${stColor(i)}"></i>${STATE[i].label}</span>`).join("") +
    `<span class="muted">· longer icons are trains · click any vehicle for details</span>`;
}

// =====================================================================
// CITY TAB
// =====================================================================
const city = { layer: null };
async function initCity() {
  city.map = makeMap("city-map");
  // create layers bottom-to-top: speed lines, hotspot rings, vehicles
  city.map.lines("speed", []); city.map.points("hot", []); city.map.symbols("fleet", []);
  speedLegend($("#city-legend"));
  city.modes = new Set(Object.keys(MODES));
  $("#city-modes").innerHTML = Object.entries(MODES).map(([m, l]) => `<label><input type="checkbox" data-mode="${m}" checked> ${l.replace(/ \(.*\)/, "")}</label>`).join("");
  $("#city-modes").querySelectorAll("input").forEach((cb) => cb.addEventListener("change", () => {
    cb.checked ? city.modes.add(cb.dataset.mode) : city.modes.delete(cb.dataset.mode);
    drawCity(city.tb.hour);
    drawHotspots();
    city.fleet.update(city.tb.t);
  }));
  city.fleet = makeFleetLayer(city.map, { filter: (m) => city.modes.has(m) });
  $("#city-vehicles").addEventListener("change", (e) => { city.fleet.setEnabled(e.target.checked); city.fleet.update(city.tb.t); });
  fleetLegend($("#city-vlegend"));
  // Load every route's heat grid once (small) for the citywide speed map.
  city.heat = {};
  // one small bundle of every route's speed grid; fall back to per-route files, skipping any that fail
  try {
    city.heat = await getJSON("data/heat_all.json");
  } catch (e) {
    await Promise.allSettled(DATA.net.routes.map(async (r) => { city.heat[r.key] = (await routeData(r.key)).heat; }));
  }
  city.tb = makeTimebar($("#city-time"), {
    t: 17 * 3600,
    onTime: (t, hourChanged) => { if (hourChanged) drawCity(Math.min(Math.max(Math.floor(t / 3600), 5), 23)); city.fleet.update(t); },
  });
  drawHotspots();
  drawFleetHeadline();
}
function drawCity(hour) {
  const feats = [];
  for (const r of DATA.net.routes) {
    if (!city.modes.has(modeOf(r))) continue;
    const row = city.heat[r.key]?.[hour];
    if (!row) continue;
    // merge consecutive 100 m pieces that share a color into one line
    let run = null;
    const flush = () => {
      if (!run) return;
      feats.push({ coords: run.pts, color: run.color, width: run.weight, opacity: 0.9,
        tip: `<b>${r.route}</b> → ${r.headsign}<br>${d3.min(run.mph)}–${d3.max(run.mph)} mph at ${fmtH(hour)}` });
      run = null;
    };
    for (const p of binPieces(r, DATA.net.bin)) {
      const cell = row[p.bin];
      if (!cell) { flush(); continue; }
      const color = speedColor(cell[0]), weight = cell[0] < 8 ? 4 : 2.5;
      if (run && run.color === color && run.weight === weight) {
        run.pts.push(...p.pts.slice(1));
        run.mph.push(cell[0]);
      } else {
        flush();
        run = { color, weight, pts: p.pts.slice(), mph: [cell[0]] };
      }
    }
    flush();
  }
  city.map.lines("speed", feats);
}
function causeBar(c) {
  return `<div class="causebar"><span style="flex:${c.stopped};background:${stColor(3)}"></span><span style="flex:${c.dwell};background:${stColor(2)}"></span><span style="flex:${c.crawl};background:${stColor(1)}"></span></div>`;
}
function drawHotspots() {
  const ol = $("#hotspot-list");
  if (!city.hotLegend) {
    const lg = document.createElement("div");
    lg.className = "legend";
    lg.style.margin = "6px 0";
    lg.innerHTML = [3, 2, 1].map((s) => `<span><i style="background:${stColor(s)}"></i>${STATE[s].label}</span>`).join("");
    ol.before(lg);
    city.hotLegend = true;
  }
  // only the lost time of the modes that are switched on; re-rank by that
  const rows = DATA.hot.map((h) => {
    const bm = h.by_mode || { bus: h.bus_hours };
    const hours = sum(Object.entries(bm).filter(([m]) => city.modes.has(m)).map(([, v]) => v));
    const routes = h.routes.filter((r) => city.modes.has(modeOf(routeByKeyFast(`${r}_0`) || routeByKeyFast(`${r}_1`) || {})));
    return { h, hours, routes };
  }).filter((r) => r.hours >= 0.05).sort((a, b) => b.hours - a.hours).slice(0, 40);
  ol.innerHTML = "";
  if (!rows.length) ol.innerHTML = `<li class="muted">No hotspots for the selected modes.</li>`;
  const max = rows[0]?.hours || 1;
  const rings = [];
  rows.forEach(({ h, hours, routes }, i) => {
    const li = document.createElement("li");
    const dom = h.cause.stopped >= h.cause.dwell && h.cause.stopped >= h.cause.crawl ? "mostly signals/traffic stops"
      : h.cause.crawl >= h.cause.dwell ? "mostly crawling in traffic" : "mostly time at stops";
    li.innerHTML = `<span class="n">${h.name}</span> <span class="muted">(${h.heading}-bound)</span><br>
      <b>${hours.toFixed(1)}</b> vehicle-h/day · ${dom}<div class="r">Routes ${routes.join(", ")}</div>${causeBar(h.cause)}`;
    li.onclick = () => city.map.view([h.lat, h.lon], 16);
    ol.appendChild(li);
    rings.push({ lat: h.lat, lon: h.lon, radius: 4 + 10 * Math.sqrt(hours / max), fill: css("--text"), fillOpacity: 0,
      stroke: css("--text"), strokeWidth: 1.5, tip: `#${i + 1} ${h.name}: ${hours.toFixed(1)} vehicle-h/day lost` });
  });
  city.map.points("hot", rings);
}
function drawFleetHeadline() {
  const tot = Array(8).fill(0);
  DATA.veh.summary.forEach((b) => b.hours.forEach((h, i) => (tot[i] += h)));
  const inTrip = tot[0] + tot[1] + tot[2] + tot[3];
  const pct = (x) => `${Math.round((100 * x) / inTrip)}%`;
  $("#fleet-headline").innerHTML = [
    ["Moving", pct(tot[0]), "of in-service time"],
    ["At bus stops", pct(tot[2]), "doors open / waiting"],
    ["Stuck elsewhere", pct(tot[3] + tot[1]), "signals, traffic, crawling"],
  ].map(([l, v, d]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
}

// =====================================================================
// ROUTE TAB
// =====================================================================
const rt = { key: null, data: null, play: { t: 17 * 3600 } };
const MODES = { rail: "Muni Metro (light rail)", bus: "Buses", streetcar: "F streetcar", cable: "Cable cars" };
const modeOf = (r) => r.mode || "bus";
// Two dropdowns: route (grouped by mode) and direction (by destination).
// onChange receives the route-direction key, e.g. "38R_0".
function makeRoutePicker(routeSel, dirSel, onChange, initialKey) {
  const byRoute = d3.group(DATA.net.routes, (r) => r.route);
  for (const [mode, label] of Object.entries(MODES)) {
    const ids = [...byRoute.keys()].filter((id) => modeOf(byRoute.get(id)[0]) === mode);
    if (!ids.length) continue;
    const grp = document.createElement("optgroup");
    grp.label = label;
    for (const id of ids) {
      const r = byRoute.get(id)[0];
      grp.insertAdjacentHTML("beforeend", `<option value="${id}">${id} ${titleCase(r.name)}</option>`);
    }
    routeSel.appendChild(grp);
  }
  const fillDirs = (keepDir) => {
    const dirs = byRoute.get(routeSel.value).slice().sort((x, y) => x.dir - y.dir);
    dirSel.innerHTML = dirs.map((r) => `<option value="${r.key}">to ${r.headsign}</option>`).join("");
    const same = dirs.find((r) => r.dir === keepDir);
    if (same) dirSel.value = same.key;
  };
  const init = routeByKey(initialKey) || DATA.net.routes[0];
  routeSel.value = init.route;
  fillDirs(init.dir);
  routeSel.addEventListener("change", () => { fillDirs(routeByKey(dirSel.value)?.dir ?? 0); onChange(dirSel.value); });
  dirSel.addEventListener("change", () => onChange(dirSel.value));
  return dirSel.value;
}
function initRoute() {
  rt.map = makeMap("route-map");
  ["speed"].forEach((n) => rt.map.lines(n, []));
  ["stops", "signals"].forEach((n) => rt.map.points(n, []));
  rt.map.symbols("fleet", []);
  rt.fleet = makeFleetLayer(rt.map, { filter: (mode, label) => label === undefined || label === rt.key });
  speedLegend($("#route-legend"));
  const startKey = makeRoutePicker($("#route-select"), $("#route-dir"), (k) => loadRoute(k), "38R_0");
  rt.tb = makeTimebar($("#route-time"), {
    t: 17 * 3600,
    onTime: (t, hourChanged) => {
      rt.play.t = t;
      if (!rt.data) return;
      if (hourChanged) { drawRouteMap(); drawHeatmap(); }
      drawPlayback();
    },
  });
  loadRoute(startKey);
}
async function loadRoute(key) {
  rt.key = key; rt.route = routeByKey(key); rt.data = await routeData(key);
  $("#marey-day").textContent = new Date(rt.data.sample_day + "T12:00").toDateString();
  drawRouteTiles(); drawRouteMap(); drawHeatmap(); drawBudgetBins(); drawBudgetHour(); drawRuntime(); drawMarey();
  rt.map.ready.then(() => rt.map.fit(rt.route.line));
  drawPlayback();
}
function drawRouteTiles() {
  const r = rt.route, d = rt.data;
  const km = r.length / 1000;
  const allH = Object.values(d.runtime);
  const peak = d.runtime["17"] || d.runtime["8"] || allH[0];
  const early = d.runtime["6"] || d.runtime["7"];
  // day-long budget from bins
  const tot = [0, 0, 0, 0];
  d.budget_bin.forEach((b) => b && b.forEach((x, i) => (tot[i] += x)));
  const T = sum(tot);
  const avgSpeed = peak ? (km / (peak[0] / 60)) * 0.621 : null;
  const spacing = r.length / (r.stops.length - 1);
  $("#route-tiles").innerHTML = [
    ["Length", `${(km * 0.621).toFixed(1)} mi`, `${r.stops.length} stops · every ${Math.round(spacing * 3.28)} ft`],
    ["5pm trip", peak ? fmtMin(peak[0]) : "–", peak ? `bad day (90th pct): ${fmtMin(peak[1])}` : ""],
    ["Avg speed at 5pm", avgSpeed ? `${avgSpeed.toFixed(1)} mph` : "–", early ? `early morning trip: ${fmtMin(early[0])}` : ""],
    ["Moving", `${Math.round((100 * tot[0]) / T)}%`, "share of a typical trip"],
    ["At stops", `${Math.round((100 * tot[2]) / T)}%`, `${(tot[2] / 60).toFixed(1)} min per trip`],
    ["Signals & traffic", `${Math.round((100 * (tot[3] + tot[1])) / T)}%`, `${((tot[3] + tot[1]) / 60).toFixed(1)} min per trip`],
  ].map(([l, v, dd]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${dd}</div></div>`).join("");
}
function drawRouteMap() {
  const hour = Math.min(Math.max(rt.tb.hour, 5), 23);
  const row = rt.data.heat[hour] || [];
  rt.map.lines("speed", binPieces(rt.route, DATA.net.bin).map((p) => {
    const c = row[p.bin];
    return { coords: p.pts, color: c ? speedColor(c[0]) : css("--text-3"), width: 6, opacity: c ? 0.95 : 0.3,
      tip: c ? `${c[0]} mph · ${c[2]} s lost per trip in this 100 m (${fmtH(hour)})` : "too few trips" };
  }));
  rt.map.points("signals", drawRouteSignals().map(({ o, a }) => ({
    lat: o.lat, lon: o.lon, radius: 3 + Math.min(a.wait_s, 60) / 6, fill: waitColor(a.wait_s), stroke: css("--text"), strokeWidth: 1.5,
    tip: `🚦 <b>${o.name}</b><br>holds this route ${a.wait_s.toFixed(0)} s per trip on average` })));
  rt.map.points("stops", rt.data.stops.map((s) => ({
    lat: s.lat, lon: s.lon, radius: 3, fill: css("--surface"), stroke: css("--text"), strokeWidth: 1,
    tip: `${s.name}${s.stopped != null ? `<br>${s.stopped} s stopped here per trip, on average` : ""}` })));
}
function stopAxis(g, x, stops, height) {
  // label a readable subset of stops along the distance axis
  const minGap = 70;
  let last = -1e9;
  stops.forEach((s) => {
    const px = x(s.d);
    g.append("line").attr("x1", px).attr("x2", px).attr("y1", 0).attr("y2", 4).attr("stroke", css("--text-3"));
    if (px - last > minGap) {
      g.append("text").attr("transform", `translate(${px},8) rotate(40)`).attr("text-anchor", "start")
        .text(s.name.replace(/ (St|Ave|Blvd)\b/g, "").slice(0, 22));
      last = px;
    }
  });
}
function drawHeatmap() {
  const d = rt.data, el = $("#heatmap");
  el.innerHTML = "";
  const hours = d3.range(5, 24);
  const nb = d.budget_bin.length;
  const W = Math.max(el.clientWidth - 16, nb * 7 + 70), cellH = 16;
  const m = { l: 48, r: 10, t: 6, b: 110 };
  const w = W - m.l - m.r, h = hours.length * cellH;
  const x = d3.scaleLinear().domain([0, nb * d.bin]).range([0, w]);
  const svg = d3.select(el).append("svg").attr("width", W).attr("height", h + m.t + m.b);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  const cw = w / nb;
  const sel = Math.min(Math.max(rt.tb.hour, 5), 23);
  hours.forEach((hr, j) => {
    const row = d.heat[hr] || [];
    for (let b = 0; b < nb; b++) {
      const c = row[b];
      g.append("rect").attr("x", b * cw + 0.5).attr("y", j * cellH + 0.5)
        .attr("width", Math.max(cw - 1, 0.5)).attr("height", cellH - 1).attr("rx", 1.5)
        .attr("fill", c ? speedColor(c[0]) : css("--grid"))
        .on("mousemove", (ev) => {
          const near = d.stops.reduce((a, s) => (Math.abs(s.d - (b + 0.5) * d.bin) < Math.abs(a.d - (b + 0.5) * d.bin) ? s : a));
          showTip(ev, c ? `<b>${c[0]} mph</b> near ${near.name}<br>${fmtH(hr)} · ${c[1]} trips<br>${c[2]} s lost per trip vs free-flow` : `near ${near.name}: too few trips`);
        })
        .on("mouseleave", hideTip);
    }
    g.append("text").attr("x", -6).attr("y", j * cellH + cellH / 2 + 4).attr("text-anchor", "end")
      .attr("font-weight", hr === sel ? 700 : 400).text(fmtH(hr));
  });
  g.append("rect").attr("x", -1).attr("y", hours.indexOf(sel) * cellH).attr("width", w + 2).attr("height", cellH)
    .attr("fill", "none").attr("stroke", css("--text")).attr("stroke-width", 1.2).attr("rx", 2);
  const ax = g.append("g").attr("class", "axis").attr("transform", `translate(0,${h + 2})`);
  stopAxis(ax, x, d.stops, h);
}
function drawBudgetBins() {
  const d = rt.data, el = $("#budget-bin");
  el.innerHTML = "";
  const nb = d.budget_bin.length;
  const W = Math.max(el.clientWidth - 16, nb * 7 + 70), H = 190;
  const m = { l: 48, r: 10, t: 24, b: 110 };
  const w = W - m.l - m.r, h = H - m.t;
  const vals = d.budget_bin.map((b) => (b ? sum(b) : 0));
  const y = d3.scaleLinear().domain([0, d3.quantile(vals.filter((v) => v > 0).sort(d3.ascending), 0.98) || 1]).nice().range([h, 0]).clamp(true);
  const x = d3.scaleLinear().domain([0, nb * d.bin]).range([0, w]);
  const svg = d3.select(el).append("svg").attr("width", W).attr("height", H + m.b);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  g.append("g").attr("class", "axis gridline").call(d3.axisLeft(y).ticks(4).tickSize(-w).tickFormat((v) => `${v}s`)).call((a) => a.select(".domain").remove());
  const cw = w / nb;
  d.budget_bin.forEach((b, i) => {
    if (!b) return;
    let acc = 0;
    STACK.forEach((s) => {
      const v = b[s];
      if (v <= 0) return;
      const y0 = y(acc), y1 = y(acc + v);
      g.append("rect").attr("x", i * cw + 0.5).attr("width", Math.max(cw - 1, 0.5)).attr("y", y1).attr("height", Math.max(y0 - y1 - 1, 0))
        .attr("fill", stColor(s));
      acc += v;
    });
    g.append("rect").attr("x", i * cw).attr("width", cw).attr("y", 0).attr("height", h).attr("fill", "transparent")
      .on("mousemove", (ev) => {
        const near = d.stops.reduce((a, s) => (Math.abs(s.d - (i + 0.5) * d.bin) < Math.abs(a.d - (i + 0.5) * d.bin) ? s : a));
        showTip(ev, `near <b>${near.name}</b><br>${STACK.map((s) => `<i style="display:inline-block;width:9px;height:9px;background:${stColor(s)};border-radius:2px"></i> ${STATE[s].label}: <b>${b[s].toFixed(1)} s</b>`).join("<br>")}`);
      }).on("mouseleave", hideTip);
  });
  const ax = g.append("g").attr("class", "axis").attr("transform", `translate(0,${h + 2})`);
  stopAxis(ax, x, d.stops, h);
  const lg = svg.append("g").attr("transform", `translate(${m.l},12)`);
  let lx = 0;
  STACK.forEach((s) => {
    lg.append("rect").attr("x", lx).attr("y", -9).attr("width", 10).attr("height", 10).attr("rx", 2).attr("fill", stColor(s));
    const t = lg.append("text").attr("x", lx + 14).attr("y", 0).text(STATE[s].label);
    lx += 14 + t.node().getComputedTextLength() + 16;
  });
}
function drawBudgetHour() {
  const d = rt.data, el = $("#budget-hour");
  el.innerHTML = "";
  const hours = d3.range(5, 24).filter((h) => d.budget_hour[h]);
  const W = el.clientWidth - 16, H = 200, m = { l: 34, r: 6, t: 8, b: 22 };
  const w = W - m.l - m.r, h = H - m.t - m.b;
  const x = d3.scaleBand().domain(hours).range([0, w]).padding(0.12);
  const y = d3.scaleLinear().domain([0, 1]).range([h, 0]);
  const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4, "%").tickSize(-w)).call((a) => a.select(".domain").remove()).selectAll("line").attr("stroke", css("--grid"));
  hours.forEach((hr) => {
    const b = d.budget_hour[hr];
    let acc = 0;
    STACK.forEach((s) => {
      g.append("rect").attr("x", x(hr)).attr("width", x.bandwidth()).attr("y", y(acc + b[s])).attr("height", Math.max(y(acc) - y(acc + b[s]) - 1.5, 0)).attr("fill", stColor(s));
      acc += b[s];
    });
    g.append("rect").attr("x", x(hr)).attr("width", x.bandwidth()).attr("y", 0).attr("height", h).attr("fill", "transparent")
      .on("mousemove", (ev) => showTip(ev, `<b>${fmtH(hr)}</b><br>${STACK.map((s) => `${STATE[s].label}: <b>${Math.round(b[s] * 100)}%</b>`).join("<br>")}`))
      .on("mouseleave", hideTip);
  });
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).tickValues(hours.filter((h) => h % 3 === 0)).tickFormat(fmtH));
}
function drawRuntime() {
  const d = rt.data, el = $("#runtime-chart");
  el.innerHTML = "";
  const hours = d3.range(5, 24);
  const W = el.clientWidth - 16, H = 200, m = { l: 40, r: 70, t: 10, b: 22 };
  const w = W - m.l - m.r, h = H - m.t - m.b;
  const pts = hours.filter((hr) => d.runtime[hr]).map((hr) => ({ hr, med: d.runtime[hr][0], p90: d.runtime[hr][1], n: d.runtime[hr][2] }));
  const sch = hours.filter((hr) => d.sched_runtime[hr]).map((hr) => ({ hr, v: d.sched_runtime[hr] }));
  if (!pts.length) { el.textContent = "Not enough complete trips."; return; }
  const x = d3.scaleLinear().domain([5, 23]).range([0, w]);
  const y = d3.scaleLinear().domain([0, d3.max([...pts.map((p) => p.p90), ...sch.map((s) => s.v)]) * 1.08]).nice().range([h, 0]);
  const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickSize(-w).tickFormat((v) => `${v}m`)).call((a) => a.select(".domain").remove()).selectAll("line").attr("stroke", css("--grid"));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(6).tickFormat(fmtH));
  const c1 = css("--s-moving"), c2 = css("--text-3");
  g.append("path").datum(pts).attr("fill", c1).attr("opacity", 0.15)
    .attr("d", d3.area().x((p) => x(p.hr)).y0((p) => y(p.med)).y1((p) => y(p.p90)));
  g.append("path").datum(pts).attr("fill", "none").attr("stroke", c1).attr("stroke-width", 2).attr("d", d3.line().x((p) => x(p.hr)).y((p) => y(p.med)));
  g.append("path").datum(sch).attr("fill", "none").attr("stroke", c2).attr("stroke-width", 1.5).attr("stroke-dasharray", "4 3").attr("d", d3.line().x((p) => x(p.hr)).y((p) => y(p.v)));
  const lp = pts[pts.length - 1], ls = sch[sch.length - 1];
  g.append("text").attr("x", x(lp.hr) + 4).attr("y", y(lp.med) + 4).text("median");
  if (ls) g.append("text").attr("x", x(ls.hr) + 4).attr("y", y(ls.v) + 12).text("schedule");
  g.append("text").attr("x", x(lp.hr) + 4).attr("y", y(lp.p90)).text("90th pct");
  const cross = g.append("line").attr("y1", 0).attr("y2", h).attr("stroke", css("--text-3")).attr("opacity", 0);
  g.append("rect").attr("width", w).attr("height", h).attr("fill", "transparent")
    .on("mousemove", (ev) => {
      const hr = Math.round(x.invert(d3.pointer(ev)[0]));
      const p = pts.find((q) => q.hr === hr); const s = sch.find((q) => q.hr === hr);
      cross.attr("x1", x(hr)).attr("x2", x(hr)).attr("opacity", 1);
      showTip(ev, `<b>${fmtH(hr)} departures</b><br>median ${fmtMin(p?.med)}<br>90th pct ${fmtMin(p?.p90)}<br>schedule ${fmtMin(s?.v)}<br><span class="muted">${p ? p.n : 0} trips observed</span>`);
    })
    .on("mouseleave", () => { cross.attr("opacity", 0); hideTip(); });
}
function drawMarey() {
  const d = rt.data, el = $("#marey");
  el.innerHTML = "";
  const W = el.clientWidth - 16, H = 520, m = { l: 58, r: 12, t: 10, b: 110 };
  const w = W - m.l - m.r, h = H - m.t;
  const x = d3.scaleLinear().domain([0, rt.route.length]).range([0, w]);
  // 3-hour window that follows the playback clock
  const w0 = 6 * 3600 + Math.floor(Math.max(rt.play.t - 6 * 3600, 0) / 10800) * 10800;
  rt.win = [w0, w0 + 10800];
  const y = d3.scaleLinear().domain(rt.win).range([0, h]);
  rt.mareyScales = { x, y, m };
  const svg = d3.select(el).append("svg").attr("width", W).attr("height", H + m.b);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  svg.append("clipPath").attr("id", "marey-clip").append("rect").attr("width", w).attr("height", h);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickValues(d3.range(rt.win[0], rt.win[1] + 1, 900)).tickSize(-w).tickFormat((t) => (t % 3600 ? "" : fmtClock(t))))
    .call((a) => a.select(".domain").remove()).selectAll("line").attr("stroke", css("--grid"));
  d.stops.forEach((s) => g.append("line").attr("x1", x(s.d)).attr("x2", x(s.d)).attr("y1", 0).attr("y2", h).attr("stroke", css("--grid")).attr("stroke-dasharray", "2 3"));
  // Each trip: segments colored by the state at the segment start, batched into one path per state.
  const paths = ["", "", "", ""];
  for (const tr of d.marey) {
    const p = tr.p;
    if (p[p.length - 1][0] < rt.win[0] || p[0][0] > rt.win[1]) continue;
    for (let i = 1; i < p.length; i++) {
      if (p[i][0] - p[i - 1][0] > 300) continue;
      paths[p[i - 1][2]] += `M${x(p[i - 1][1]).toFixed(1)},${y(p[i - 1][0]).toFixed(1)}L${x(p[i][1]).toFixed(1)},${y(p[i][0]).toFixed(1)}`;
    }
  }
  const lines = g.append("g").attr("clip-path", "url(#marey-clip)");
  STACK.forEach((st) => lines.append("path").attr("d", paths[st]).attr("stroke", stColor(st)).attr("stroke-width", 1.3).attr("fill", "none").attr("stroke-linecap", "round"));
  rt.clockLine = g.append("line").attr("x1", 0).attr("x2", w).attr("stroke", css("--text")).attr("stroke-width", 1);
  const ax = g.append("g").attr("class", "axis").attr("transform", `translate(0,${h + 2})`);
  stopAxis(ax, x, d.stops, h);
  g.append("rect").attr("width", w).attr("height", h).attr("fill", "transparent")
    .on("mousemove", (ev) => {
      const [px, py] = d3.pointer(ev);
      const t = y.invert(py), dd = x.invert(px);
      const near = d.stops.reduce((a, s) => (Math.abs(s.d - dd) < Math.abs(a.d - dd) ? s : a));
      showTip(ev, `${fmtClock(t)} · near ${near.name}<br><span class="muted">click to jump playback here</span>`);
    })
    .on("mouseleave", hideTip)
    .on("click", (ev) => rt.tb.set(Math.round(y.invert(d3.pointer(ev)[1]))));
  const lg = d3.select(el).insert("div", ":first-child").attr("class", "legend").style("margin", "0 0 6px 40px");
  lg.html([0, 1, 2, 3].map((s) => `<span><i style="background:${stColor(s)}"></i>${STATE[s].label}</span>`).join(""));
}
function drawPlayback() {
  const t = rt.play.t;
  if (rt.win && (t < rt.win[0] || t >= rt.win[1])) drawMarey();
  if (rt.clockLine && rt.mareyScales) rt.clockLine.attr("y1", rt.mareyScales.y(t)).attr("y2", rt.mareyScales.y(t));
  rt.fleet.update(t);  // vehicles on this route, clickable for details
}

// =====================================================================
// BUSES TAB
// =====================================================================
function initBuses() {
  const V = DATA.veh;
  $("#bus-day").textContent = new Date(V.day + "T12:00").toDateString();
  const routes = [...new Set(V.summary.flatMap((b) => b.routes))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  routes.forEach((r) => { const o = document.createElement("option"); o.value = r; o.textContent = r; $("#bus-route").appendChild(o); });
  $("#bus-route").onchange = drawBuses;
  $("#bus-mode").onchange = drawBuses;
  $("#bus-sort").onchange = drawBuses;
  drawFleetBar();
  drawBuses();
}
function drawFleetBar() {
  const el = $("#fleet-bar");
  const tot = Array(8).fill(0);
  DATA.veh.summary.forEach((b) => b.hours.forEach((h, i) => (tot[i] += h)));
  const order = [0, 3, 2, 1, 4, 5];
  const T = sum(order.map((i) => tot[i]));
  el.innerHTML = `<div style="font-size:13px;color:var(--text-2);margin-bottom:6px">Whole fleet, one weekday: <b style="color:var(--text)">${Math.round(T).toLocaleString()} vehicle-hours</b> in the realtime feed (buses, trains, streetcars, cable cars)</div>
    <div style="display:flex;height:26px;gap:2px;border-radius:5px;overflow:hidden">${order.map((i) => `<div title="${STATE[i].label}: ${Math.round(tot[i])} h" style="flex:${tot[i]};background:${stColor(i)}"></div>`).join("")}</div>
    <div class="legend" style="margin-top:8px">${order.map((i) => `<span><i style="background:${stColor(i)}"></i>${STATE[i].label} <b>${Math.round((100 * tot[i]) / T)}%</b></span>`).join("")}</div>`;
}
function drawBuses() {
  const el = $("#bus-timelines");
  el.innerHTML = "";
  const V = DATA.veh;
  const f = $("#bus-route").value;
  const md = $("#bus-mode").value;
  let list = V.summary.filter((b) => (!f || b.routes.includes(f)) && (!md || (b.mode || "bus") === md));
  const svc = (b) => b.hours[0] + b.hours[1] + b.hours[2] + b.hours[3];
  const stuck = (b) => (b.hours[1] + b.hours[2] + b.hours[3]) / (svc(b) || 1);
  const sorters = { stuck: (a, b) => stuck(b) - stuck(a), service: (a, b) => svc(b) - svc(a), layover: (a, b) => b.hours[4] - a.hours[4], id: (a, b) => a.v - b.v };
  list.sort(sorters[$("#bus-sort").value]);
  list = list.slice(0, 250);
  const rowH = 14, m = { l: 150, r: 10, t: 22, b: 4 };
  const W = Math.max(el.clientWidth - 16, 700), w = W - m.l - m.r;
  const x = d3.scaleLinear().domain([4 * 3600, 24.5 * 3600]).range([0, w]);
  const H = list.length * rowH + m.t + m.b;
  const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,-4)`).call(d3.axisTop(x).tickValues(d3.range(4, 25, 2).map((h) => h * 3600)).tickFormat((t) => fmtH(t / 3600)));
  // One path per state keeps thousands of segments cheap in SVG.
  const paths = Array(8).fill("");
  list.forEach((b, j) => {
    for (const [t0, t1, c] of V.segments[b.v]) {
      if (c === 7) continue;
      const x0 = x(t0), wd = Math.max(x(t1) - x0, 0.6);
      paths[c] += `M${x0.toFixed(1)},${j * rowH + 2}h${wd.toFixed(1)}v${rowH - 4}h${(-wd).toFixed(1)}Z`;
    }
  });
  svg.append("clipPath").attr("id", "bus-clip").append("rect").attr("width", w).attr("height", list.length * rowH);
  const bars = g.append("g").attr("clip-path", "url(#bus-clip)");
  paths.forEach((p, c) => p && bars.append("path").attr("d", p).attr("fill", stColor(c)));
  list.forEach((b, j) => {
    g.append("text").attr("x", -6).attr("y", j * rowH + rowH / 2 + 4).attr("text-anchor", "end")
      .text(`#${b.v} · ${b.routes.slice(0, 2).join("/")} · ${Math.round(stuck(b) * 100)}%`);
  });
  g.append("rect").attr("width", w).attr("height", list.length * rowH).attr("fill", "transparent")
    .on("mousemove", (ev) => {
      const [px, py] = d3.pointer(ev);
      const b = list[Math.floor(py / rowH)];
      if (!b) return;
      const t = x.invert(px);
      const seg = V.segments[b.v].find((s) => s[0] <= t && t < s[1]);
      const hrs = b.hours;
      showTip(ev, `<b>${MODES[b.mode || "bus"].replace(/s? \(.*|s$/, "")} ${b.v}</b> ${fmtClock(t)}${seg ? `: ${STATE[seg[2]].label}${seg[3] ? ` on ${seg[3].replace("_", " dir ")}` : ""}` : ""}
        <br>In service ${svc(b).toFixed(1)} h: moving ${hrs[0].toFixed(1)} h, at stops ${hrs[2].toFixed(1)} h, signals/traffic ${(hrs[3] + hrs[1]).toFixed(1)} h
        <br>Layover ${hrs[4].toFixed(1)} h · unmatched driving ${hrs[5].toFixed(1)} h`);
    })
    .on("mouseleave", hideTip);
  if (V.summary.filter((b) => (!f || b.routes.includes(f)) && (!md || (b.mode || "bus") === md)).length > 250) {
    d3.select(el).append("div").attr("class", "muted").style("padding", "6px").text("Showing the first 250 buses for this sort.");
  }
}

// =====================================================================
// STOP CONSOLIDATION TAB
// =====================================================================
const sc = { removed: new Set() };
function initStops() {
  sc.map = makeMap("stop-map");
  sc.map.lines("route", []); sc.map.points("stops", []);
  const startKey = makeRoutePicker($("#stop-route"), $("#stop-dir"), (k) => loadStops(k), "38_0");
  const tg = $("#stop-target");
  const lab = () => ($("#stop-target-label").textContent = `${tg.value} m (${Math.round(tg.value * 3.28)} ft)`);
  tg.addEventListener("input", lab); lab();
  $("#stop-auto").onclick = autoConsolidate;
  $("#stop-reset").onclick = () => { sc.removed.clear(); renderStops(); };
  ["#p-accel", "#p-door", "#p-dwell", "#p-walk", "#p-protect", "#p-rapid"].forEach((s) => $(s).addEventListener("input", renderStops));
  const cal = DATA.calib.filter((c) => c.trips_per_day.local >= 20 && c.trips_per_day.rapid >= 20)
    .sort((x, y) => y.sec_per_skipped_stop - x.sec_per_skipped_stop);
  if (cal.length) {
    const line = (c) => {
      const diff = c.local_min - c.rapid_min;
      return `${c.pair} → ${c.headsign}: ${diff > 0.5 ? `Rapid <b>${diff.toFixed(1)} min faster</b>` : diff < -0.5 ? `local actually <b>${(-diff).toFixed(1)} min faster</b>` : `<b>no real difference</b>`} over ${c.km} km, skipping ${c.local_stops - c.rapid_stops} stops${diff > 0.5 ? ` ≈ <b>${Math.round(c.sec_per_skipped_stop)} s per stop</b>` : ""}`;
    };
    $("#calib").innerHTML = `<b>Reality check from Muni's own Rapid routes</b> (same streets, 7am–7pm):<br>` + cal.map(line).join("<br>") +
      `<br><span class="muted">Where Rapids pull ahead, the gain includes boarding time at the skipped stops; when a stop is removed for real those riders board at a neighbor, so expect less per stop. Where Rapids don't pull ahead (one day of data, so noisy), the corridor's delay is mostly signals and traffic, not stops, so skipping stops alone doesn't help.</span>`;
  }
  loadStops(startKey);
}
function isProtected(r, s, i) {
  if (i === 0 || i === r.stops.length - 1) return true;
  return ($("#p-rapid").checked && sc.info[i].rapid) || ($("#p-protect").checked && sc.info[i].transfers.length > 0);
}
// For each stop: is it a Rapid stop, and which crossing routes can you transfer to?
// A route counts as crossing (not parallel) if it has a stop within 120 m of this
// stop but none near either neighboring stop.
function stopInfo(r) {
  const near = 120, kx = 88000, ky = 111000;
  const dist = (a, b) => Math.hypot((a.lon - b.lon) * kx, (a.lat - b.lat) * ky);
  const others = DATA.net.routes.filter((o) => o.family !== r.family);
  const famsNear = (s) => new Set(others.filter((o) => o.stops.some((q) => dist(q, s) < near)).map((o) => o.route));
  const rapid = routeByKey(`${r.family}R_${r.dir}`);
  const rapidIds = new Set(rapid && rapid.route !== r.route ? rapid.stops.map((q) => q.id) : []);
  const sets = r.stops.map(famsNear);
  return r.stops.map((s, i) => {
    const par = new Set([...(sets[i - 1] || []), ...(sets[i + 1] || [])]);
    return { rapid: rapidIds.has(s.id), transfers: [...sets[i]].filter((x) => !par.has(x)) };
  });
}
async function loadStops(key) {
  sc.key = key; sc.route = routeByKey(key); sc.data = await routeData(key);
  sc.info = stopInfo(sc.route);
  sc.removed.clear();
  sc.map.ready.then(() => sc.map.fit(sc.route.line));
  renderStops();
}
// Share of trips that halt at a stop. GPS pings every ~30 s miss short halts, so
// instead of counting detected halts we divide the (unbiased) measured stopped
// seconds per trip by the typical dwell of a halt.
const haltP = (s) => (s.stopped == null ? 1 : Math.min(1, s.stopped / +$("#p-dwell").value));
// Estimate per-trip time saved by removing a set of stops.
function stopModel(r, removed) {
  const lost = +$("#p-accel").value + +$("#p-door").value;
  const st = r.stops;
  const p = st.map(haltP);
  const newP = p.slice();
  // Riders at a removed stop split between nearest kept neighbors; each neighbor
  // becomes more likely to need a stop: 1-(1-p_n)(1-p_s/2).
  const kept = st.map((_, i) => !removed.has(i));
  st.forEach((s, i) => {
    if (kept[i]) return;
    let u = i - 1; while (u >= 0 && !kept[u]) u--;
    let w = i + 1; while (w < st.length && !kept[w]) w++;
    [u, w].forEach((n) => { if (n >= 0 && n < st.length) newP[n] = 1 - (1 - newP[n]) * (1 - p[i] / 2); });
  });
  const before = sum(p.map((x, i) => (i === 0 || i === st.length - 1 ? 0 : x)));
  const after = sum(newP.map((x, i) => (!kept[i] || i === 0 || i === st.length - 1 ? 0 : x)));
  const saved = (before - after) * lost; // seconds per trip
  // walking impact: for each removed stop, distance to nearest kept stop
  const walks = [];
  st.forEach((s, i) => {
    if (kept[i]) return;
    let best = Infinity;
    st.forEach((q, j) => { if (kept[j]) best = Math.min(best, Math.abs(q.d - s.d)); });
    walks.push({ i, d: best, w: p[i] });
  });
  return { saved, before, after, walks, newP, kept };
}
function autoConsolidate() {
  const r = sc.route, target = +$("#stop-target").value;
  const st = r.stops;
  sc.removed.clear();
  // Greedy: repeatedly remove the least-used removable stop whose removal keeps
  // the gap between its kept neighbors within the target spacing.
  for (;;) {
    let best = null;
    const kept = st.map((_, i) => !sc.removed.has(i));
    for (let i = 1; i < st.length - 1; i++) {
      if (!kept[i] || isProtected(r, st[i], i)) continue;
      let u = i - 1; while (!kept[u]) u--;
      let w = i + 1; while (!kept[w]) w++;
      if (st[w].d - st[u].d > target) continue;
      const score = haltP(st[i]);
      if (!best || score < best.score) best = { i, score };
    }
    if (!best) break;
    sc.removed.add(best.i);
  }
  renderStops();
}
function renderStops() {
  const r = sc.route, st = r.stops;
  const res = stopModel(r, sc.removed);
  const perDay = r.trips_obs;
  const rtAll = Object.values(sc.data.runtime);
  const peakRt = (sc.data.runtime["17"] || rtAll[Math.floor(rtAll.length / 2)] || [NaN])[0];
  const busHours = (res.saved * perDay) / 3600;
  const walkSpeed = +$("#p-walk").value;
  const avgWalk = res.walks.length ? sum(res.walks.map((w) => w.d)) / res.walks.length : 0;
  const keptN = st.length - sc.removed.size;
  const spacingBefore = r.length / (st.length - 1), spacingAfter = r.length / (keptN - 1);
  const newHeadwayPct = peakRt ? (res.saved / 60) / peakRt : 0;
  $("#stop-tiles").innerHTML = [
    ["Stops", `${st.length} → ${keptN}`, `spacing ${Math.round(spacingBefore)} → ${Math.round(spacingAfter)} m`],
    ["Time saved per trip", `${(res.saved / 60).toFixed(1)} min`, peakRt ? `${Math.round(newHeadwayPct * 100)}% of a ${Math.round(peakRt)}-min 5pm trip` : ""],
    ["Bus-hours freed per weekday", busHours.toFixed(1), `this direction, ${Math.round(perDay)} trips/day`],
    ["Same buses, more service", `+${Math.round((1 / (1 - newHeadwayPct) - 1) * 100)}%`, "frequency if savings reinvested"],
    ["Extra walk (removed stops)", res.walks.length ? `${Math.round(avgWalk)} m` : "–", res.walks.length ? `≈ ${(avgWalk / walkSpeed / 60).toFixed(1)} min for those riders` : "only riders at removed stops"],
  ].map(([l, v, d]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");

  const list = $("#stop-list");
  list.innerHTML = "";
  st.forEach((s, i) => {
    const locked = isProtected(r, s, i);
    const removed = sc.removed.has(i);
    const prevKept = (() => { let u = i - 1; while (u >= 0 && sc.removed.has(u)) u--; return u; })();
    const gap = i > 0 && prevKept >= 0 ? Math.round(s.d - st[prevKept].d) : "";
    const row = document.createElement("div");
    row.className = `stoprow${removed ? " removed" : ""}${locked ? " locked" : ""}`;
    const why = (i === 0 || i === st.length - 1) ? "terminal" : [sc.info[i].rapid ? "Rapid" : "", sc.info[i].transfers.length ? "↔ " + sc.info[i].transfers.join(", ") : ""].filter(Boolean).join(" · ");
    row.innerHTML = `<span>${locked ? "🔒" : removed ? "✕" : "●"}</span><span>${s.name}${why ? ` <span class="muted">${why}</span>` : ""}</span>
      <span class="bar" title="buses halt here on ~${Math.round(haltP(s) * 100)}% of trips (${s.stopped ?? "–"} s stopped per trip)"><span style="width:${haltP(s) * 100}%"></span></span>
      <span class="gap">${gap !== "" ? gap + " m" : ""}</span>`;
    if (!locked) row.onclick = () => { removed ? sc.removed.delete(i) : sc.removed.add(i); renderStops(); };
    list.appendChild(row);
  });

  sc.map.lines("route", [{ coords: r.line, color: r.color, width: 4, opacity: 0.6 }]);
  sc.map.points("stops", st.map((s, i) => {
    const removed = sc.removed.has(i), locked = isProtected(r, s, i);
    const why = i === 0 || i === st.length - 1 ? "terminal"
      : [sc.info[i].rapid ? "Rapid stop" : "", sc.info[i].transfers.length ? "transfer to " + sc.info[i].transfers.join(", ") : ""].filter(Boolean).join(" · ");
    return {
      lat: s.lat, lon: s.lon, radius: removed ? 5 : 4 + 5 * haltP(s), strokeWidth: 2,
      stroke: removed ? css("--bad") : css("--text"),
      fill: removed ? css("--surface") : locked ? css("--text") : css("--s-dwell"),
      tip: `${s.name}<br>halts on ~${Math.round(haltP(s) * 100)}% of trips · ${s.stopped ?? "–"} s stopped/trip${locked ? `<br>🔒 ${why}` : "<br><span class='muted'>click to remove/restore</span>"}`,
      onClick: locked ? null : () => { removed ? sc.removed.delete(i) : sc.removed.add(i); renderStops(); },
    };
  }));
}

// =====================================================================
// MARKET ST TAB
// =====================================================================
const mk = { on: new Set(), station: {} };
function initMarket() {
  mk.map = makeMap("mk-map", { center: [37.781, -122.415], zoom: 14 });
  mk.map.lines("kept", []); mk.map.lines("cut", [], { dash: [2, 2] }); mk.map.points("stations", []);
  const M = DATA.market;
  // One card per route (pairing both directions).
  mk.routes = d3.groups(M.routes.filter((r) => ["7", "9R", "5R", "F"].includes(r.route) || r.on_market_m > 1500), (r) => r.route)
    .map(([route, dirs]) => ({ route, inb: dirs.find((d) => d.inbound), outb: dirs.find((d) => !d.inbound) }))
    .filter((r) => r.inb && r.outb);
  // The F is itself the Market St line, so cutting it mostly deletes it: off by default.
  mk.routes.forEach((r) => { if (r.route !== "F") mk.on.add(r.route); mk.station[r.route] = r.inb.stations[0] === "Castro" ? "Church" : r.inb.stations[0]; });
  ["#mk-hour", "#mk-walk", "#mk-penalty", "#mk-turn"].forEach((s) => $(s).addEventListener("input", renderMarket));
  Promise.all(mk.routes.flatMap((r) => [routeData(r.inb.key), routeData(r.outb.key)])).then(renderMarket);
}
// Bus running time over [d0, d1] of a route at an hour, from the speed grid.
function segMinutes(rd, d0, d1, hour) {
  const row = rd.heat[hour] || rd.heat[hour + 1] || rd.heat[hour - 1] || [];
  const bin = rd.bin;
  let t = 0;
  for (let b = Math.floor(d0 / bin); b * bin < d1; b++) {
    const lo = Math.max(d0, b * bin), hi = Math.min(d1, (b + 1) * bin);
    const c = row[b];
    const mph = c ? c[0] : 7;
    t += (hi - lo) / (mph / 2.23694);
  }
  return t / 60;
}
function renderMarket() {
  const M = DATA.market, hour = +$("#mk-hour").value;
  $("#mk-hour-label").textContent = fmtH(hour);
  const walk = +$("#mk-walk").value, pen = +$("#mk-penalty").value, turn = +$("#mk-turn").value;
  const box = $("#mk-routes");
  box.innerHTML = "";
  const kept = [], cut = [];
  let totHours = 0, totBuses = 0;
  const rows = [];
  for (const r of mk.routes) {
    const S = mk.station[r.route];
    const rin = DATA.rd[r.inb.key], rout = DATA.rd[r.outb.key];
    const inData = routeByKey(r.inb.key), outData = routeByKey(r.outb.key);
    // portion removed: inbound from the transfer station to the end; outbound from start to the station
    const dIn = r.inb.station_along[S], dOut = r.outb.station_along[S];
    let res = null;
    if (rin && rout && dIn != null && dOut != null) {
      const cutIn = segMinutes(rin, dIn, r.inb.length, hour);
      const cutOut = segMinutes(rout, 0, dOut, hour);
      const savedPerRound = Math.max(cutIn + cutOut - turn, 0);
      const tph = (r.inb.trips_per_hour[hour] || 0);
      const head = tph ? 60 / tph : null;
      const cyc = (inData.sched_runtime[hour] || r.inb.sched_runtime[hour] || 0) + (outData.sched_runtime[hour] || r.outb.sched_runtime[hour] || 0);
      const cycle = cyc * 1.12; // + recovery/layover
      const buses = head ? cycle / head : 0;
      const newHead = head ? head * (cycle - savedPerRound) / cycle : null;
      // daily bus-hours: sum over hours of trips * saved
      let daily = 0;
      for (let h = 5; h < 24; h++) {
        const n = r.inb.trips_per_hour[h] || 0;
        if (!n) continue;
        const sIn = segMinutes(rin, dIn, r.inb.length, h), sOut = segMinutes(rout, 0, dOut, h);
        daily += n * Math.max(sIn + sOut - turn, 0) / 60;
      }
      res = { cutIn, cutOut, savedPerRound, head, newHead, buses, daily, freed: head ? savedPerRound / head : 0 };
      if (mk.on.has(r.route)) { totHours += daily; totBuses += res.freed; }
      // rider rows: from S to each downstream station (inbound)
      const ds = r.inb.stations.slice(r.inb.stations.indexOf(S) + 1);
      for (const X of ds) {
        const bus = r.inb.bus_pair_min[`${S}|${X}`]?.[hour];
        const sched = M.subway.in?.[`${S}|${X}`]?.[hour];          // [trains/h, min]
        const obs = M.subway_obs?.in?.[`${S}|${X}`]?.[hour];        // [median, p90, n, trains/h]
        if (!bus || (!sched && !obs)) continue;
        // measured ride time when we have it; frequency from the schedule (a single day undercounts
        // trains that run through only part of the pair)
        const ride = obs ? obs[0] : sched[1];
        const trainsPerHour = sched ? sched[0] : obs[3];
        const wait = 30 / trainsPerHour;
        const via = walk + wait + ride + pen;
        const waitGain = res.newHead != null ? (res.head - res.newHead) / 2 : 0;
        rows.push({ route: r.route, S, X, bus: bus[0], bus90: bus[1], sub: ride, subSched: sched?.[1], measured: !!obs, wait, tph: trainsPerHour, via, gain: waitGain, net: via - waitGain - bus[0] });
      }
    }
    // map: kept vs removed portions
    const onOff = mk.on.has(r.route);
    const pts = inData.line.map((p) => [p[0], p[1], p[2]]);
    const tip = `<b>${r.route}</b> ${titleCase(inData.name)}`;
    kept.push({ coords: pts.filter((p) => p[2] <= (dIn ?? 1e9)), color: inData.color, width: 4, tip });
    (onOff ? cut : kept).push({ coords: pts.filter((p) => p[2] >= (dIn ?? 1e9)), color: onOff ? css("--bad") : inData.color,
      width: onOff ? 3 : 4, tip: onOff ? `${tip}: removed segment (riders transfer at ${S})` : tip });

    const card = document.createElement("div");
    card.className = "mkroute";
    const opts = r.inb.stations.filter((s) => s !== "Embarcadero").map((s) => `<option ${s === S ? "selected" : ""}>${s}</option>`).join("");
    card.innerHTML = `<header><label><input type="checkbox" ${onOff ? "checked" : ""}> <span class="badge" style="background:${inData.color}">${r.route}</span> ${titleCase(inData.name)}</label>
      <label class="muted">end at <select>${opts}</select></label></header>
      <div class="stats">${res ? `Removes <b>${fmtMin(res.cutIn + res.cutOut)}</b> of Market St driving per round trip at ${fmtH(hour)} (${(r.inb.on_market_m / 1609).toFixed(1)} mi each way).
        ${res.head ? `Headway <b>${res.head.toFixed(1)} → ${res.newHead.toFixed(1)} min</b> with the same buses.` : "Not scheduled this hour."}
        Frees <b>${res.daily.toFixed(0)} bus-hours</b> per weekday.` : "No data."}</div>`;
    card.querySelector("input").onchange = (e) => { e.target.checked ? mk.on.add(r.route) : mk.on.delete(r.route); renderMarket(); };
    card.querySelector("select").onchange = (e) => { mk.station[r.route] = e.target.value; renderMarket(); };
    box.appendChild(card);
  }
  mk.map.lines("kept", kept);
  mk.map.lines("cut", cut, { dash: [2, 2] });
  mk.map.points("stations", Object.entries(M.station_ll).map(([n, ll]) => ({
    lat: ll[0], lon: ll[1], radius: 6, fill: css("--surface"), stroke: css("--text"), strokeWidth: 2, tip: `${n} (Muni Metro)` })));
  const active = rows.filter((x) => mk.on.has(x.route));
  const winners = active.filter((x) => x.net < 0).length;
  $("#mk-tiles").innerHTML = [
    ["Bus-hours freed per weekday", totHours.toFixed(0), "for the routes checked"],
    ["≈ buses freed at this hour", totBuses.toFixed(1), "to redeploy on the rest of each route"],
    ["Downtown trips faster by subway", `${winners} / ${active.length}`, "origin–destination pairs, incl. frequency gain"],
  ].map(([l, v, d]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
  $("#mk-table").innerHTML = active.length ? `<table><thead><tr><th>Route</th><th>From → to</th><th>Bus (median)</th><th>Bus (bad day)</th><th>Walk</th><th>Train wait</th><th>Train ride (measured)</th><th>Penalty</th><th>Better wait upstream</th><th>Net change</th></tr></thead><tbody>
    ${active.map((x) => `<tr><td>${x.route}</td><td>${x.S} → ${x.X}</td><td>${fmtMin(x.bus)}</td><td>${fmtMin(x.bus90)}</td><td>${walk}</td><td>${x.wait.toFixed(1)} <span class="muted">(${x.tph}/h)</span></td><td>${x.sub.toFixed(1)}${x.measured && x.subSched != null ? ` <span class="muted">(sched ${x.subSched.toFixed(1)})</span>` : ""}</td><td>${pen}</td><td>−${x.gain.toFixed(1)}</td>
      <td class="${x.net < 0 ? "pos" : "neg"}"><b>${x.net > 0 ? "+" : ""}${x.net.toFixed(1)} min</b></td></tr>`).join("")}
    </tbody></table>` : `<p class="muted">Select a route to see rider impacts.</p>`;
  $("#mk-notes").innerHTML = `<b>How to read this.</b> Bus times are measured from GPS traces on Market St at ${fmtH(hour)} (${dataLabel()}); subway ride times are <b>measured</b> from Muni Metro GPS at the same hour (the schedule is shown alongside and is often optimistic); train frequency comes from the weekday schedule.
    "Better wait upstream" is the shorter average wait for everyone boarding the rest of the route once freed buses run more often (half the headway improvement).
    The F streetcar is off by default: it <i>is</i> the Market St surface line, so truncating it mostly removes it rather than shortening it.
    Not modeled: subway crowding and capacity (the added riders must fit on trains), accessibility of stairs/elevators, Market St riders who get off <i>between</i> stations, and loss of a one-seat ride for riders with limited mobility.`;
}

// =====================================================================
// TRAFFIC SIGNALS TAB
// =====================================================================
const sg = {};
// wait per vehicle pass: one hue, darker/brighter = longer (same ramp as slowness)
const WAIT_BREAKS = [5, 10, 15, 20, 30, 45];
function waitColor(s) {
  let i = WAIT_BREAKS.findIndex((b) => s < b);
  if (i < 0) i = WAIT_BREAKS.length;
  return SPEED_RAMP[SPEED_RAMP.length - 1 - i];
}
// hours held / average wait for a signal under the current mode + hour filters
function sigStats(o, mode, hour) {
  const apps = o.approaches.filter((a) => !mode || a.mode === mode);
  const passes = sum(apps.map((a) => a.passes));
  const allHours = mode ? (o.by_mode[mode] || 0) : o.veh_hours;
  let hours = allHours;
  if (hour !== "") hours = o.hours[+hour] * (o.veh_hours ? allHours / o.veh_hours : 0);
  const wait = passes ? sum(apps.map((a) => a.wait_s * a.passes)) / passes : 0;
  return { hours, wait, passes, apps };
}
function initSignals() {
  if (!DATA.sig) { $("#tab-signals").innerHTML = "<p>No signal data. Run the pipeline with data/signals/traffic_signals.json.</p>"; return; }
  sg.map = makeMap("sig-map");
  sg.map.points("signals", []);
  for (let h = 5; h < 24; h++) $("#sig-hour").insertAdjacentHTML("beforeend", `<option value="${h}">${fmtH(h)}–${fmtH(h + 1)}</option>`);
  ["#sig-mode", "#sig-hour", "#sig-rank"].forEach((id) => $(id).addEventListener("change", renderSignals));
  const labels = ["<5", "5–10", "10–15", "15–20", "20–30", "30–45", "45+"];
  $("#sig-legend").innerHTML = `circle size = total time held · color = avg seconds per vehicle: ` +
    labels.map((l, i) => `<span><i style="background:${SPEED_RAMP[SPEED_RAMP.length - 1 - i]}"></i>${l}</span>`).join("");
  renderSignals();
}
function renderSignals() {
  const mode = $("#sig-mode").value, hour = $("#sig-hour").value, rank = $("#sig-rank").value;
  const rows = DATA.sig.signals.map((o) => ({ o, ...sigStats(o, mode, hour) }))
    .filter((r) => r.hours > 0.005 && (rank !== "wait" || r.passes >= (hour === "" ? 40 : 3)));
  rows.sort(rank === "wait" ? (a, b) => b.wait - a.wait : (a, b) => b.hours - a.hours);
  const tot = sum(rows.map((r) => r.hours));
  const when = hour === "" ? "per weekday" : `${fmtH(+hour)}–${fmtH(+hour + 1)}`;
  $("#sig-tiles").innerHTML = [
    ["Time held at red lights", `${tot.toFixed(0)} h`, `vehicle-hours ${when}${mode ? ", " + $("#sig-mode").selectedOptions[0].text.toLowerCase() : ""}`],
    ["Signals that hold transit", rows.length.toLocaleString(), `of ${DATA.sig.n_signals.toLocaleString()} signals in SF`],
    ["Worst 20 signals", `${Math.round((100 * sum(rows.slice(0, 20).map((r) => r.hours))) / (tot || 1))}%`, "share of all signal delay"],
  ].map(([l, v, d]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");

  const max = d3.max(rows, (r) => r.hours) || 1;
  // small first so big circles draw on top
  sg.map.points("signals", [...rows].reverse().map((r) => ({
    lat: r.o.lat, lon: r.o.lon, radius: 2.5 + 16 * Math.sqrt(r.hours / max), strokeWidth: 1, stroke: css("--surface"),
    fill: waitColor(r.wait), fillOpacity: 0.9, onClick: () => showSignal(r.o),
    tip: `<b>${r.o.name}</b><br>${r.hours.toFixed(2)} vehicle-h held ${when}<br>avg ${r.wait.toFixed(0)} s per vehicle · ${Math.round(r.passes)} passes/day` })));
  const ol = $("#sig-list");
  ol.innerHTML = "";
  rows.slice(0, 60).forEach((r) => {
    const li = document.createElement("li");
    const routes = [...new Set(r.apps.map((a) => a.route))];
    li.innerHTML = `<span class="n">${r.o.name}</span><br><b>${r.hours.toFixed(1)}</b> vehicle-h ${when} · avg <b>${r.wait.toFixed(0)} s</b> per vehicle
      <div class="r">${routes.slice(0, 10).join(", ")}${r.o.near_side_hours > 0.3 ? ` · +${r.o.near_side_hours.toFixed(1)} h at a near-side stop` : ""}</div>`;
    li.onclick = () => { sg.map.view([r.o.lat, r.o.lon], 17); showSignal(r.o); };
    ol.appendChild(li);
  });
  if (!sg.shown && rows[0]) showSignal(rows[0].o);
}
function showSignal(o) {
  sg.shown = o;
  const el = $("#sig-detail");
  el.innerHTML = `<div class="detail"><h4>${o.name}</h4>
    <div class="muted">${o.veh_hours.toFixed(1)} vehicle-hours held per weekday · ${Math.round(o.passes)} bus/train passes · avg ${o.avg_wait_s.toFixed(0)} s each${o.near_side_hours > 0.05 ? ` · plus ${o.near_side_hours.toFixed(1)} h at a near-side stop` : ""}</div>
    <div id="sig-hours"></div>
    <table><thead><tr><th>Route</th><th>Heading to</th><th>Held / pass</th><th>Passes/day</th><th>Hours/day</th></tr></thead><tbody>
    ${o.approaches.map((a) => `<tr><td>${a.route}</td><td>${a.headsign}</td><td>${a.wait_s.toFixed(0)} s</td><td>${Math.round(a.passes)}</td><td>${a.hours.toFixed(2)}</td></tr>`).join("")}
    </tbody></table></div>`;
  // hourly profile
  const box = $("#sig-hours"), W = box.clientWidth || 380, H = 90, m = { l: 30, r: 4, t: 8, b: 18 };
  const hrs = d3.range(5, 24);
  const x = d3.scaleBand().domain(hrs).range([m.l, W - m.r]).padding(0.15);
  const y = d3.scaleLinear().domain([0, d3.max(hrs, (h) => o.hours[h]) || 0.01]).nice().range([H - m.b, m.t]);
  const svg = d3.select(box).append("svg").attr("width", W).attr("height", H);
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(3).tickFormat((v) => `${Math.round(v * 60)}m`)).call((a) => a.select(".domain").remove());
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(hrs.filter((h) => h % 3 === 0)).tickFormat(fmtH));
  svg.selectAll("rect.b").data(hrs).join("rect").attr("x", (h) => x(h)).attr("width", x.bandwidth())
    .attr("y", (h) => y(o.hours[h])).attr("height", (h) => y(0) - y(o.hours[h])).attr("rx", 2).attr("fill", css("--s-stopped"))
    .on("mousemove", (ev, h) => showTip(ev, `${fmtH(h)}: ${Math.round(o.hours[h] * 60)} vehicle-minutes held`)).on("mouseleave", hideTip);
}
// Signals along one route (route explorer)
function drawRouteSignals() {
  const el = $("#route-signals");
  if (!DATA.sig) { el.innerHTML = ""; return []; }
  const list = [];
  for (const o of DATA.sig.signals) {
    const a = o.approaches.find((x) => x.key === rt.key);
    if (a) list.push({ o, a });
  }
  list.sort((p, q) => q.a.wait_s - p.a.wait_s);
  el.innerHTML = list.length ? list.slice(0, 40).map(({ o, a }) =>
    `<div class="sigrow" data-lat="${o.lat}" data-lon="${o.lon}"><span>${o.name}</span><span>${a.wait_s.toFixed(0)} s</span><span>${Math.round(a.passes)}/day</span></div>`).join("")
    : `<div class="muted" style="padding:8px">No signals on this route's surface sections.</div>`;
  el.querySelectorAll(".sigrow").forEach((row) => (row.onclick = () => rt.map.view([+row.dataset.lat, +row.dataset.lon], 17)));
  return list;
}

// =====================================================================
// ABOUT
// =====================================================================
function dataLabel() {
  const src = DATA.net.source || {};
  if (src.realtime) {
    // composite day: the smaller slice is the previous evening, the larger the daytime
    const parts = src.composite_of.map((c) => {
      const [a, b] = Object.entries(c).sort((x, y) => x[1] - y[1]).map((e) => e[0]);
      return b ? `${a} evening + ${b} daytime` : a;
    });
    return `Muni's realtime GPS feed, ${parts.join("; ")} ${src.year}`;
  }
  return `${DATA.net.days.length} weekdays of archived GPS, ${DATA.net.days[0].slice(0, 7)}`;
}
function initAbout() {
  const N = DATA.net, src = N.source || {};
  const dataPara = src.realtime
    ? `<p><b>Data.</b> Muni's GTFS-realtime vehicle positions (via 511.org), as archived by Cal-ITP, Caltrans' statewide transit data program, in its public bucket
      <code>calitp-publish-data-analysis/ucd_transit_priority_2026</code>. Each ping carries the bus's route, direction and trip, plus GPS speed and heading.
      That export is cut on UTC days, so the day shown is a <b>composite weekday</b>: ${src.composite_of.map((c) => Object.entries(c).map(([d, n]) => `${d} (${n.toLocaleString()} pings)`).join(" and ")).join("; ")}, in local time.
      Routes, stops and frequencies come from Muni's current GTFS schedule.</p>`
    : `<p><b>Data.</b> SFMTA's archived GPS feed ("Transit Vehicle Location History", DataSF), ${N.days.length} weekdays (${N.days.join(", ")}). That archive has no route IDs, so the pipeline infers each bus's route by matching its path to GTFS shapes;
      Rapid vs local on shared streets is decided by whether the bus halted at local-only stops.</p>`;
  $("#tab-about").innerHTML = `
  <h2>How this works</h2>
  ${dataPara}
  <p><b>Speeds</b> are distance over time between consecutive GPS points, spread across the 100 m cells each interval covers, then averaged per hour (total distance ÷ total time).
  <b>Activity</b> at each GPS ping uses the reported speed: stopped within ~40 m of a stop counts as "at a stop", stopped elsewhere as "signals/traffic", under 5 mph as crawling. Each ping represents the time around it.
  <b>Lost time</b> is measured against each cell's own fast-hour speed (90th percentile across hours). Route ends (300 m) and long stationary holds (≥5 min, layovers) are excluded.</p>
  <p><b>Trains.</b> Muni Metro (J K L M N T), the F streetcar and cable cars are included. Multi-car trains report every car under one trip; only the lead car counts toward speeds and runtimes.
  Tunnel sections (Market St/Twin Peaks subway, Central Subway) are detected from station names and portals, kept apart from the street above in the hotspot ranking, and never credited to traffic signals.
  The cable-car feed often reports a trip while a car is parked at a turntable or the barn, so only about half of their reported trips are usable.</p>
  <p><b>Traffic signals.</b> SFMTA's signal inventory (DataSF <code>ybh5-27n2</code>, 1,290 signals plus Caltrans/pending). For each route passing within 20 m of a signal, time in the 75 m approach spent stopped away from a bus stop or crawling under 5 mph counts as held by that signal
  (with signals close together, it goes to the nearest one ahead). Time at a stop inside that approach (a near-side stop) is reported separately, because boarding and the red light overlap. Signal timing data isn't public, so this measures waiting, not the cause (a queue can come from the next intersection).</p>
  <p><b>Stop consolidation model.</b> Removing a stop saves the stop penalty (accel/decel + door cycle) times the chance buses stopped there, minus extra stops at the neighbors that absorb its riders. Boarding time moves to the neighbors, so it is not counted as savings.
  Muni's Rapid routes provide a real-world upper bound.</p>
  <p><b>Caveats.</b> ${src.realtime ? "A single composite day: hourly cells rest on a handful of trips, so treat individual cells as indicative and look for patterns across neighbouring cells and hours. June is outside the school year." : "2021 service was still recovering from COVID (lighter traffic, some routes suspended)."}
  GPS pings arrive every ~20–60 s, which blurs short events.</p>
  <p><b>Rebuild or add days:</b> see <code>README.md</code>. Ongoing live collection needs a free 511.org API key (<code>pipeline/collect_511.py</code>).</p>`;
}

// =====================================================================
async function main() {
  const [net, hot, veh, market, calib] = await Promise.all(
    ["network", "hotspots", "vehicles", "market", "calibration"].map((n) => getJSON(`data/${n}.json`)));
  Object.assign(DATA, { net, hot, veh, market, calib });
  DATA.sig = await getJSON("data/signals.json").catch(() => null);
  $("#data-note").textContent = `Based on ${dataLabel()}.`;
  const inited = {};
  const inits = { city: initCity, route: initRoute, signals: initSignals, buses: initBuses, stops: initStops, market: initMarket, about: initAbout };
  const show = (name) => {
    document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
    if (!inited[name]) { inited[name] = true; inits[name](); }
    [city.map, rt.map, sc.map, mk.map, sg.map].forEach((m) => m && m.resize());
    try { localStorage.setItem("tab", name); } catch (e) {}
    location.hash = name;
  };
  document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  let start = location.hash.slice(1);
  if (!inits[start]) { try { start = localStorage.getItem("tab") || "city"; } catch (e) { start = "city"; } }
  show(inits[start] ? start : "city");
}
main();
