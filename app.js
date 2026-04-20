/* ——————————————————————————————————————————————————————————————
   ISS // MCC-H TERMINAL
   Drop-in logic for index.html. Same APIs as the original:
     - https://api.wheretheiss.at/v1/satellites/25544 (position)
     - /api/crew (Open-Notify proxy, falls back to HTTP direct on localhost)
   Adds: next-pass prediction (satellite.js + Celestrak TLE), observer
   panel (user ↔ ISS), cupola porthole sync, trivia ticker, CRT chrome.
   —————————————————————————————————————————————————————————————— */

const API      = 'https://api.wheretheiss.at/v1/satellites/25544';
const POLL_MS  = 3000;
const TRAIL_MAX = 180;
const TLE_URL   = 'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE';
// Nov 2, 2000 09:23 UTC — Expedition 1 docking, start of continuous habitation.
const CONT_HAB_EPOCH = Date.UTC(2000, 10, 2, 9, 23);

const map = L.map('map', {
  zoomControl: false,
  worldCopyJump: true,
  attributionControl: true,
  minZoom: 2,
}).setView([0, 0], 3);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OSM · CARTO · wheretheiss.at · Celestrak',
  subdomains: 'abcd',
  maxZoom: 19,
}).addTo(map);

const terminator = L.terminator({
  color: '#000',
  fillColor: '#000',
  fillOpacity: 0.45,
  weight: 0,
  interactive: false,
}).addTo(map);
setInterval(() => terminator.setTime(new Date()), 60_000);

const issIcon = L.divIcon({
  className: 'iss-icon',
  html: `<div class="iss-marker">
           <div class="crosshair"></div>
           <div class="ring ping"></div>
           <div class="ring ping" style="animation-delay: 1.2s;"></div>
           <div class="ring"></div>
           <div class="core"></div>
           <div class="tag">◉ ISS // LIVE</div>
         </div>`,
  iconSize: [56, 56],
  iconAnchor: [28, 28],
});

let marker = null;
const trail = [];
const trailLine = L.polyline([], {
  color: '#39ff14',
  weight: 2,
  opacity: 0.85,
}).addTo(map);
const forecastLine = L.polyline([], {
  color: '#ffb020',
  weight: 1,
  opacity: 0.5,
  dashArray: '2 6',
}).addTo(map);

let meMarker = null;
const meLine = L.polyline([], {
  color: '#39ff14',
  weight: 1,
  opacity: 0.55,
  dashArray: '4 6',
}).addTo(map);

let firstFix = true;
let latestIss = null;

const fmt = {
  coord: (n) => (n >= 0 ? '+' : '') + n.toFixed(4),
  km:    (n) => n.toFixed(2),
  speed: (n) => Math.round(n).toLocaleString('en-US'),
  time:  (ts) => new Date(ts * 1000).toLocaleTimeString('en-GB', { hour12: false }),
  hms:   (sec) => {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  },
  cardinal: (lat, lon) => {
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lon >= 0 ? 'E' : 'W';
    return Math.abs(lat).toFixed(2) + '°' + ns + ' ' + Math.abs(lon).toFixed(2) + '°' + ew;
  },
  azm: (az) => {
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return Math.round(az) + '° ' + dirs[Math.round(az / 22.5) % 16];
  },
};

function splitOnWrap(points) {
  const segs = [[]];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && Math.abs(points[i][1] - points[i - 1][1]) > 180) segs.push([]);
    segs[segs.length - 1].push(points[i]);
  }
  return segs;
}

function setValue(id, next) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.textContent === next) return;
  el.textContent = next;
  el.classList.remove('changing');
  void el.offsetWidth;
  el.classList.add('changing');
}

let lastGeocode = 0;
const GEOCODE_MS = 20_000;
const oceanByLon = (lat, lon) => {
  if (lat > 66)  return 'ARCTIC OCEAN';
  if (lat < -60) return 'SOUTHERN OCEAN';
  if (lon > 20 && lon < 147) return 'INDIAN OCEAN';
  if (lon >= -70 && lon <= 20) return 'ATLANTIC OCEAN';
  return 'PACIFIC OCEAN';
};
async function updateOver(lat, lon) {
  const now = Date.now();
  if (now - lastGeocode < GEOCODE_MS) return;
  lastGeocode = now;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=3&lat=${lat}&lon=${lon}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('geocode ' + res.status);
    const g = await res.json();
    const name = g.address && (g.address.country || g.address.sea || g.address.ocean);
    setValue('over', (name || oceanByLon(lat, lon)).toUpperCase());
  } catch {
    setValue('over', oceanByLon(lat, lon));
  }
}

