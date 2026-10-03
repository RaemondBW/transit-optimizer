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
  constructor(id, opts = {}) {
    const { center = [37.765, -122.44], zoom = 12.5 } = opts;
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
    if (opts.nav !== false) this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    this.map.dragRotate.disable();
    this.map.touchZoomRotate.disableRotation();
    this.loaded = false;
    this.ready = new Promise((r) => this.map.on("load", () => {
      this.loaded = true;
      // start the attribution collapsed to its (i) button so it doesn't cover the map
      this.map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
      r();
    }));
    this.sets = {};
  }
  _ensure(name, kind, opts) {
    if (this.sets[name]) return this.sets[name];
    const m = this.map, id = `set-${name}`;
    m.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    if (kind === "line") {
      m.addLayer({ id, type: "line", source: id, layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"],
                 ...(opts.dash ? { "line-dasharray": opts.dash } : {}), ...(opts.blur ? { "line-blur": opts.blur } : {}) } });
    } else {
      m.addLayer({ id, type: "circle", source: id,
        paint: { "circle-radius": ["get", "radius"], "circle-color": ["get", "fill"], "circle-opacity": ["get", "fillOpacity"],
                 "circle-stroke-color": ["get", "stroke"], "circle-stroke-width": ["get", "strokeWidth"],
                 "circle-stroke-opacity": 1 } });
    }
    const set = { id, handlers: [] , hover: opts.hover !== false };
    m.on("mousemove", id, (e) => {
      if (Object.values(this.sets).some((x) => x.onHover && x.hovering)) return;  // a vehicle's card wins
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

// ---------- vehicle icons ----------
// Muni-style top-down vehicles, nose up (north): body colored by what it's doing,
// the line number painted on the roof, and the route's color as the outline.
// Images are drawn on demand (MapLibre "styleimagemissing") for each combination
// of shape / status / line / route color / text direction the map actually needs.
const VEHICLE_SHAPES = { bus: [16, 36], rail: [16, 52], streetcar: [16, 40], cable: [15, 26] };
const HALF = [16, 26];   // one half of an articulated light-rail car
const MUNI_SILVER = "#d9dad5";
// body color per status code: 0 moving, 1 crawling, 2 at a stop, 3 stuck/at a light, 4 layover, 5 out of service
const VEH_BODY = ["#2fa84f", "#e3a21a", MUNI_SILVER, "#d9412b", "#b9b9b3", "#8f8f89"];
const vehColor = (code) => VEH_BODY[code] ?? MUNI_SILVER;
const VEH_LABEL = ["Moving", "Crawling in traffic", "At a stop", "Stuck (traffic or light)", "Laying over", "Out of service"];

function drawVehicle(shape, code, text, outline, flip) {
  const [w, h] = shape === "railfront" || shape === "railrear" ? HALF : (VEHICLE_SHAPES[shape] || VEHICLE_SHAPES.bus);
  const k = 2, pad = 3;
  const c = document.createElement("canvas");
  c.width = (w + pad * 2) * k; c.height = (h + pad * 2) * k;
  const g = c.getContext("2d");
  g.scale(k, k); g.translate(pad, pad);
  const rr = (x, y, ww, hh, r) => { g.beginPath(); g.roundRect(x, y, ww, hh, r); };
  const front = shape !== "railrear", rear = shape !== "railfront";
  const body = vehColor(code), light = code === 2 || code === 4 || code === 5;
  // body + route-colored outline
  rr(0, 0, w, h, [front ? 5 : 1.5, front ? 5 : 1.5, rear ? 3.5 : 1.5, rear ? 3.5 : 1.5]);
  g.fillStyle = body; g.fill();
  g.lineWidth = 2.4; g.strokeStyle = outline; g.stroke();
  // windshield at the nose, rear window at the tail
  g.fillStyle = "rgba(20,24,28,.82)";
  if (front) { rr(2.2, 2.4, w - 4.4, 4.2, 1.6); g.fill(); }
  if (rear) { rr(3.5, h - 3.6, w - 7, 1.8, 0.8); g.fill(); }
  // side window strips (a hint of the Muni livery)
  g.fillStyle = light ? "rgba(40,44,48,.28)" : "rgba(255,255,255,.28)";
  g.fillRect(1.3, front ? 8 : 2, 1.6, h - (front ? 11 : 4)); g.fillRect(w - 2.9, front ? 8 : 2, 1.6, h - (front ? 11 : 4));
  if (!light && front) { g.fillStyle = "#c8102e"; g.fillRect(1.3, front ? 7.2 : 0, w - 2.6, 1); }  // Muni red band behind the cab
  if (shape === "railfront") { g.fillStyle = outline; g.fillRect(1, h - 1.6, w - 2, 1.6); }
  if (shape === "railrear") { g.fillStyle = outline; g.fillRect(1, 0, w - 2, 1.6); }
  // line number on the roof, running along the body; flipped so it never reads upside down
  if (text) {
    g.save();
    const cy = front && rear ? h / 2 + 2 : front ? h / 2 + 3 : h / 2;
    g.translate(w / 2, cy);
    g.rotate(flip ? Math.PI / 2 : -Math.PI / 2);
    const size = text.length >= 3 ? 8.2 : 9.6;
    g.font = `700 ${size}px "Instrument Sans", system-ui, sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.lineWidth = 2.2; g.strokeStyle = light ? "rgba(255,255,255,.9)" : "rgba(0,0,0,.35)";
    g.strokeText(text, 0, 0.5);
    g.fillStyle = light ? "#111" : "#fff";
    g.fillText(text, 0, 0.5);
    g.restore();
  }
  return { width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
}
const vehIconName = (shape, code, text, outline, flip) => `v|${shape}|${code}|${text || ""}|${outline}|${flip ? 1 : 0}`;
// small upright traffic light with the red lamp lit
function trafficLightIcon() {
  const w = 10, h = 24, k = 2, pad = 4;
  const c = document.createElement("canvas");
  c.width = (w + pad * 2) * k; c.height = (h + pad * 2) * k;
  const g = c.getContext("2d");
  g.scale(k, k); g.translate(pad, pad);
  g.beginPath(); g.roundRect(0, 0, w, h, 3);
  g.fillStyle = "#1a1a19"; g.fill(); g.lineWidth = 1.2; g.strokeStyle = dark() ? "#8d8c84" : "#fcfcfb"; g.stroke();
  const lamp = (y, col, lit) => { g.save(); if (lit) { g.shadowColor = col; g.shadowBlur = 6; } g.beginPath(); g.arc(w / 2, y, 2.7, 0, Math.PI * 2); g.fillStyle = col; g.fill(); g.restore(); };
  lamp(5, "#ff3b30", true); lamp(12, "#4a3f1c", false); lamp(19, "#1f3b2a", false);
  return { width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
}
// passengers boarding: two little people stepping in, in a light badge
function paxIcon() {
  const w = 20, h = 16, k = 2, pad = 2;
  const c = document.createElement("canvas");
  c.width = (w + pad * 2) * k; c.height = (h + pad * 2) * k;
  const g = c.getContext("2d");
  g.scale(k, k); g.translate(pad, pad);
  g.beginPath(); g.roundRect(0, 0, w, h, 5);
  g.fillStyle = "#fcfcfb"; g.fill(); g.lineWidth = 1.2; g.strokeStyle = "#1baf7a"; g.stroke();
  const person = (x, s) => {
    g.fillStyle = "#127a55";
    g.beginPath(); g.arc(x, 4.2 * s + 0.6, 2 * s, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.roundRect(x - 2.4 * s, 7 * s, 4.8 * s, 6.2 * s, 2 * s); g.fill();
  };
  person(6.5, 1); person(12.5, 0.92);
  g.strokeStyle = "#127a55"; g.lineWidth = 1.4; g.beginPath(); g.moveTo(15.6, 8); g.lineTo(18.4, 8); g.moveTo(17.2, 6.6); g.lineTo(18.6, 8); g.lineTo(17.2, 9.4); g.stroke();
  return { width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
}
GLMap.prototype.ensureVehicleIcons = function () {
  if (this._icons) return;
  this._icons = true;
  this.map.addImage("tlight", trafficLightIcon(), { pixelRatio: 2 });
  this.map.addImage("pax", paxIcon(), { pixelRatio: 2 });
  // draw any vehicle icon the first time the map asks for it
  this.map.on("styleimagemissing", (e) => {
    if (!e.id.startsWith("v|") || this.map.hasImage(e.id)) return;
    const [, shape, code, text, outline, flip] = e.id.split("|");
    this.map.addImage(e.id, drawVehicle(shape, +code, text, outline, flip === "1"), { pixelRatio: 2 });
  });
};
// Icon scale used by the symbol layer at a given MapLibre zoom (keep in sync with icon-size).
const iconScale = (z) => (z <= 10 ? 0.45 : z <= 13 ? 0.45 + ((z - 10) / 3) * 0.3 : z <= 16 ? 0.75 + ((z - 13) / 3) * 0.5 : 1.25);
// features: [{ lat, lon, icon, rot, tip, onClick }]
// Vehicles are drawn on a 2D canvas laid over the map, every frame, instead of
// through a MapLibre GeoJSON source: re-uploading ~700 moving icons each frame
// made MapLibre re-lay-out the symbol layer in its worker, which couldn't keep up
// (vehicles visibly jumped about once a second during playback).
// features: [{ lat, lon, icon, rot, key, tip, onClick }] or { ring: true, lat, lon }
const ICON_CACHE = new Map();
function iconCanvas(name) {
  let c = ICON_CACHE.get(name);
  if (c) return c;
  let img;
  if (name === "tlight") img = trafficLightIcon();
  else if (name === "pax") img = paxIcon();
  else { const [, shape, code, text, outline, flip] = name.split("|"); img = drawVehicle(shape, +code, text, outline, flip === "1"); }
  c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  c.getContext("2d").putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  ICON_CACHE.set(name, c);
  return c;
}
GLMap.prototype.symbols = function (name, features, opts = {}) {
  if (!this.loaded) { this.ready.then(() => this.symbols(name, features, opts)); return; }
  let set = this.sets[name];
  if (!set) {
    const m = this.map, cv = document.createElement("canvas");
    cv.className = "veh-overlay";
    cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;";
    m.getCanvasContainer().appendChild(cv);
    set = { handlers: new Map(), hover: true, features: [], drawn: [], cv, ctx: cv.getContext("2d"), raf: 0 };
    const draw = () => {
      set.raf = 0;
      const dpr = devicePixelRatio || 1, W = m.getCanvas().clientWidth, H = m.getCanvas().clientHeight;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + "px"; cv.style.height = H + "px";
      }
      const g = set.ctx;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const scale = iconScale(m.getZoom()), drawn = [];
      let ring = null;
      for (const f of set.features) {
        if (f.ring) { ring = f; continue; }
        const p = m.project([f.lon, f.lat]);
        if (p.x < -40 || p.y < -40 || p.x > W + 40 || p.y > H + 40) continue;   // off screen
        const img = iconCanvas(f.icon), w = (img.width / 2) * scale, h = (img.height / 2) * scale;
        g.save(); g.translate(p.x, p.y); if (f.rot) g.rotate((f.rot * Math.PI) / 180);
        g.drawImage(img, -w / 2, -h / 2, w, h);
        g.restore();
        drawn.push({ x: p.x, y: p.y, f });
      }
      if (ring) {   // highlight ring around the selected vehicle
        const p = m.project([ring.lon, ring.lat]);
        g.beginPath(); g.arc(p.x, p.y, 17, 0, Math.PI * 2);
        g.fillStyle = css("--accent") + "2e"; g.fill();
        g.lineWidth = 3; g.strokeStyle = css("--accent"); g.stroke();
      }
      set.drawn = drawn;
    };
    set.schedule = () => { if (!set.raf) set.raf = requestAnimationFrame(draw); };
    m.on("move", set.schedule);
    m.on("resize", set.schedule);
    // hover/click: nearest drawn vehicle within HIT px (icons are small and moving)
    const HIT = 12;
    const nearest = (pt) => {
      let best = null, bd = HIT;
      for (const d of set.drawn) {
        if (d.f.key == null) continue;
        const dist = Math.hypot(d.x - pt.x, d.y - pt.y);
        if (dist < bd) { bd = dist; best = d.f; }
      }
      return best;
    };
    m.on("mousemove", (e) => {
      const f = nearest(e.point);
      if (f) {
        m.getCanvas().style.cursor = "pointer"; set.hovering = true;
        if (set.onHover) { if (set.hoverKey !== f.key) { set.hoverKey = f.key; set.onHover(f.key); } }
        else if (f.tip) showTip(e.originalEvent, f.tip);
      } else if (set.hovering) {
        set.hovering = false; m.getCanvas().style.cursor = ""; hideTip();
        if (set.onHover) { set.hoverKey = null; set.onHover(null); }
      }
    });
    m.on("mouseout", () => { if (set.onHover && set.hoverKey != null) { set.hoverKey = null; set.onHover(null); } });
    m.on("click", (e) => { const f = nearest(e.point); const h = f && set.handlers.get(f.key); if (h) { hideTip(); h(); } });
    this.sets[name] = set;
  }
  set.features = features;
  set.handlers = new Map(features.filter((f) => f.onClick).map((f) => [f.key, f.onClick]));
  if (opts.onHover) set.onHover = opts.onHover;
  set.schedule();
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
const BRIDGE_MAX = 1200;  // s: longest same-trip gap we'll carry a vehicle across
const onTrip = (p) => p[4] > 0 && p[5] >= 0;
function fleetPosition(pts, t, data) {
  const i = d3.bisector((p) => p[0]).right(pts, t) - 1;
  if (i < 0 || i >= pts.length - 1) return null;
  // Bridge GPS dropouts: tunnels and dead zones produce missing fixes or fixes too far
  // off the track to match the route. If the last on-trip fix before t and the next one
  // after t belong to the same trip, carry the vehicle along the route between them.
  let ia = i, ib = i + 1;
  while (ia >= 0 && !onTrip(pts[ia]) && t - pts[ia][0] < BRIDGE_MAX) ia--;
  while (ib < pts.length && !onTrip(pts[ib]) && pts[ib][0] - t < BRIDGE_MAX) ib++;
  if (ia >= 0 && ib < pts.length && onTrip(pts[ia]) && onTrip(pts[ib])) {
    const A = pts[ia], B = pts[ib];
    if (A[4] === B[4] && B[5] >= A[5] - 30 && B[0] - A[0] <= BRIDGE_MAX && B[0] > A[0]) {
      const label = data.routes[A[4] - 1], shape = routeByKeyFast(label);
      if (shape) {
        const f = (t - A[0]) / (B[0] - A[0]);
        const along = A[5] + f * (B[5] - A[5]);
        const ll = pointAt(shape, along);
        return { lat: ll[0], lon: ll[1], a: A, b: B, f, label, shape, along, bridged: ib - ia > 1 };
      }
    }
  }
  const a = pts[i], b = pts[i + 1];
  if (b[0] - a[0] > 180) return null;
  let f = (t - a[0]) / (b[0] - a[0]);
  // Teleports (e.g. the composite day's 5pm seam joins two different days) aren't motion:
  // hold the vehicle at the nearer fix instead of sliding it across the city.
  const jump = Math.hypot((b[1] - a[1]) * 1.11, (b[2] - a[2]) * 0.88) / (b[0] - a[0]);
  if (jump > 35) f = f < 0.5 ? 0 : 1;
  const label = (f < 1 ? a : b)[4] ? data.routes[(f < 1 ? a : b)[4] - 1] : null;
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
  let sel = null, ui = null;

  // ---- detail panel that rides along with the selected vehicle:
  // a mini speedometer and one plain-language status.
  const GAUGE_MAX = { bus: 40, rail: 50, streetcar: 40, cable: 15 };
  const R = 52, CX = 70, CY = 64;
  const arcPt = (v) => { const a = Math.PI * (1 - v); return [CX + R * Math.cos(a), CY - R * Math.sin(a)]; };
  const arcPath = (v) => { const [x, y] = arcPt(Math.max(v, 0.001)); return `M${CX - R},${CY} A${R},${R} 0 0 1 ${x.toFixed(1)},${y.toFixed(1)}`; };
  const buildPanel = () => {
    const el = document.createElement("div");
    el.className = "vp-body";
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
  const panelEl = document.getElementById("vpanel");
  const isDesk = () => matchMedia("(min-width: 1100px)").matches;
  const show = (target) => {
    const changed = !sel || !target || sel.vid !== target.vid;
    sel = target;
    if (!sel) {
      panelEl.hidden = true;
      if (gl.sets[name]) gl.symbols(name, gl.sets[name].features.filter((f) => !f.ring));
      return;
    }
    if (!ui) {
      ui = buildPanel();
      panelEl.innerHTML = "";
      const close = document.createElement("button");
      close.className = "vp-close"; close.setAttribute("aria-label", "Close"); close.textContent = "×";
      close.onclick = () => { pinned = null; hovered = null; show(null); };
      const hint = document.createElement("div");
      hint.className = "vp-hint";
      panelEl.append(close, ui.el, hint);
      ui.close = close; ui.hint = hint;
    }
    const isPinned = !!pinned && sel.vid === pinned.vid;
    ui.close.hidden = !isPinned;
    ui.hint.textContent = isPinned ? "Esc to close" : isDesk() ? "click to pin · Esc to close" : "";
    if (changed) {
      ui.max = GAUGE_MAX[sel.mode] || 40;
      drawTicks(ui.max);
      ui.shown = null;      // jump straight to this vehicle's speed
      side = null;          // pick a side for the new vehicle
    }
    if (lastT != null) fl.update(lastT);
  };
  // keep the card attached while the map pans/zooms with playback paused
  let moveRaf = 0;
  gl.map.on("move", () => { if (sel && lastT != null) { cancelAnimationFrame(moveRaf); moveRaf = requestAnimationFrame(() => fl.update(lastT)); } });
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
    const color = vehColor(st.key === 1 ? 1 : st.key);
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
      if (!enabled || !data) { gl.symbols(name, []); show(null); return; }
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
        let code = Math.min((p.f < 0.5 ? p.a : p.b)[3], 5);
        if (p.shape && p.along != null && code !== 0) {   // match the card: at a stop / at a light / in traffic
          const mphNow = Math.max(0, p.a[6] + p.f * (p.b[6] - p.a[6]));
          const k = describe(p, mphNow).key;
          code = k === 0 ? 0 : k === 2 ? 2 : k === 3 ? 3 : code === 4 ? 4 : 1;
        }
        const route = p.shape ? `${p.shape.route} → ${p.shape.headsign}` : "not on a trip";
        const common = { key: vid, tip: `${VEHICLE_NAME[mode] || mode} ${vid} · ${route}<br>${STATE[code].label} · click for details`,
          onClick: () => select(vid, mode) };
        // on a route, face along the track (also right for stopped vehicles, whose GPS heading goes stale)
        if (p.shape && p.along != null) rot = bearingOf(pointAt(p.shape, p.along - 6), pointAt(p.shape, p.along + 6));
        const text = p.shape ? p.shape.route : "";
        const outline = p.shape ? p.shape.color : (dark() ? "#3a3a37" : "#9a9a94");
        const flipFor = (r) => ((r % 360) + 360) % 360 > 180;   // keep the roof number readable
        if (mode === "rail" && p.shape && p.along != null) {
          // Articulated train: each half sits on the track at its own spot and turns
          // with its own piece of curve, so the train bends at the middle joint.
          const halfM = HALF[1] * scale * mpp;
          const dir = heading.get(`${vid}:dir`) ?? 1;  // +1: travelling toward higher "along"
          for (const [part, off] of [["front", halfM / 2], ["rear", -halfM / 2]]) {
            const c = Math.min(Math.max(p.along + dir * off, 0), p.shape.length);
            const at = pointAt(p.shape, c);
            const r = bearingOf(pointAt(p.shape, c - dir * 4), pointAt(p.shape, c + dir * 4));
            feats.push({ ...common, lat: at[0], lon: at[1], rot: r, icon: vehIconName(`rail${part}`, code, text, outline, flipFor(r)) });
          }
        } else {
          feats.push({ ...common, lat: p.lat, lon: p.lon, rot, icon: vehIconName(VEHICLE_SHAPES[mode] ? mode : "bus", code, text, outline, flipFor(rot)) });
        }
        if (sel && sel.vid === vid) selPos = p;
        // just past the vehicle's nose: a red light when it's held at a signal,
        // passengers boarding when it's at a stop
        if (p.shape && p.along != null) {
          const mphNow = Math.max(0, p.a[6] + p.f * (p.b[6] - p.a[6]));
          const k = mphNow < 5 ? describe(p, mphNow).key : 0;
          if (k === 3 || k === 2) {
            const len = mode === "rail" ? HALF[1] * 2 : (VEHICLE_SHAPES[mode] || VEHICLE_SHAPES.bus)[1];
            const at = pointAt(p.shape, Math.min(p.along + (len / 2 + 12) * scale * mpp, p.shape.length));
            feats.push({ key: vid, lat: at[0], lon: at[1], rot: 0, icon: k === 3 ? "tlight" : "pax", onClick: common.onClick });
          }
        }
      }
      if (sel && selPos) feats.push({ ring: true, lat: selPos.lat, lon: selPos.lon });
      gl.symbols(name, feats, { onHover: hover });
      if (sel) {
        // The trip the card was opened on has ended (finished the route, started another
        // run, laid over, or the GPS ran out): close the card.
        if (sel.label === undefined && selPos) sel.label = selPos.label;
        // laying over only counts as "done" at the far end of the line, not while waiting to depart
        const atEnd = selPos?.shape && selPos.along != null && selPos.along > selPos.shape.length - 300;
        const ended = !selPos || (sel.label != null && (selPos.label !== sel.label || (atEnd && (selPos.f < 0.5 ? selPos.a : selPos.b)[3] === 4)));
        if (ended) {
          if (pinned && pinned.vid === sel.vid) pinned = null;
          if (hovered && hovered.vid === sel.vid) hovered = null;
          show(pinned);   // falls back to nothing (or another pinned vehicle)
          return;
        }
        updatePanel(sel.vid, sel.mode, selPos);
        panelEl.hidden = false;
        if (selPos && isDesk()) {
          // Beside the vehicle, on one side; only flip when it would run off screen.
          const p = gl.map.project([selPos.lon, selPos.lat]), W = innerWidth, PW = 214;
          const fitsRight = p.x + 22 + PW < W - 16, fitsLeft = p.x - 22 - PW > 16;
          if (side == null) side = fitsRight ? "right" : "left";
          else if (side === "right" && !fitsRight) side = "left";
          else if (side === "left" && !fitsLeft) side = "right";
          panelEl.style.left = Math.round(side === "right" ? p.x + 22 : p.x - 22 - PW) + "px";
          panelEl.style.top = Math.round(Math.min(Math.max(p.y - 110, 84), innerHeight - 360)) + "px";
        } else if (!isDesk()) {
          panelEl.style.left = ""; panelEl.style.top = "";
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
// MAIN MAP: City hotspots + Route explorer share one full-screen map
// =====================================================================
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
const CHIP_MODES = [["all", "All modes"], ["bus", "Buses"], ["rail", "Metro"], ["streetcar", "F line"], ["cable", "Cable cars"]];
const SUBJECT = { all: ["Muni", "spends"], bus: ["Buses", "spend"], rail: ["Metro trains", "spend"], streetcar: ["The F line", "spends"], cable: ["Cable cars", "spend"] };
const TABS = [
  { k: "city", l: "City hotspots", s: "Hotspots", m: "Hotspots" }, { k: "route", l: "Route explorer", s: "Routes", m: "Routes" },
  { k: "signals", l: "Traffic signals", s: "Signals", m: "Signals" }, { k: "buses", l: "Every vehicle", s: "Vehicles", m: "Vehicles" },
  { k: "stops", l: "Stop consolidation", s: "Stops" }, { k: "market", l: "Market St trunk", s: "Market St" }, { k: "about", l: "Method", s: "Method" },
];
const UI = { tab: "city", mode: "all", t: 17 * 3600, hour: null, playing: false, speed: 120, selHot: null, sheetH: null };
let M = null, fleet = null;
const isDesk = () => matchMedia("(min-width: 1100px)").matches;
const clampHour = (h) => Math.min(Math.max(h, 5), 23);
const modeOk = (m) => UI.mode === "all" || m === UI.mode;
const $$ = (q) => [...document.querySelectorAll(q)];

// ---------- map padding / mobile sheet ----------
const snaps = () => [150, Math.round(innerHeight * 0.42), innerHeight - 64 - 104];
const sheetH = () => UI.sheetH ?? snaps()[1];
const padding = () => (isDesk() ? { left: 412, top: 80, right: 250, bottom: 120 }
  : { left: 10, right: 10, top: UI.tab === "city" || UI.tab === "signals" ? 130 : 84, bottom: Math.min(sheetH(), innerHeight - 200) });
function applyLayout(refit = true) {
  const panel = $("#panel");
  panel.style.height = isDesk() ? "" : sheetH() + "px";
  if (!M) return;
  M.resize();
  // keep the page's subject in view above the sheet (but not while zoomed into a picked spot)
  if (refit && UI.selHot == null && !(UI.tab === "signals" && sg.flown)) fitView(300);
  else M.map.easeTo({ padding: padding(), duration: 250 });
}
function setupSheet() {
  const handle = $("#handle"), panel = $("#panel");
  handle.addEventListener("pointerdown", (e) => {
    const y0 = e.clientY, h0 = sheetH(); let moved = false;
    panel.classList.add("dragging");
    const move = (ev) => {
      if (Math.abs(ev.clientY - y0) > 4) moved = true;
      const [lo, , hi] = snaps();
      UI.sheetH = Math.min(hi, Math.max(lo, h0 + y0 - ev.clientY));
      panel.style.height = UI.sheetH + "px";
    };
    const up = () => {
      removeEventListener("pointermove", move);
      panel.classList.remove("dragging");
      const sn = snaps(), h = sheetH();
      let target = sn.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
      if (!moved) { const i = sn.indexOf(sn.reduce((a, b) => (Math.abs(b - h0) < Math.abs(a - h0) ? b : a))); target = sn[(i + 1) % 3]; }
      UI.sheetH = target;
      applyLayout();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up, { once: true });
  });
}

// ---------- timeline: one clock for the whole app ----------
// playback speed slider: logarithmic from 30x to 1200x
const SPEED_MIN = 30, SPEED_MAX = 1200;
const speedFromSlider = (v) => SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, v / 1000);
const sliderFromSpeed = (x) => Math.round((1000 * Math.log(x / SPEED_MIN)) / Math.log(SPEED_MAX / SPEED_MIN));
const niceSpeed = (x) => (x < 100 ? Math.round(x / 5) * 5 : x < 400 ? Math.round(x / 10) * 10 : Math.round(x / 50) * 50);
function setSpeed(x) {
  UI.speed = niceSpeed(Math.min(Math.max(x, SPEED_MIN), SPEED_MAX));
  $$("[data-speed-label]").forEach((el) => (el.textContent = `${UI.speed}×`));
  $$("[data-speed]").forEach((el) => { if (document.activeElement !== el) el.value = sliderFromSpeed(UI.speed); });
  $("#speed-note").textContent = UI.playing ? `playing at ${UI.speed}×` : "weekday average";
}
function setTime(t) {
  const lo = 18000, hi = 86340;
  UI.t = t > hi ? lo + (t - hi) : Math.max(lo, t);
  const h = Math.floor(UI.t / 3600), hourChanged = h !== UI.hour;
  UI.hour = h;
  $$("[data-clock]").forEach((el) => (el.textContent = fmtClock(UI.t)));
  $$("[data-scrub]").forEach((el) => { if (document.activeElement !== el) el.value = UI.t; });
  if (hourChanged) onHour();
  if (fleet) fleet.update(UI.t);
}
function onHour() {
  const h = clampHour(UI.hour);
  $$("[data-hour]").forEach((el) => (el.textContent = `${fmtH(h)}–${fmtH(h + 1)}`));
  $$("[data-hour-short]").forEach((el) => (el.textContent = fmtH(h)));
  drawBars();
  drawSpeed();
  if (UI.tab === "city") drawCityStats();
  if (UI.tab === "route" && rt.data) drawRoutePanel();
  if (UI.tab === "signals" && $("#sig-hour").value === "clock") renderSignals();
  if (UI.tab === "market") { if (DATA.trunk) renderTrunk(); if (mk.routes) renderMarket(); }
}
function setPlaying(on) {
  UI.playing = on;
  $$("[data-glyph]").forEach((el) => (el.textContent = on ? "❚❚" : "▶"));
  $("#speed-note").textContent = on ? `playing at ${UI.speed}×` : "weekday average";
  if (!on) return;
  let last = performance.now();
  const frame = (now) => {
    if (!UI.playing) return;
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    setTime(UI.t + dt * UI.speed);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
function setupTimeline() {
  $$("[data-play]").forEach((b) => (b.onclick = () => setPlaying(!UI.playing)));
  $$("[data-scrub]").forEach((r) => r.addEventListener("input", () => setTime(+r.value)));
  $$("[data-speed]").forEach((r) => r.addEventListener("input", () => setSpeed(speedFromSlider(+r.value))));
  setSpeed(UI.speed);
  setPlaying(false);
}
// share of the (selected-mode) fleet stuck, each hour
function drawBars() {
  const b = DATA.budget?.[UI.mode] || {};
  const hrs = d3.range(5, 24);
  const vals = hrs.map((h) => { const v = b[h]; if (!v) return 0; const tot = sum(v); return tot ? (v[1] + v[3]) / tot : 0; });
  const nz = vals.filter((v) => v > 0), lo = (d3.min(nz) || 0) * 0.85, hi = d3.max(nz) || 1;
  $("#bars").innerHTML = hrs.map((h, i) =>
    `<div class="${h === clampHour(UI.hour) ? "cur" : ""}" style="height:${vals[i] ? Math.round(6 + 34 * (vals[i] - lo) / (hi - lo || 1)) : 3}px" title="${fmtH(h)}: ${Math.round(vals[i] * 100)}% of the fleet stuck"></div>`).join("");
}

// ---------- speed lines (shared by City and Route) ----------
function drawSpeed() {
  if (!M || !DATA.heat || (UI.tab !== "city" && UI.tab !== "route")) return;
  const hour = clampHour(UI.hour), feats = [], glow = [];
  const isRoute = UI.tab === "route";
  for (const r of DATA.net.routes) {
    if (isRoute ? r.key !== rt.key : !modeOk(modeOf(r))) continue;   // Route explorer: only the selected route
    const row = DATA.heat[r.key]?.[hour];
    if (!row) continue;
    const mine = !isRoute || r.key === rt.key;
    let run = null;
    const flush = () => {
      if (!run) return;
      // Route explorer: one constant width, speed shown by color only
      const f = { coords: run.pts, color: run.color, width: isRoute ? 5 : run.weight, opacity: mine ? 0.92 : 0.12,
        tip: `<b>${r.route}</b> → ${r.headsign}<br>${d3.min(run.mph)}–${d3.max(run.mph)} mph at ${fmtH(hour)}` };
      feats.push(f);
      // glow only where it's slow for a sustained stretch (>= 300 m under 6 mph), so real problems pop
      if (!isRoute && run.mph.length >= 3 && d3.mean(run.mph) < 6) glow.push({ coords: run.pts, color: SPEED_RAMP[0], width: 14, opacity: dark() ? 0.3 : 0.16 });
      run = null;
    };
    for (const p of binPieces(r, DATA.net.bin)) {
      const cell = row[p.bin];
      if (!cell) { flush(); continue; }
      const color = speedColor(cell[0]), weight = isRoute ? 5 : cell[0] < 8 ? 4 : 2.5;
      if (run && run.color === color && run.weight === weight) { run.pts.push(...p.pts.slice(1)); run.mph.push(cell[0]); }
      else { flush(); run = { color, weight, pts: p.pts.slice(), mph: [cell[0]] }; }
    }
    flush();
  }
  M.lines("glow", glow, { blur: 6 });
  M.lines("speed", feats);
}

// ---------- City panel ----------
function drawCityStats() {
  const b = DATA.budget?.[UI.mode]?.[clampHour(UI.hour)] || [0, 0, 0, 0];
  const tot = sum(b) || 1, mv = b[0] / tot, dw = b[2] / tot, stuck = (b[1] + b[3]) / tot;
  const [who, verb] = SUBJECT[UI.mode];
  $("#c-mode").textContent = CHIP_MODES.find((m) => m[0] === UI.mode)[1].toLowerCase();
  $("#c-headline").textContent = stuck > 0.02 ? `${who} ${verb} 1 in ${Math.max(2, Math.round(1 / stuck))} minutes going nowhere.` : `${who} keep moving.`;
  $("#c-move").textContent = `${Math.round(mv * 100)}%`;
  $("#c-dwell").textContent = `${Math.round(dw * 100)}%`;
  $("#c-stuck").textContent = `${Math.round(stuck * 100)}%`;
  $("#c-split").innerHTML = [[b[0], "--s-moving"], [b[2], "--s-dwell"], [b[3], "--s-stopped"], [b[1], "--s-crawl"]]
    .map(([v, c]) => `<span style="flex:${v};background:var(${c})"></span>`).join("");
}
const routeColor = (id) => (routeByKeyFast(`${id}_0`) || routeByKeyFast(`${id}_1`) || {}).color || "#666";
const routeMode = (id) => modeOf(routeByKeyFast(`${id}_0`) || routeByKeyFast(`${id}_1`) || {});
const HEADING_NAME = { N: "Northbound", NE: "Northeast-bound", E: "Eastbound", SE: "Southeast-bound", S: "Southbound", SW: "Southwest-bound", W: "Westbound", NW: "Northwest-bound" };
function hotRows() {
  return DATA.hot.map((h, i) => {
    const bm = h.by_mode || { bus: h.bus_hours };
    const hours = UI.mode === "all" ? sum(Object.values(bm)) : bm[UI.mode] || 0;
    return { i, h, hours, routes: h.routes.filter((r) => modeOk(routeMode(r))) };
  }).filter((r) => r.hours >= 0.05).sort((a, b) => b.hours - a.hours).slice(0, 40);
}
function drawHotspots() {
  const rows = hotRows(), max = rows[0]?.hours || 1;
  const box = $("#c-hot");
  box.innerHTML = rows.length ? "" : `<p class="muted">No hotspots for the selected mode.</p>`;
  const rowHTML = (r, n) => {
    const { h } = r, c = h.cause;
    const dom = c.stopped >= c.dwell && c.stopped >= c.crawl ? "Mostly signals & traffic" : c.crawl >= c.dwell ? "Mostly crawling in traffic" : "Mostly time at stops";
    return `<div class="rk">${String(n + 1).padStart(2, "0")}</div>
      <div><div class="nm">${h.name}</div><div class="sb">${HEADING_NAME[h.heading] || h.heading} · ${dom}</div></div>
      <div class="hh">${r.hours.toFixed(1)}</div><div></div>
      <div class="bot"><div class="badges">${r.routes.slice(0, 6).map((x) => `<span class="rb" style="background:${routeColor(x)}">${x}</span>`).join("")}</div>
        <div class="cause"><span style="flex:${c.stopped};background:var(--s-stopped)"></span><span style="flex:${c.dwell};background:var(--s-dwell)"></span><span style="flex:${c.crawl};background:var(--s-crawl)"></span></div></div>`;
  };
  rows.forEach((r, n) => {
    const el = document.createElement("div");
    el.className = "hot-row" + (UI.selHot === r.i ? " sel" : "");
    el.innerHTML = rowHTML(r, n);
    el.onclick = () => pickHot(r.i);
    box.appendChild(el);
  });
  // mobile: the tapped spot gets its own card at the top of the (collapsed) sheet
  const selBox = $("#c-sel"), si = rows.findIndex((r) => r.i === UI.selHot);
  selBox.hidden = si < 0;
  if (si >= 0) {
    selBox.innerHTML = `<div class="sel-top"><span class="eyebrow">Sticking point</span>
      <button class="sel-back" type="button">Back to list</button></div><div class="hot-row sel">${rowHTML(rows[si], si)}</div>`;
    selBox.querySelector(".sel-back").onclick = () => { UI.selHot = null; UI.sheetH = snaps()[1]; drawHotspots(); applyLayout(); };
  }
  M.points("hot", UI.tab === "city" ? rows.map((r, n) => ({
    lat: r.h.lat, lon: r.h.lon, radius: 5 + 11 * Math.sqrt(r.hours / max), fill: css("--s-moving"),
    fillOpacity: UI.selHot === r.i ? 0.35 : 0, stroke: css("--text"), strokeWidth: 1.5,
    tip: `#${n + 1} ${r.h.name}: ${r.hours.toFixed(1)} vehicle-h/day lost`, onClick: () => pickHot(r.i) })) : []);
}
function pickHot(i) {
  const h = DATA.hot[i];
  UI.selHot = i;
  drawHotspots();
  if (!isDesk()) {
    // collapse the sheet to just fit the selected spot's card, so the map shows above it
    const panel = $("#panel"), body = panel.querySelector(".panel-body"), card = $("#c-sel");
    const chrome = panel.querySelector(".handle").offsetHeight + panel.querySelector(".mtime").offsetHeight;
    const pad = parseFloat(getComputedStyle(body).paddingTop) + 14;
    UI.sheetH = Math.min(snaps()[1], Math.max(snaps()[0], chrome + card.offsetHeight + pad));
    body.scrollTop = 0;
    applyLayout(false);
  } else {
    $("#c-hot .hot-row.sel")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  M.map.flyTo({ center: [h.lon, h.lat], zoom: 15, padding: padding(), duration: 900 });
}

// ---------- Route panel ----------
const rt = { key: null, data: null, route: null };
async function loadRoute(key) {
  rt.key = key; rt.route = routeByKey(key);
  rt.data = await routeData(key);
  drawRoutePanel();
  drawSpeed();
  if (fleet) fleet.update(UI.t);
  fitView();
}
function drawRoutePanel() {
  const r = rt.route, d = rt.data, hour = clampHour(UI.hour);
  $("#r-badge").textContent = r.route; $("#r-badge").style.background = r.color;
  $("#r-name").textContent = titleCase(r.name);
  $("#r-sub").textContent = `→ ${r.headsign} · ${(r.length / 1609).toFixed(1)} mi · ${r.stops.length} stops`;
  const run = d.runtime[hour] || d.runtime[Object.keys(d.runtime).sort((a, b) => Math.abs(a - hour) - Math.abs(b - hour))[0]];
  $("#r-med").textContent = run ? run[0].toFixed(1) : "–";
  $("#r-p90").textContent = run ? run[1].toFixed(1) : "–";
  $("#r-mph").textContent = run ? ((r.length / 1609) / (run[0] / 60)).toFixed(1) : "–";
  const bh = d.budget_hour[hour] || [0, 0, 0, 0];   // shares: moving, crawl, dwell, stopped
  $("#r-pmove").textContent = `${Math.round(bh[0] * 100)}%`;
  $("#r-pdwell").textContent = `${Math.round(bh[2] * 100)}%`;
  $("#r-pstuck").textContent = `${Math.round((bh[1] + bh[3]) * 100)}%`;
  const hrs = d3.range(5, 24);
  // where the time goes, by hour
  $("#r-budget").innerHTML = hrs.map((h) => {
    const b = d.budget_hour[h];
    if (!b) return `<div style="opacity:.2"></div>`;
    return `<div style="opacity:${h === hour ? 1 : 0.55}" title="${fmtH(h)}: moving ${Math.round(b[0] * 100)}%, signals/traffic ${Math.round(b[3] * 100)}%, at stops ${Math.round(b[2] * 100)}%, crawling ${Math.round(b[1] * 100)}%">
      <span style="flex:${b[0]};background:var(--s-moving)"></span><span style="flex:${b[3]};background:var(--s-stopped)"></span>
      <span style="flex:${b[2]};background:var(--s-dwell)"></span><span style="flex:${b[1]};background:var(--s-crawl)"></span></div>`;
  }).join("");
  // runtime: median line, band to 90th pct, schedule dashed, cursor at the clock
  const pts = hrs.map((h) => ({ h, r: d.runtime[h], s: d.sched_runtime[h] }));
  const ymax = Math.ceil((d3.max(pts, (p) => Math.max(p.r?.[1] || 0, p.s || 0)) || 10) / 5) * 5 + 5;
  const X = (h) => ((h - 5) / 18) * 340, Y = (v) => 140 - (v / ymax) * 140;
  const path = (sel) => { let out = "", pen = false; pts.forEach((p) => { const v = sel(p); if (v == null) { pen = false; return; } out += `${pen ? "L" : "M"}${X(p.h).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true; }); return out; };
  const withR = pts.filter((p) => p.r);
  const area = withR.length ? withR.map((p, i) => `${i ? "L" : "M"}${X(p.h).toFixed(1)} ${Y(p.r[1]).toFixed(1)}`).join("") +
    withR.slice().reverse().map((p) => `L${X(p.h).toFixed(1)} ${Y(p.r[0]).toFixed(1)}`).join("") + "Z" : "";
  $("#r-runtime").innerHTML = `<svg viewBox="0 0 340 140" preserveAspectRatio="none">
      <path d="${area}" fill="var(--s-moving)" fill-opacity="0.18"></path>
      <path d="${path((p) => p.s)}" fill="none" stroke="var(--text-3)" stroke-width="1.5" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"></path>
      <path d="${path((p) => p.r?.[0])}" fill="none" stroke="var(--s-moving)" stroke-width="2" vector-effect="non-scaling-stroke"></path>
      <path d="M${X(hour).toFixed(1)} 0L${X(hour).toFixed(1)} 140" fill="none" stroke="var(--text)" stroke-width="1" vector-effect="non-scaling-stroke"></path>
    </svg><div class="ymax">${ymax} min</div>`;
  // speed along the route by hour: rows = hours, columns = 100 m cells
  const nb = d.budget_bin.length, paths = SPEED_RAMP.map(() => "");
  hrs.forEach((h, row) => (d.heat[h] || []).forEach((c, b) => {
    if (!c) return;
    let i = SPEED_BREAKS.findIndex((x) => c[0] < x); if (i < 0) i = SPEED_BREAKS.length;
    paths[i] += `M${b + 0.06} ${row + 0.08}h0.88v0.84h-0.88Z`;
  }));
  $("#r-heat").innerHTML = `<svg viewBox="0 0 ${nb} ${hrs.length}" preserveAspectRatio="none">
      ${paths.map((p, i) => `<path d="${p}" fill="${SPEED_RAMP[i]}"></path>`).join("")}
      <path d="M0 ${hour - 5}h${nb}v1h-${nb}Z" fill="none" stroke="var(--text)" stroke-width="1.5" vector-effect="non-scaling-stroke"></path></svg>`;
  $("#r-from").textContent = r.stops[0]?.name || "";
  $("#r-to").textContent = r.headsign;
}

// ---------- tabs, chips, legend ----------
function drawChips() {
  $("#chips").innerHTML = CHIP_MODES.map(([k, l]) => `<button class="${UI.mode === k ? "on" : ""}" data-mode="${k}">${l}</button>`).join("");
  $$("#chips button").forEach((b) => (b.onclick = () => { UI.mode = b.dataset.mode; drawChips(); onModeChange(); }));
}
function onModeChange() {
  drawBars(); drawSpeed(); drawCityStats(); drawHotspots();
  if (UI.tab === "signals") renderSignals();
  if (fleet) fleet.update(UI.t);
}
function drawTabs() {
  const wide = innerWidth >= 1300;
  $("#tabs").innerHTML = TABS.map((t) => `<button class="${UI.tab === t.k ? "on" : ""}" data-tab="${t.k}">${wide ? t.l : t.s}</button>`).join("");
  $("#mtabs").innerHTML = TABS.filter((t) => t.m).map((t) => `<button class="${UI.tab === t.k ? "on" : ""}" data-tab="${t.k}">${t.m}</button>`).join("") +
    `<button class="${["stops", "market", "about"].includes(UI.tab) ? "on" : ""}" data-more>More</button>`;
  $$("[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $("[data-more]").onclick = () => {
    const m = $("#more");
    m.hidden = !m.hidden;
    m.innerHTML = TABS.filter((t) => !t.m).map((t) => `<button data-tab2="${t.k}">${t.l}</button>`).join("");
    $$("[data-tab2]").forEach((b) => (b.onclick = () => { m.hidden = true; showTab(b.dataset.tab2); }));
  };
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
  const narrow = innerWidth < 600;   // phones: fit the whole day on screen instead of scrolling sideways
  const rowH = 14, m = { l: narrow ? 112 : 150, r: 8, t: 22, b: 4 };
  const W = narrow ? el.clientWidth - 16 : Math.max(el.clientWidth - 16, 700), w = W - m.l - m.r;
  const x = d3.scaleLinear().domain([4 * 3600, 24.5 * 3600]).range([0, w]);
  const H = list.length * rowH + m.t + m.b;
  const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,-4)`).call(d3.axisTop(x).tickValues(d3.range(4, 25, narrow ? 4 : 2).map((h) => h * 3600)).tickFormat((t) => fmtH(t / 3600)));
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
      .text(narrow ? `${b.routes[0] || ""} #${b.v} ${Math.round(stuck(b) * 100)}%` : `#${b.v} · ${b.routes.slice(0, 2).join("/")} · ${Math.round(stuck(b) * 100)}%`);
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
  const data = await routeData(key);   // set state only once loaded, so a render never sees half of it
  sc.key = key; sc.route = routeByKey(key); sc.data = data;
  sc.info = stopInfo(sc.route);
  sc.removed.clear();
  fitLine(sc.route.line);
  if (fleet) fleet.update(UI.t);
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

  M.lines("stop-route", [{ coords: r.line, color: r.color, width: 5, opacity: 0.75 }]);
  M.points("stop-pts", st.map((s, i) => {
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
// ---------- Metro trunk: one line in the Market St subway ----------
const tk = {};
async function initTrunk() {
  DATA.trunk = DATA.trunk || await getJSON("data/trunk.json").catch(() => null);
  if (!DATA.trunk) { $("#tk-tiles").innerHTML = `<p class="muted">Run the pipeline to produce data/trunk.json.</p>`; return; }
  ["#tk-tph", "#tk-walk", "#tk-cv", "#tk-turn"].forEach((q) => $(q).addEventListener("input", renderTrunk));
  renderTrunk();
}
function renderTrunk() {
  const T = DATA.trunk; if (!T) return;
  const hour = Math.min(Math.max(clampHour(UI.hour), 6), 22), walk = +$("#tk-walk").value, cv = +$("#tk-cv").value, turn = +$("#tk-turn").value;
  const near = (obj, h) => obj?.[h] ?? obj?.[h + 1] ?? obj?.[h - 1];
  const vn = near(T.van_ness, hour) || [0, 0, 0];
  const todayTph = vn[0];
  const tph = +$("#tk-tph").value || todayTph;
  const headway = 60 / tph;
  const trunkWait = (headway / 2) * (1 + cv * cv);
  const pair = (a, b, h) => near(T.pairs[`${a}|${b}`], h);
  // per-line rider comparison to Montgomery (downtown)
  const dest = "Montgomery";
  const rows = T.lines.map((l) => {
    const app = near(l.approach_min, hour), today = near(l.to_station[dest], hour);
    if (!app || !today) return null;
    const merge = Math.max(app[0] - l.free_flow_min, 0);
    // portal -> transfer station (N/J still run through the Duboce tunnel to Van Ness)
    const toTr = near(l.to_station[l.transfer], hour);
    const legTr = toTr ? Math.max(toTr[0] - app[0], 0) : 0, legTr90 = toTr ? Math.max(toTr[1] - app[1], 0) : 0;
    const ride = pair(l.transfer, dest, hour);
    if (!ride) return null;
    const med = l.free_flow_min + legTr + walk + trunkWait + ride[0];
    const bad = l.free_flow_min + legTr90 + walk + headway + ride[1];
    return { l, merge, today, med, bad, dMed: med - today[0], dBad: bad - today[1] };
  }).filter(Boolean);
  // operator side over the whole day
  let mergeH = 0, freedH = 0, trunkH = 0;
  for (let h = 5; h < 24; h++) {
    for (const l of T.lines) {
      const n = l.trips_per_hour[h] || 0, app = near(l.approach_min, h), tr = pair(l.transfer, "Embarcadero", h);
      if (app) mergeH += (n * Math.max(app[0] - l.free_flow_min, 0)) / 60;
      if (tr) freedH += (n * 2 * tr[0]) / 60;                    // branch trains no longer run the subway, both ways
    }
    const v = T.van_ness[h], full = pair("West Portal", "Embarcadero", h);
    if (v && full) trunkH += (((+$("#tk-tph").value || v[0]) * (2 * full[0] + 2 * turn)) / 60);
  }
  const fmt = (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(1)} min`;
  $("#tk-tiles").innerHTML = [
    ["Subway trains/hour", `${todayTph} → ${Math.round(tph)}`, `inbound at Van Ness, ${fmtH(hour)} · today 5 lines, then one`],
    ["Wait for a train in the subway", `${vn[2].toFixed(1)} → ${trunkWait.toFixed(1)} min`, `today's gaps average ${vn[1].toFixed(1)} min but bunch; an even trunk shrinks the wait`],
    ["Queueing at portals removed", `${mergeH.toFixed(0)} h/day`, "train-hours merging at West Portal & Duboce"],
    ["Train-hours per weekday", `${freedH - trunkH >= 0 ? "−" : "+"}${Math.abs(freedH - trunkH).toFixed(0)}`, `branches stop running the subway (${freedH.toFixed(0)} h) vs the trunk itself (${trunkH.toFixed(0)} h)`],
  ].map(([l, v, d]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
  $("#tk-table").innerHTML = rows.map((x) => `<div class="cmp-row">
      <div class="cmp-head"><span class="rb" style="background:${routeByKeyFast(x.l.key)?.color || "#666"}">${x.l.route}</span>
        <span>transfer at ${x.l.transfer}</span><span class="muted">merge ${x.merge.toFixed(1)} min today</span></div>
      <div class="cmp-body"><span>to ${dest}: <b>${x.today[0].toFixed(1)}</b> → <b>${x.med.toFixed(1)}</b> min</span>
        <span class="dl"><span class="muted">typical</span> <span class="${x.dMed <= 0 ? "pos" : "neg"}">${fmt(x.dMed)}</span></span>
        <span class="dl"><span class="muted">bad day</span> <span class="${x.dBad <= 0 ? "pos" : "neg"}">${fmt(x.dBad)}</span></span></div></div>`).join("");
  $("#tk-notes").innerHTML = `<b>How to read this.</b> A rider starting ${T.lines[0]?.approach_m || 400} m before their line's tunnel portal, headed to ${dest}, at ${fmtH(hour)}.
    <i>Today</i>: ride straight through, including the queue to merge at the portal (median / 90th percentile, measured).
    <i>With trunk</i>: ride the branch at free-flow speed to the transfer station (no merge queue), walk ${walk} min to the trunk platform, wait for a trunk train (half its headway, adjusted for regularity; a full headway on a bad day), then the measured subway ride.
    Not modeled: whether one line's trains can carry everyone (longer trains or more frequent service would be needed at peak), new turnback tracks at West Portal and Van Ness, and the comfort cost of transferring.`;
  // map: trunk + branches ending at their transfer stations
  const trunkLine = routeByKeyFast("K_1"), wp = DATA.trunk.lines.find((l) => l.route === "K");
  M.lines("tk-trunk", trunkLine && wp ? [{ coords: trunkLine.line.filter((p) => p[2] >= wp.station_d["West Portal"] - 5 && p[2] <= wp.station_d.Embarcadero + 5),
    color: css("--accent"), width: 7, opacity: 0.95, tip: `<b>Trunk</b>: Embarcadero ↔ West Portal, ${Math.round(tph)} trains/h` }] : []);
  M.lines("tk-branch", T.lines.map((l) => {
    const r = routeByKeyFast(l.key), end = l.station_d[l.transfer] ?? l.entry_d;
    return r ? { coords: r.line.filter((p) => p[2] <= end), color: r.color, width: 3.5, opacity: 0.9, tip: `<b>${l.route}</b> ends at ${l.transfer}; riders transfer to the trunk` } : null;
  }).filter(Boolean));
  const transfers = new Set(T.lines.map((l) => l.transfer));
  M.points("tk-st", Object.entries(T.station_ll).map(([n, ll]) => ({ lat: ll[0], lon: ll[1], radius: transfers.has(n) ? 7 : 4.5,
    fill: css("--surface"), stroke: transfers.has(n) ? css("--accent") : css("--text"), strokeWidth: transfers.has(n) ? 3 : 1.5,
    tip: `${n}${transfers.has(n) ? " · transfer station" : ""}` })));
}

function initMarket() {
  initTrunk();
  const MK = DATA.market;
  // One card per route (pairing both directions).
  mk.routes = d3.groups(MK.routes.filter((r) => ["7", "9R", "5R", "F"].includes(r.route) || r.on_market_m > 1500), (r) => r.route)
    .map(([route, dirs]) => ({ route, inb: dirs.find((d) => d.inbound), outb: dirs.find((d) => !d.inbound) }))
    .filter((r) => r.inb && r.outb);
  // The F is itself the Market St line, so cutting it mostly deletes it: off by default.
  mk.routes.forEach((r) => { if (r.route !== "F") mk.on.add(r.route); mk.station[r.route] = r.inb.stations[0] === "Castro" ? "Church" : r.inb.stations[0]; });
  ["#mk-walk", "#mk-penalty", "#mk-turn"].forEach((s) => $(s).addEventListener("input", renderMarket));
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
  const MK = DATA.market, hour = Math.min(Math.max(clampHour(UI.hour), 6), 22);
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
        const sched = MK.subway.in?.[`${S}|${X}`]?.[hour];          // [trains/h, min]
        const obs = MK.subway_obs?.in?.[`${S}|${X}`]?.[hour];        // [median, p90, n, trains/h]
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
  M.lines("mk-kept", kept);
  M.lines("mk-cut", cut, { dash: [2, 2] });
  M.points("mk-st", Object.entries(MK.station_ll).map(([n, ll]) => ({
    lat: ll[0], lon: ll[1], radius: 6, fill: css("--surface"), stroke: css("--text"), strokeWidth: 2, tip: `${n} (Muni Metro)` })));
  const active = rows.filter((x) => mk.on.has(x.route));
  const winners = active.filter((x) => x.net < 0).length;
  $("#mk-tiles").innerHTML = [
    ["Bus-hours freed per weekday", totHours.toFixed(0), "for the routes checked"],
    ["≈ buses freed at this hour", totBuses.toFixed(1), "to redeploy on the rest of each route"],
    ["Downtown trips faster by subway", `${winners} / ${active.length}`, "origin–destination pairs, incl. frequency gain"],
  ].map(([l, v, d]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
  $("#mk-table").innerHTML = active.length ? `<div class="hrow"><h3 style="font-size:14px">Riders headed downtown</h3><span class="muted">stay on the bus vs transfer</span></div>` +
    active.map((x) => `<div class="cmp-row"><div class="cmp-head"><span class="rb" style="background:${routeColor(x.route)}">${x.route}</span><span>${x.S} → ${x.X}</span></div>
      <div class="cmp-body"><span>bus <b>${fmtMin(x.bus)}</b> · subway <b>${(x.via).toFixed(1)} min</b></span>
      <span class="${x.net < 0 ? "pos" : "neg"}">${x.net > 0 ? "+" : ""}${x.net.toFixed(1)} min</span><span class="muted">walk ${walk} + wait ${x.wait.toFixed(1)} + ride ${x.sub.toFixed(1)}</span></div></div>`).join("")
    : `<p class="muted">Select a route to see rider impacts.</p>`;
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
  if (!DATA.sig) { $("#p-signals").innerHTML = "<p>No signal data. Run the pipeline with data/signals/traffic_signals.json.</p>"; return; }
  ["#sig-hour", "#sig-rank"].forEach((id) => $(id).addEventListener("change", renderSignals));
  const labels = ["<5", "5–10", "10–15", "15–20", "20–30", "30–45", "45+"];
  $("#sig-legend").innerHTML = `<span>circle = time held · color = seconds per vehicle:</span>` +
    labels.map((l, i) => `<span><i style="background:${SPEED_RAMP[SPEED_RAMP.length - 1 - i]};border-radius:50%"></i>${l}</span>`).join("");
  renderSignals();
}
function renderSignals() {
  if (!DATA.sig) return;
  // mode comes from the chips; "Clock hour" follows the timeline
  const mode = UI.mode === "all" ? "" : UI.mode, rank = $("#sig-rank").value;
  const hour = $("#sig-hour").value === "clock" ? String(clampHour(UI.hour)) : "";
  const rows = DATA.sig.signals.map((o) => ({ o, ...sigStats(o, mode, hour) }))
    .filter((r) => r.hours > 0.005 && (rank !== "wait" || r.passes >= (hour === "" ? 40 : 3)));
  rows.sort(rank === "wait" ? (a, b) => b.wait - a.wait : (a, b) => b.hours - a.hours);
  const tot = sum(rows.map((r) => r.hours));
  const when = hour === "" ? "per weekday" : `${fmtH(+hour)}–${fmtH(+hour + 1)}`;
  $("#sig-mode-l").textContent = CHIP_MODES.find((m) => m[0] === UI.mode)[1].toLowerCase();
  $("#sig-when-l").textContent = hour === "" ? "all day" : when;
  $("#sig-headline").textContent = `${SUBJECT[UI.mode][0]} ${hour === "" ? "waits" : "wait"} ${tot >= 10 ? tot.toFixed(0) : tot.toFixed(1)} hours ${hour === "" ? "a day" : "this hour"} at red lights.`;
  $("#sig-tiles").innerHTML = [
    ["Signals that hold transit", rows.length.toLocaleString(), `of ${DATA.sig.n_signals.toLocaleString()} in SF`],
    ["Worst 20 signals", `${Math.round((100 * sum(rows.slice(0, 20).map((r) => r.hours))) / (tot || 1))}%`, "of all signal delay"],
  ].map(([l, v, d]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
  $("#sig-unit").textContent = rank === "wait" ? "avg seconds per vehicle" : `vehicle-hours ${hour === "" ? "/ day" : when}`;

  const max = d3.max(rows, (r) => r.hours) || 1;
  sg.rows = rows;
  // small first so big circles draw on top
  M.points("sig", [...rows].reverse().map((r) => ({
    lat: r.o.lat, lon: r.o.lon, radius: 2.5 + 16 * Math.sqrt(r.hours / max), strokeWidth: sg.shown === r.o ? 3 : 1,
    stroke: sg.shown === r.o ? css("--text") : css("--surface"),
    fill: waitColor(r.wait), fillOpacity: 0.9, onClick: () => pickSignal(r.o),
    tip: `<b>${r.o.name}</b><br>${r.hours.toFixed(2)} vehicle-h held ${when}<br>avg ${r.wait.toFixed(0)} s per vehicle · ${Math.round(r.passes)} passes/day` })));
  const box = $("#sig-list");
  box.innerHTML = "";
  rows.slice(0, 50).forEach((r, n) => {
    const routes = [...new Set(r.apps.map((a) => a.route))];
    const el = document.createElement("div");
    el.className = "hot-row" + (sg.shown === r.o ? " sel" : "");
    el.innerHTML = `<div class="rk">${String(n + 1).padStart(2, "0")}</div>
      <div><div class="nm">${r.o.name}</div><div class="sb">avg ${r.wait.toFixed(0)} s per vehicle · ${Math.round(r.passes)} passes/day${r.o.near_side_hours > 0.3 ? ` · +${r.o.near_side_hours.toFixed(1)} h at a near-side stop` : ""}</div></div>
      <div class="hh">${rank === "wait" ? r.wait.toFixed(0) + "s" : r.hours.toFixed(1)}</div><div></div>
      <div class="bot"><div class="badges">${routes.slice(0, 7).map((x) => `<span class="rb" style="background:${routeColor(x)}">${x}</span>`).join("")}</div></div>`;
    el.onclick = () => pickSignal(r.o);
    box.appendChild(el);
  });
  if (!sg.shown && rows[0]) showSignal(rows[0].o);
}
function pickSignal(o) {
  showSignal(o);
  renderSignals();
  sg.flown = true;
  if (!isDesk()) { UI.sheetH = snaps()[1]; applyLayout(false); }
  $("#sig-detail").scrollIntoView({ block: "nearest", behavior: "smooth" });
  M.map.flyTo({ center: [o.lon, o.lat], zoom: 16, padding: padding(), duration: 900 });
}
function showSignal(o) {
  sg.shown = o;
  const el = $("#sig-detail");
  el.innerHTML = `<div class="detail"><h4>${o.name}</h4>
    <div class="muted">${o.veh_hours.toFixed(1)} vehicle-hours held per weekday · ${Math.round(o.passes)} bus/train passes · avg ${o.avg_wait_s.toFixed(0)} s each${o.near_side_hours > 0.05 ? ` · plus ${o.near_side_hours.toFixed(1)} h at a near-side stop` : ""}</div>
    <div id="sig-hours"></div>
    <div class="apps">${o.approaches.map((a) => `<div><span class="rb" style="background:${routeColor(a.route)}">${a.route}</span><span>to ${a.headsign}</span><b>${a.wait_s.toFixed(0)} s</b><span class="muted">${Math.round(a.passes)}/day</span></div>`).join("")}</div></div>`;
  // hourly profile
  const box = $("#sig-hours"), W = box.clientWidth || 330, H = 90, m = { l: 30, r: 4, t: 8, b: 18 };
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
// pages that are just content (no map) vs pages that live on the shared map
const LEGACY = { buses: initBuses, about: initAbout };
const MAP_TABS = { city: null, route: null, signals: initSignals, stops: initStops, market: initMarket };
const mapInited = {};
// vehicles shown on the Market St page: the Metro lines in the scenario + the Market St bus routes
const MARKET_ROUTES = new Set(["J", "K", "L", "M", "N", "5R", "7", "9R", "F"]);
// which shared-map layers each page shows (vehicles are always drawn on the overlay)
const TAB_LAYERS = {
  city: ["glow", "speed", "hot"], route: ["speed"], signals: ["sig"], stops: ["stop-route", "stop-pts"],
  market: ["tk-branch", "tk-trunk", "mk-kept", "mk-cut", "tk-st", "mk-st"],
};
const ALL_LAYERS = [...new Set(Object.values(TAB_LAYERS).flat())];
function showLayers(tab) {
  if (!M?.loaded) { M?.ready.then(() => showLayers(UI.tab)); return; }
  for (const n of ALL_LAYERS) {
    const id = `set-${n}`;
    if (M.map.getLayer(id)) M.map.setLayoutProperty(id, "visibility", TAB_LAYERS[tab]?.includes(n) ? "visible" : "none");
  }
}
// Frame each map page in the part of the map you can actually see (between the top
// controls and the side panel / bottom sheet).
const SF_BOUNDS = [[-122.515, 37.708], [-122.357, 37.812]];
const boundsOf = (line) => { const lats = line.map((p) => p[0]), lons = line.map((p) => p[1]); return [[d3.min(lons), d3.min(lats)], [d3.max(lons), d3.max(lats)]]; };
function viewBounds(tab = UI.tab) {
  if (tab === "route" && rt.route) return boundsOf(rt.route.line);
  if (tab === "stops" && sc.route) return boundsOf(sc.route.line);
  if (tab === "market") { const k = routeByKeyFast("K_1"); if (k) return boundsOf(k.line.filter((p) => p[2] >= 3800)); }
  return SF_BOUNDS;
}
function fitView(duration = 700) {
  if (!M || !(UI.tab in MAP_TABS)) return;
  M.ready.then(() => {
    M.map.setPadding(padding());
    M.map.fitBounds(viewBounds(), { padding: isDesk() ? 30 : 12, duration, maxZoom: 14.5 });
  });
}
const fitLine = () => fitView();
function showTab(k) {
  UI.tab = k;
  try { localStorage.setItem("tab", k); } catch (e) {}
  if (location.hash.slice(1) !== k) history.replaceState(null, "", "#" + k);
  $("#more").hidden = true;
  drawTabs();
  const onMap = k in MAP_TABS;
  $("#page").hidden = onMap;
  document.getElementById("app").classList.toggle("page-mode", !onMap);   // content pages: solid background, no map
  $("#panel").hidden = !onMap;
  $("#chips").hidden = !(k === "city" || k === "signals");               // mode filter only where it applies
  $$(".legend").forEach((el) => (el.style.visibility = k === "city" || k === "route" ? "" : "hidden"));
  $$(".timeline").forEach((el) => (el.style.visibility = onMap ? "" : "hidden"));
  for (const t of Object.keys(MAP_TABS)) $(`#p-${t}`).hidden = t !== k;
  $("#panel .panel-body").scrollTop = 0;
  if (!onMap) {
    $$("#page .tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${k}`));
    if (!legacyInited[k]) { legacyInited[k] = true; LEGACY[k](); }
    return;
  }
  showLayers(k);
  if (MAP_TABS[k] && !mapInited[k]) { mapInited[k] = true; MAP_TABS[k](); }
  if (fleet) fleet.update(UI.t);
  if (k === "city") {
    drawSpeed(); UI.selHot = null; drawHotspots();
    fitView();
  } else if (k === "route") {
    drawSpeed();
    if (!rt.key) loadRoute(rt.startKey); else { drawRoutePanel(); loadRoute(rt.key); }
  } else if (k === "signals") {
    sg.flown = false;
    renderSignals();
    fitView();
  } else if (k === "stops") {
    if (sc.data) { renderStops(); fitLine(sc.route.line); }
  } else if (k === "market") {
    if (DATA.trunk) renderTrunk();
    if (mk.routes) renderMarket();
    fitView();   // the whole trunk, West Portal to Embarcadero
  }
}
const legacyInited = {};

async function main() {
  const [net, hot, veh, market, calib] = await Promise.all(
    ["network", "hotspots", "vehicles", "market", "calibration"].map((n) => getJSON(`data/${n}.json`)));
  Object.assign(DATA, { net, hot, veh, market, calib });
  [DATA.sig, DATA.heat, DATA.budget] = await Promise.all(
    ["signals", "heat_all", "fleet_budget"].map((n) => getJSON(`data/${n}.json`).catch(() => null)));
  const day = new Date(net.sample_day + "T12:00");
  const nDays = net.days.length;
  $$(".subtitle").forEach((el) => (el.textContent = `${nDays === 1 ? "One weekday" : nDays + " weekdays"} of GPS · ${day.toLocaleString("en-US", { month: "short", year: "numeric" })}`));
  $("#legend-ramp").innerHTML = SPEED_RAMP.map((c) => `<span style="background:${c}"></span>`).join("");

  // one map for City + Route
  M = makeMap("map", { center: [37.775, -122.435], zoom: isDesk() ? 13.3 : 12.6, nav: false });
  M.lines("glow", [], { blur: 6 }); M.lines("speed", []);
  M.lines("stop-route", []); M.lines("tk-branch", []); M.lines("tk-trunk", []); M.lines("mk-kept", []); M.lines("mk-cut", [], { dash: [2, 2] });
  M.points("hot", []); M.points("sig", []); M.points("stop-pts", []); M.points("tk-st", []); M.points("mk-st", []);
  M.symbols("fleet", []);
  M.ready.then(() => showLayers(UI.tab));
  M.ready.then(() => M.map.setPadding(padding()));
  // City: filter by the mode chip. Route: just the chosen route (mode chip doesn't apply).
  fleet = makeFleetLayer(M, { filter: (mode, label) =>
    UI.tab === "route" ? label === undefined || label === rt.key
    : UI.tab === "stops" ? label === undefined || label === sc.key
    : UI.tab === "market" ? label === undefined || MARKET_ROUTES.has((label || "").split("_")[0])
    : modeOk(mode) });

  rt.startKey = makeRoutePicker($("#route-select"), $("#route-dir"), (k) => loadRoute(k), "38R_0");
  drawChips(); setupTimeline(); setupSheet(); applyLayout();
  addEventListener("resize", () => { applyLayout(); drawTabs(); });
  setTime(UI.t);
  drawCityStats();

  let start = location.hash.slice(1);
  if (!TABS.some((t) => t.k === start)) { try { start = localStorage.getItem("tab") || "city"; } catch (e) { start = "city"; } }
  showTab(TABS.some((t) => t.k === start) ? start : "city");
}
main();
