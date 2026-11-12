// app.js: figures out what's up tonight and lets you play with the sky.
// Data: window.SKY_DATA (open-source d3-celestial / Hipparcos star catalogue)
// API:  Open-Meteo forecast API (free, no key) for hourly cloud cover

const { constellations, stars } = window.SKY_DATA;

const CITIES = [
  { name: "Berkeley, CA", lat: 37.8716, lon: -122.2727, tz: "America/Los_Angeles" },
  { name: "Santa Clarita, CA", lat: 34.3917, lon: -118.5426, tz: "America/Los_Angeles" },
  { name: "Joshua Tree, CA", lat: 33.8734, lon: -115.901, tz: "America/Los_Angeles" },
  { name: "Mauna Kea, HI", lat: 19.8207, lon: -155.4681, tz: "Pacific/Honolulu" },
  { name: "New York, NY", lat: 40.7128, lon: -74.006, tz: "America/New_York" },
  { name: "London, UK", lat: 51.5072, lon: -0.1276, tz: "Europe/London" },
  { name: "Atacama Desert, Chile", lat: -22.9087, lon: -68.1997, tz: "America/Santiago" },
  { name: "Sydney, Australia", lat: -33.8688, lon: 151.2093, tz: "Australia/Sydney" },
];

const $ = (id) => document.getElementById(id);
const famous = (c) => c.rank <= 2 || window.FACTS[c.id];

const state = {
  place: CITIES[0],
  nightIdx: 0,
  night: null,
  time: null,
  selected: null,   // clicked constellation (Explore mode)
  hover: null,      // constellation under the mouse
  clouds: null,
  mode: "explore",  // "explore" or "play"
  game: { target: null, score: 0, streak: 0, misses: 0, solved: false, msg: "" },
};

// ---------- time helpers ----------
function tzOffsetMin(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime()) / 60000;
}
function localNoon(tz, dayOffset) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const guess = Date.UTC(+p.year, +p.month - 1, +p.day + dayOffset, 12);
  return guess - tzOffsetMin(tz, new Date(guess)) * 60000;
}
const fmtTime = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: state.place.tz, hour: "numeric", minute: "2-digit" }).format(ms);
const fmtDay = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: state.place.tz, weekday: "short" }).format(ms);

// Where is a constellation's center at a given moment?
const posAt = (c, t) => Astro.toAltAz(c.ra, c.dec, state.place.lat, Astro.lst(new Date(t), state.place.lon));

// ---------- the core calculation ----------
// Sample the night every 10 min, find the dark hours (Sun 12°+ below the horizon),
// and for each constellation find when it's highest.
function computeNight(place, dayOffset) {
  const start = localNoon(place.tz, dayOffset), samples = [];
  for (let t = start; t <= start + 24 * 3600e3; t += 10 * 60e3) {
    const lst = Astro.lst(new Date(t), place.lon), s = Astro.sun(new Date(t));
    samples.push({ t, lst, sunAlt: Astro.toAltAz(s.ra, s.dec, place.lat, lst).alt });
  }
  let lim = -12;
  for (lim of [-12, -6, 0, 91]) if (samples.some((s) => s.sunAlt < lim)) break;   // summer near the poles
  const dark = samples.filter((s) => s.sunAlt < lim);
  const night = { start, darkStart: dark[0].t, darkEnd: dark[dark.length - 1].t, darkLimit: lim };
  night.moon = Astro.moon(new Date((night.darkStart + night.darkEnd) / 2));
  night.cons = constellations.map((c) => {
    let best = { alt: -90, t: 0, az: 0 };
    for (const s of dark) { const p = Astro.toAltAz(c.ra, c.dec, place.lat, s.lst); if (p.alt > best.alt) best = { ...p, t: s.t }; }
    return { ...c, maxAlt: best.alt, bestTime: best.t, bestAz: best.az };
  });
  return night;
}

const compass = (az) => ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(az / 45) % 8];
function lookPhrase(alt, az) {
  if (alt > 75) return "straight overhead";
  if (alt > 45) return `high in the ${compass(az)}`;
  if (alt > 20) return `partway up in the ${compass(az)}`;
  return `low in the ${compass(az)}`;
}