function updateCupola(d) {
  const earth = document.getElementById('cupolaEarth');
  const day = d.visibility === 'daylight';
  earth.classList.toggle('day', day);
  earth.classList.toggle('night', !day);
  setValue('cupolaLat', (d.latitude >= 0 ? '+' : '') + d.latitude.toFixed(2) + '°');
  setValue('cupolaLon', (d.longitude >= 0 ? '+' : '') + d.longitude.toFixed(2) + '°');
  setValue('cupolaPhase', day ? 'DAYLIGHT' : 'ECLIPSED');
}

const TICKER_FACTS = [
  (d) => `◉ STA-ZARYA · ALT ${d.altitude.toFixed(1)} KM · ${Math.round(d.altitude / 0.8)}× HIGHER THAN COMMERCIAL JETS ·`,
  (d) => `◉ GROUND SPEED ${Math.round(d.velocity).toLocaleString()} KM/H · NYC→LA IN ${Math.round(4500 / (d.velocity / 60))} MIN ·`,
  (d) => `◉ ORBIT PERIOD ≈ 92 MIN 48 S · 15.5 LAPS AROUND EARTH PER EARTH-DAY ·`,
  (d) => `◉ CREW SEES 16 SUNRISES & 16 SUNSETS EVERY 24 H · CURRENT PHASE: ${d.visibility === 'daylight' ? 'DAYLIGHT' : 'ECLIPSE'} ·`,
  (d) => `◉ CONTINUOUSLY CREWED SINCE NOV 2, 2000 · ${Math.floor((Date.now() - CONT_HAB_EPOCH) / 86400000).toLocaleString()} DAYS AND COUNTING ·`,
  (d) => `◉ MASS ≈ 420 T · PRESSURIZED VOL 916 m³ · SIZE OF A 6-BEDROOM HOUSE IN LOW EARTH ORBIT ·`,
  (d) => `◉ SOLAR ARRAYS SPAN 109 M · WIDER THAN AN AMERICAN FOOTBALL FIELD ·`,
  (d) => `◉ MACH ${(d.velocity / 1225).toFixed(1)} · 25× THE SPEED OF SOUND AT SEA LEVEL ·`,
  (d) => `◉ ORBITAL INCLINATION 51.64° · OVERFLIES 90% OF INHABITED EARTH ·`,
  (d) => `◉ EVERY SECOND THE STATION TRAVELS ≈ ${(d.velocity / 3600).toFixed(1)} KM · ${Math.round(d.velocity / 36)}× AVERAGE HIGHWAY SPEED ·`,
  (d) => `◉ 25+ YEARS OF CONTINUOUS HUMAN PRESENCE · THE LONGEST IN HISTORY ·`,
  (d) => `◉ CURRENTLY ${(d.latitude >= 0 ? 'NORTHERN' : 'SOUTHERN')} HEMISPHERE · LAT ${Math.abs(d.latitude).toFixed(1)}° ${d.latitude >= 0 ? 'N' : 'S'} ·`,
];
let tickerI = 0;
function pumpTicker() {
  if (!latestIss) return;
  const msg = TICKER_FACTS[tickerI % TICKER_FACTS.length](latestIss);
  tickerI++;
  const el = document.getElementById('tickerMsg');
  el.textContent = msg + '   ' + msg + '   ';
}
setInterval(pumpTicker, 12_000);

function updateMissionClock() {
  const now = new Date();
  const elapsed = now.getTime() - CONT_HAB_EPOCH;
  const days = Math.floor(elapsed / 86_400_000);
  const rem = elapsed % 86_400_000;
  const h = Math.floor(rem / 3_600_000);
  const m = Math.floor((rem % 3_600_000) / 60_000);
  const s = Math.floor((rem % 60_000) / 1000);
  document.getElementById('missionClock').textContent =
    days.toLocaleString() + 'd ' + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  document.getElementById('utc').textContent = now.toISOString().substring(11, 19) + ' Z';
}
setInterval(updateMissionClock, 1000);
updateMissionClock();

async function tick() {
  try {
    const res = await fetch(API);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    latestIss = d;

    const pos = [d.latitude, d.longitude];
    if (!marker) {
      marker = L.marker(pos, { icon: issIcon, keyboard: false, zIndexOffset: 1000 }).addTo(map);
    } else {
      marker.setLatLng(pos);
    }

    trail.push(pos);
    if (trail.length > TRAIL_MAX) trail.shift();
    trailLine.setLatLngs(splitOnWrap(trail));

    if (firstFix) {
      map.setView(pos, 3);
      firstFix = false;
      pumpTicker();
    }

    setValue('lat', fmt.coord(d.latitude));
    setValue('lon', fmt.coord(d.longitude));
    setValue('alt', fmt.km(d.altitude));
    setValue('vel', fmt.speed(d.velocity));
    setValue('vis', (d.visibility || '').toUpperCase());
    setValue('ts',  fmt.time(d.timestamp));
    setValue('mach', (d.velocity / 1225).toFixed(1));

    document.getElementById('statusText').textContent = 'TRACKING';
    document.getElementById('statusDot').classList.remove('err');

    updateOver(d.latitude, d.longitude);
    updateCupola(d);
    updateObserverLive(d);
  } catch (err) {
    document.getElementById('statusText').textContent = 'RECONN';
    document.getElementById('statusDot').classList.add('err');
    console.error('ISS fetch failed:', err);
  }
}

// Best-effort nationality map — unknowns render with "···".
const CREW_NATIONS = {
  'Oleg Kononenko': 'RUS', 'Nikolai Chub': 'RUS', 'Tracy Caldwell Dyson': 'USA',
  'Matthew Dominick': 'USA', 'Michael Barratt': 'USA', 'Jeanette Epps': 'USA',
  'Alexander Grebenkin': 'RUS', 'Butch Wilmore': 'USA', 'Sunita Williams': 'USA',
  'Oleg Artemyev': 'RUS', 'Denis Matveev': 'RUS', 'Sergey Korsakov': 'RUS',
  'Kjell Lindgren': 'USA', 'Bob Hines': 'USA', 'Jessica Watkins': 'USA',
  'Samantha Cristoforetti': 'ITA', 'Frank Rubio': 'USA', 'Sergey Prokopyev': 'RUS',
  'Dmitri Petelin': 'RUS', 'Stephen Bowen': 'USA', 'Warren Hoburg': 'USA',
  'Sultan Alneyadi': 'UAE', 'Andreas Mogensen': 'DNK', 'Satoshi Furukawa': 'JPN',
  'Konstantin Borisov': 'RUS', 'Jasmin Moghbeli': 'USA', 'Loral O\'Hara': 'USA',
  'Don Pettit': 'USA', 'Alexey Ovchinin': 'RUS', 'Ivan Vagner': 'RUS',
  'Nick Hague': 'USA', 'Aleksandr Gorbunov': 'RUS',
  'Li Guangsu': 'CHN', 'Li Cong': 'CHN', 'Ye Guangfu': 'CHN',
  'Tang Hongbo': 'CHN', 'Jiang Xinlin': 'CHN', 'Shenzhou-18': 'CHN',
};
function flagFor(name) {
  return CREW_NATIONS[name] || '···';
}

async function loadCrew() {
  const list = document.getElementById('crewList');
  const count = document.getElementById('crewCount');

  const sources = [
    '/api/crew',
    'https://corsproxy.io/?url=' + encodeURIComponent('http://api.open-notify.org/astros.json'),
  ];
  if (location.protocol === 'http:') sources.push('http://api.open-notify.org/astros.json');

  const FALLBACK = {
    number: 10,
    people: [
      { name: 'Oleg Kononenko',      craft: 'ISS' },
      { name: 'Nikolai Chub',        craft: 'ISS' },
      { name: 'Tracy Caldwell Dyson',craft: 'ISS' },
      { name: 'Matthew Dominick',    craft: 'ISS' },
      { name: 'Michael Barratt',     craft: 'ISS' },
      { name: 'Jeanette Epps',       craft: 'ISS' },
      { name: 'Alexander Grebenkin', craft: 'ISS' },
      { name: 'Li Guangsu',          craft: 'Tiangong' },
      { name: 'Li Cong',             craft: 'Tiangong' },
      { name: 'Ye Guangfu',          craft: 'Tiangong' },
    ],
  };

  function render(data, stale) {
    count.textContent = String(data.number).padStart(2, '0');
    list.innerHTML = '';
    const sorted = [...data.people].sort((a, b) => {
      const aIss = a.craft === 'ISS' ? 0 : 1;
      const bIss = b.craft === 'ISS' ? 0 : 1;
      return aIss - bIss || a.name.localeCompare(b.name);
    });
    for (const p of sorted) {
      const row = document.createElement('div');
      row.className = 'row';
      if (p.craft === 'ISS') row.classList.add('iss');
      if (p.craft && p.craft.toLowerCase().includes('tiangong')) row.classList.add('tian');
      const nat = flagFor(p.name);
      row.innerHTML = `
        <div class="flag">${nat}</div>
        <div>
          <div class="name">${p.name}</div>
          <div class="meta">${p.craft === 'ISS' ? 'EXP 71' : 'SHENZHOU'} ${stale ? '· CACHED' : ''}</div>
        </div>
        <div class="craft">${p.craft}</div>
      `;
      list.appendChild(row);
    }
  }

  for (const url of sources) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (!data || !Array.isArray(data.people)) continue;
      render(data, false);
      return;
    } catch (err) {
      console.warn('Crew source failed:', url, err);
    }
  }
  render(FALLBACK, true);
}