// ---------- clouds (Open-Meteo API) ----------
async function loadClouds() {
  state.clouds = null; renderStatus();
  const { lat, lon } = state.place;
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloud_cover&timezone=GMT&forecast_days=8`);
    const j = await res.json();
    state.clouds = {};
    j.hourly.time.forEach((iso, i) => (state.clouds[Date.parse(iso + ":00Z")] = j.hourly.cloud_cover[i]));
  } catch { state.clouds = "offline"; }
  renderNights(); renderStatus();
}
function avgCloud(n) {
  if (!state.clouds || state.clouds === "offline") return null;
  const v = [];
  for (let t = Math.floor(n.darkStart / 3600e3) * 3600e3; t <= n.darkEnd; t += 3600e3) if (state.clouds[t] != null) v.push(state.clouds[t]);
  return v.length ? v.reduce((a, b) => a + b) / v.length : null;
}

// ---------- top bar: nights + status ----------
function renderNights() {
  const wrap = $("nights"); wrap.innerHTML = "";
  for (let i = 0; i < 7; i++) {
    const start = localNoon(state.place.tz, i);
    const m = Astro.moon(new Date(start + 12 * 3600e3));
    const b = document.createElement("button");
    b.className = "pill" + (i === state.nightIdx ? " on" : "");
    b.textContent = `${i === 0 ? "Tonight" : fmtDay(start)} ${Astro.moonEmoji(m)}`;
    b.onclick = () => { state.nightIdx = i; recompute(); };
    wrap.appendChild(b);
  }
}
function renderStatus() {
  const n = state.night; if (!n) return;
  const cloud = avgCloud(n), moonPct = Math.round(n.moon.illum * 100);
  const score = 100 - (cloud ?? 0) * 0.9 - n.moon.illum * 35;
  const [label, cls] = score >= 75 ? ["Great night ✨", "great"] : score >= 50 ? ["Decent night", "ok"] : ["Rough night", "bad"];
  $("status").innerHTML = `<span class="badge ${cls}">${label}</span>
    <span>${Astro.moonEmoji(n.moon)} ${moonPct}% Moon</span>
    <span>☁️ ${cloud != null ? Math.round(cloud) + "% clouds" : state.clouds === "offline" ? "clouds n/a" : "…"}</span>
    <span>🌌 dark ${fmtTime(n.darkStart)}–${fmtTime(n.darkEnd)}</span>`;
}

// ---------- side card ----------
function renderCard() {
  const card = $("card");
  if (state.mode === "play") return renderGame();

  const c = state.night.cons.find((x) => x.id === state.selected);
  if (c) {
    const now = posAt(c, state.time);
    card.innerHTML = `<div class="kicker">${now.alt > 0 ? "Up right now" : "Below the horizon right now"}</div>
      <h2>${c.name}</h2>
      ${window.FACTS[c.id] ? `<p>${window.FACTS[c.id]}</p>` : ""}
      <p class="where">🧭 Best around <b>${fmtTime(c.bestTime)}</b>, ${lookPhrase(c.maxAlt, c.bestAz)}.</p>
      <div class="row"><button class="ghost" id="jump">⏩ Jump to its best time</button><button class="ghost" id="close">✕</button></div>`;
    $("jump").onclick = () => setTime(c.bestTime);
    $("close").onclick = () => select(null);
    return;
  }
  // nothing selected: show what's up right now as tappable chips
  const up = state.night.cons.map((x) => ({ ...x, now: posAt(x, state.time) }))
    .filter((x) => x.now.alt > 15 && famous(x)).sort((a, b) => b.now.alt - a.now.alt);
  card.innerHTML = `<div class="kicker">Up at ${fmtTime(state.time)}</div>
    <h2>${up.length} constellations</h2>
    <p class="muted">Hover over the sky to see names, or tap one:</p>
    <div class="chips">${up.map((x) => `<button class="chip" data-id="${x.id}">${x.name}</button>`).join("")}</div>`;
  card.querySelectorAll(".chip").forEach((b) => {
    b.onclick = () => select(b.dataset.id);
    b.onmouseenter = () => { state.hover = b.dataset.id; drawSky(); };
    b.onmouseleave = () => { state.hover = null; drawSky(); };
  });
}

// ---------- game: "Find it!" ----------
function newTarget() {
  const pool = state.night.cons.filter((c) => famous(c) && posAt(c, state.time).alt > 25 && c.id !== state.game.target);
  const g = state.game;
  g.target = pool.length ? pool[Math.floor(Math.random() * pool.length)].id : null;
  g.misses = 0; g.solved = false; g.msg = "";
  renderCard(); drawSky();
}
function renderGame() {
  const g = state.game, t = state.night.cons.find((c) => c.id === g.target);
  $("card").innerHTML = `<div class="kicker">Find it! · score ${g.score} · 🔥 ${g.streak}</div>
    ${t ? `<h2>Where's ${t.name}?</h2>` : `<h2>Nothing up to find</h2><p class="muted">Try a later time.</p>`}
    <p class="muted">Labels are hidden. Click it on the map.</p>
    <p class="feedback ${g.solved ? "good" : ""}">${g.msg}</p>
    <div class="row">${g.solved || g.misses >= 3 ? `<button class="primary" id="next">Next →</button>` : `<button class="ghost" id="skip">Give up</button>`}</div>`;
  ($("next") || $("skip")).onclick = () => {
    if ($("skip")) { g.misses = 3; g.streak = 0; g.msg = `Here it is! ${hintFor(t)}`; renderCard(); drawSky(); }
    else newTarget();
  };
}
const hintFor = (t) => (t ? `It's ${lookPhrase(posAt(t, state.time).alt, posAt(t, state.time).az)}.` : "");
function guess(id) {
  const g = state.game, t = state.night.cons.find((c) => c.id === g.target);
  if (!t || g.solved || g.misses >= 3) return;
  if (id === g.target) {
    g.solved = true; g.score++; g.streak++;
    g.msg = `✅ Nice! ${window.FACTS[t.id] ? window.FACTS[t.id].split(". ")[0] + "." : ""}`;
  } else {
    g.misses++; g.streak = 0;
    const wrong = state.night.cons.find((c) => c.id === id);
    g.msg = g.misses >= 3 ? `Here it is! ${hintFor(t)}` : `❌ That's ${wrong ? wrong.name : "empty sky"}. ${g.misses === 2 ? "Hint: " + hintFor(t) : "Try again!"}`;
  }
  renderCard(); drawSky();
}

// ---------- sky map ----------
// Stereographic projection: the point overhead is the center, the horizon is the circle.
// North at top, East on the LEFT (how the sky looks lying on your back, head to the north).
const canvas = $("sky"), ctx = canvas.getContext("2d");
let geom = { cx: 0, cy: 0, R: 0 }, hitSegs = [], hitCenters = [];

function project(alt, az) {
  const r = geom.R * Math.tan(((90 - alt) * Math.PI) / 360), a = (az * Math.PI) / 180;
  return { x: geom.cx - r * Math.sin(a), y: geom.cy - r * Math.cos(a) };
}
const starColor = (bv) => bv < 0 ? "#b9ccff" : bv < 0.3 ? "#e2e9ff" : bv < 0.6 ? "#fff8ea" : bv < 1 ? "#ffe6b3" : bv < 1.4 ? "#ffcc8a" : "#ffae73";

let frame = null;
const requestDraw = () => frame || (frame = requestAnimationFrame(() => { frame = null; drawSky(); }));

function drawSky() {
  const dpr = window.devicePixelRatio || 1, size = canvas.clientWidth;
  if (canvas.width !== Math.round(size * dpr)) { canvas.width = canvas.height = Math.round(size * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  geom = { cx: size / 2, cy: size / 2, R: size / 2 - 22 };
  const { cx, cy, R } = geom, { lat, lon } = state.place;
  const date = new Date(state.time), lst = Astro.lst(date, lon);
  const play = state.mode === "play", g = state.game;
  const revealed = play && (g.solved || g.misses >= 3);

  ctx.clearRect(0, 0, size, size);
  const s = Astro.sun(date), sunAlt = Astro.toAltAz(s.ra, s.dec, lat, lst).alt;
  const glow = Math.max(0, Math.min(1, (sunAlt + 18) / 18));   // twilight brightens the sky
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  grad.addColorStop(0, `rgb(${8 + glow * 30},${10 + glow * 40},${28 + glow * 70})`);
  grad.addColorStop(1, `rgb(${18 + glow * 60},${24 + glow * 60},${54 + glow * 80})`);
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.fill(); ctx.clip();

  // constellation lines (and remember them for hover/click detection)
  hitSegs = []; hitCenters = [];
  for (const c of state.night.cons) {
    let color = "rgba(130,160,255,0.28)", width = 1;
    if (c.id === state.hover) { color = "rgba(190,210,255,0.95)"; width = 2; }
    if (!play && c.id === state.selected) { color = "#ffd27a"; width = 2.5; }
    if (revealed && c.id === g.target) { color = g.solved ? "#7ef0ad" : "#ffd27a"; width = 3; }
    ctx.strokeStyle = color; ctx.lineWidth = width;
    for (const seg of c.lines) {
      let prev = null;
      ctx.beginPath();
      for (const [ra, dec] of seg) {
        const p = Astro.toAltAz(ra, dec, lat, lst);
        if (p.alt < -2) { prev = null; continue; }
        const q = project(p.alt, p.az);
        if (prev) { ctx.lineTo(q.x, q.y); hitSegs.push({ id: c.id, a: prev, b: q }); } else ctx.moveTo(q.x, q.y);
        prev = q;
      }
      ctx.stroke();
    }
    const p = Astro.toAltAz(c.ra, c.dec, lat, lst);
    if (p.alt > 0) hitCenters.push({ id: c.id, ...project(p.alt, p.az) });
  }

  // stars
  for (const [ra, dec, mag, bv] of stars) {
    const p = Astro.toAltAz(ra, dec, lat, lst);
    if (p.alt < 0) continue;
    const ext = p.alt < 15 ? (15 - p.alt) / 15 : 0;            // more air near the horizon = dimmer
    const q = project(p.alt, p.az);
    ctx.globalAlpha = Math.max(0.25, 1 - ext * 0.6) * (1 - glow * 0.8);
    ctx.fillStyle = starColor(bv);
    ctx.beginPath(); ctx.arc(q.x, q.y, Math.max(0.45, 3.3 - 0.55 * (mag + ext * 1.2)), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Moon
  const m = Astro.moon(date), mp = Astro.toAltAz(m.ra, m.dec, lat, lst);
  if (mp.alt > 0) {
    const q = project(mp.alt, mp.az);
    const halo = ctx.createRadialGradient(q.x, q.y, 2, q.x, q.y, 45);
    halo.addColorStop(0, `rgba(255,250,225,${0.4 * m.illum + 0.05})`); halo.addColorStop(1, "rgba(255,250,225,0)");
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(q.x, q.y, 45, 0, Math.PI * 2); ctx.fill();
    ctx.font = "22px serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(Astro.moonEmoji(m), q.x, q.y);
  }

  // labels: only famous ones in Explore, none in Play (that's the game!)
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const h of hitCenters) {
    const c = state.night.cons.find((x) => x.id === h.id);
    const show = play ? revealed && c.id === g.target : c.rank === 1 || c.id === state.selected;
    if (!show) continue;
    const hl = c.id === state.selected || (play && c.id === g.target);
    ctx.font = hl ? "600 14px 'Space Grotesk', sans-serif" : "11px 'Space Grotesk', sans-serif";
    ctx.fillStyle = hl ? "#ffd27a" : "rgba(170,190,255,0.75)";
    ctx.fillText(c.name.toUpperCase(), h.x, h.y);
  }
  ctx.restore();

  // horizon + compass
  ctx.strokeStyle = "rgba(170,190,255,0.5)"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#cfd8ff"; ctx.font = "600 13px 'Space Grotesk', sans-serif";
  for (const [lab, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
    const a = (az * Math.PI) / 180; ctx.fillText(lab, cx - (R + 12) * Math.sin(a), cy - (R + 12) * Math.cos(a));
  }
  $("clock").textContent = fmtTime(state.time) + (sunAlt > state.night.darkLimit ? " · twilight" : "");
}

// Which constellation is at (x, y)? Closest line within 14px, else closest center within 40px.
function hitTest(x, y) {
  let best = null, bd = 14;
  for (const { id, a, b } of hitSegs) {
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L));
    const d = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
    if (d < bd) { bd = d; best = id; }
  }
  if (best) return best;
  bd = 40;
  for (const h of hitCenters) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h.id; } }
  return best;
}

// ---------- mouse / touch: hover to identify, drag to turn time, click to select ----------
const tip = $("tip");
let drag = null;
const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, t: state.time, moved: false }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => {
  const p = local(e);
  if (drag) {
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 4) drag.moved = true;
    if (drag.moved) { setTime(drag.t + dx * 90e3, true); canvas.style.cursor = "grabbing"; tip.hidden = true; return; } // 1 px = 1.5 min
  }
  const id = hitTest(p.x, p.y);
  if (id !== state.hover) { state.hover = id; requestDraw(); }
  const c = id && state.night.cons.find((x) => x.id === id);
  if (c && state.mode === "explore") {
    tip.hidden = false; tip.textContent = c.name;
    tip.style.left = p.x + 14 + "px"; tip.style.top = p.y + 10 + "px";
  } else tip.hidden = true;
});
canvas.addEventListener("pointerup", (e) => {
  canvas.style.cursor = "";
  if (drag && !drag.moved) {
    const p = local(e), id = hitTest(p.x, p.y);
    state.mode === "play" ? guess(id) : select(id);
  }
  if (drag?.moved) renderCard();
  drag = null;
});
canvas.addEventListener("pointerleave", () => { state.hover = null; tip.hidden = true; requestDraw(); });

// ---------- controls ----------
function setTime(t, fromDrag = false) {
  const sl = $("time");
  state.time = Math.max(+sl.min, Math.min(+sl.max, t));
  sl.value = state.time;
  requestDraw();
  if (!fromDrag) renderCard();
}
function select(id) { state.selected = id; renderCard(); drawSky(); }

function recompute() {
  state.night = computeNight(state.place, state.nightIdx);
  const n = state.night, now = Date.now(), sl = $("time");
  sl.min = n.darkStart - 3600e3; sl.max = n.darkEnd; sl.step = 5 * 60e3;
  state.time = now > +sl.min && now < n.darkEnd ? now : Math.max(n.start + 9 * 3600e3, n.darkStart);  // now, or 9 PM
  if (state.time > n.darkEnd) state.time = n.darkStart;
  sl.value = state.time;
  renderNights(); renderStatus();
  if (state.mode === "play") newTarget(); else renderCard();
  drawSky();
}
function setPlace(place) {
  state.place = place; state.nightIdx = 0; state.selected = null;
  recompute(); loadClouds();
}

CITIES.forEach((c, i) => $("city").add(new Option(c.name, i)));
$("city").onchange = (e) => setPlace(CITIES[+e.target.value]);
$("locate").onclick = () => {
  if (!navigator.geolocation) return;
  $("locate").textContent = "📍 Finding you…";
  navigator.geolocation.getCurrentPosition(
    (pos) => { $("locate").textContent = "📍 My location";
      setPlace({ name: "My location", lat: pos.coords.latitude, lon: pos.coords.longitude, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }); },
    () => { $("locate").textContent = "📍 Location blocked"; }, { timeout: 8000 });
};
$("time").oninput = (e) => setTime(+e.target.value);

document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => {
  state.mode = b.dataset.mode;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === b));
  state.selected = null; tip.hidden = true;
  state.mode === "play" ? newTarget() : (renderCard(), drawSky());
}));

// time-lapse
let playing = false;
$("play").onclick = () => {
  playing = !playing;
  $("play").textContent = playing ? "❚❚" : "▶";
  if (playing && state.time >= state.night.darkEnd) state.time = +$("time").min;
  const tick = () => {
    if (!playing) return renderCard();
    if (state.time >= state.night.darkEnd) { playing = false; $("play").textContent = "▶"; return renderCard(); }
    setTime(state.time + 4 * 60e3, true);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

window.addEventListener("resize", requestDraw);
setPlace(CITIES[0]);