let userPos = null;
let tleRecord = null;

function gcDistKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function lookAngles(iss) {
  if (!userPos || !tleRecord) return null;
  const now = new Date();
  const gmst = satellite.gstime(now);
  const posVel = satellite.propagate(tleRecord, now);
  if (!posVel.position) return null;
  const observerGd = {
    longitude: userPos.lon * Math.PI / 180,
    latitude:  userPos.lat * Math.PI / 180,
    height:    0.05,
  };
  const positionEcf = satellite.eciToEcf(posVel.position, gmst);
  const la = satellite.ecfToLookAngles(observerGd, positionEcf);
  return {
    el: la.elevation * 180 / Math.PI,
    az: (la.azimuth * 180 / Math.PI + 360) % 360,
    range: la.rangeSat,
  };
}

function updateObserverLive(d) {
  if (!userPos) return;
  const gc = gcDistKm(userPos.lat, userPos.lon, d.latitude, d.longitude);
  const la = lookAngles(d);
  const distKm = la ? la.range : gc;
  setValue('obsDist', Math.round(distKm).toLocaleString('en-US'));
  if (la) {
    setValue('obsElev', la.el.toFixed(1) + '°');
    setValue('obsAzm', fmt.azm(la.az));
    const visEl = document.getElementById('obsVis');
    if (la.el > 10) {
      visEl.className = 'visible yes';
      visEl.textContent = '◉ OVERHEAD NOW · LOOK UP';
    } else if (la.el > 0) {
      visEl.className = 'visible yes';
      visEl.textContent = '◉ RISING / SETTING · HORIZON';
    } else {
      visEl.className = 'visible no';
      visEl.textContent = 'BELOW HORIZON';
    }
  }
  meLine.setLatLngs(splitOnWrap([[userPos.lat, userPos.lon], [d.latitude, d.longitude]]));
}

async function loadTLE() {
  try {
    const res = await fetch(TLE_URL);
    if (!res.ok) throw new Error('TLE ' + res.status);
    const text = await res.text();
    const lines = text.trim().split(/\r?\n/);
    let l1, l2;
    if (lines.length >= 3 && lines[1].startsWith('1 ') && lines[2].startsWith('2 ')) {
      l1 = lines[1]; l2 = lines[2];
    } else if (lines.length >= 2 && lines[0].startsWith('1 ') && lines[1].startsWith('2 ')) {
      l1 = lines[0]; l2 = lines[1];
    } else {
      throw new Error('TLE format');
    }
    tleRecord = satellite.twoline2satrec(l1, l2);
    drawForecast();
  } catch (err) {
    console.warn('TLE load failed:', err);
  }
}

function drawForecast() {
  if (!tleRecord) return;
  const pts = [];
  const start = new Date();
  for (let m = 1; m <= 95; m++) {
    const when = new Date(start.getTime() + m * 60_000);
    const pv = satellite.propagate(tleRecord, when);
    if (!pv.position) continue;
    const gmst = satellite.gstime(when);
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    const lat = geo.latitude * 180 / Math.PI;
    const lon = ((geo.longitude * 180 / Math.PI + 540) % 360) - 180;
    pts.push([lat, lon]);
  }
  forecastLine.setLatLngs(splitOnWrap(pts));
}

// Coarse 30s step scan for the first time elevation rises above 10°,
// then walks back in 5s steps to find the horizon rise for a nicer readout.
function predictNextPass() {
  if (!tleRecord || !userPos) return null;
  const observerGd = {
    longitude: userPos.lon * Math.PI / 180,
    latitude:  userPos.lat * Math.PI / 180,
    height:    0.05,
  };
  const now = Date.now();
  let best = null;
  for (let t = 30; t < 60 * 60 * 24; t += 30) {
    const when = new Date(now + t * 1000);
    const pv = satellite.propagate(tleRecord, when);
    if (!pv || !pv.position) continue;
    const gmst = satellite.gstime(when);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    const la = satellite.ecfToLookAngles(observerGd, ecf);
    const elDeg = la.elevation * 180 / Math.PI;
    if (elDeg > 10) {
      let riseT = t;
      for (let b = t; b > Math.max(0, t - 600); b -= 5) {
        const w = new Date(now + b * 1000);
        const pv2 = satellite.propagate(tleRecord, w);
        if (!pv2 || !pv2.position) continue;
        const ecf2 = satellite.eciToEcf(pv2.position, satellite.gstime(w));
        const la2 = satellite.ecfToLookAngles(observerGd, ecf2);
        if (la2.elevation * 180 / Math.PI < 0) { riseT = b + 5; break; }
      }
      best = { inSec: riseT, peakEl: elDeg };
      break;
    }
  }
  return best;
}

let passCountdown = null;
function refreshPassPanel() {
  if (!userPos || !tleRecord) return;
  const p = predictNextPass();
  const body = document.getElementById('passBody');
  if (!p) {
    body.innerHTML = '<div class="hint">No visible pass in<br>next 24 hours.</div>';
    return;
  }
  passCountdown = { until: Date.now() + p.inSec * 1000, peakEl: p.peakEl };
  body.innerHTML = `
    <div class="clock" id="passClock">${fmt.hms(p.inSec)}</div>
    <div class="hint">Until next overhead pass<br>@ peak elev ${p.peakEl.toFixed(0)}°</div>
    <div class="mini">
      <div><b>${fmt.cardinal(userPos.lat, userPos.lon).split(' ')[0]}</b>YOUR LAT</div>
      <div><b>${fmt.cardinal(userPos.lat, userPos.lon).split(' ')[1]}</b>YOUR LON</div>
    </div>
  `;
}

function tickPassClock() {
  if (!passCountdown) return;
  const remain = (passCountdown.until - Date.now()) / 1000;
  const el = document.getElementById('passClock');
  if (!el) return;
  if (remain <= 0) {
    el.textContent = '00:00:00';
    el.classList.add('live');
    if (remain < -120) {
      passCountdown = null;
      refreshPassPanel();
    }
  } else {
    el.textContent = fmt.hms(remain);
    el.classList.remove('live');
  }
}
setInterval(tickPassClock, 1000);
setInterval(() => { if (userPos) refreshPassPanel(); }, 5 * 60_000);

function enableLocation() {
  if (!navigator.geolocation) {
    document.getElementById('passBody').innerHTML = '<div class="hint">Browser does not<br>support geolocation.</div>';
    return;
  }
  navigator.geolocation.getCurrentPosition((pos) => {
    userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    document.getElementById('observerPanel').style.display = '';
    const meIcon = L.divIcon({
      className: 'me-icon',
      html: `<div class="me-marker"><div class="ring"></div><div class="core"></div><div class="tag">YOU</div></div>`,
      iconSize: [24, 24], iconAnchor: [12, 12],
    });
    if (meMarker) map.removeLayer(meMarker);
    meMarker = L.marker([userPos.lat, userPos.lon], { icon: meIcon, keyboard: false }).addTo(map);

    if (latestIss) updateObserverLive(latestIss);
    if (tleRecord) refreshPassPanel();
    else {
      const retry = setInterval(() => {
        if (tleRecord) { refreshPassPanel(); clearInterval(retry); }
      }, 1500);
    }
  }, (err) => {
    document.getElementById('passBody').innerHTML =
      '<div class="hint">Location denied.<br>Pass prediction offline.</div>';
    console.warn('geo denied', err);
  }, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60 * 60_000 });
}
document.getElementById('passBtn').addEventListener('click', enableLocation);

loadCrew();
loadTLE();
tick();
setInterval(tick, POLL_MS);
setInterval(loadCrew, 5 * 60_000);
