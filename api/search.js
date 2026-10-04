// Vercel Serverless Function: /api/search  (letakkan di folder: api/search.js)
// Node.js runtime. Tanpa dependency tambahan. Memakai CommonJS agar aman
// walaupun project tidak punya package.json.
'use strict';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const PHOTON_URL = 'https://photon.komoot.io/api/';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
const USER_AGENT = 'BizFinderPro/1.1 (+https://vercel.app; contact: hardinataraja@gmail.com)';

const g = globalThis;
const searchCache = g.__bizFinderCache || new Map();
const geoCache = g.__bizFinderGeoCache || new Map();
g.__bizFinderCache = searchCache;
g.__bizFinderGeoCache = geoCache;

const CACHE_TTL_MS = 5 * 60 * 1000;
const GEO_TTL_MS = 24 * 60 * 60 * 1000;
const GEOCODE_TIMEOUT_MS = 5000;
const OVERPASS_TIMEOUT_MS = 18000;
const HEDGE_DELAY_MS = 3000; // server cadangan dicoba bila server utama lambat
const MAX_RESULTS = 100;
const MAX_QUERY_LENGTH = 80;
const RADIUS_DEG = 0.045; // ~5 km dari titik pusat lokasi

// ---------- Helper respons (tidak bergantung pada helper Express/Vercel) ----------
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(data);
}

function normalizeText(value, fallback = '') {
  return String(value == null ? fallback : value).trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LENGTH);
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

function makeError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

// ---------- Kategori -> filter Overpass ----------
const CUSTOM_ALIASES = {
  gym: 'fitness_centre', fitness: 'fitness_centre', bengkel: 'car_repair',
  salon: 'hairdresser', barbershop: 'hairdresser', barber: 'hairdresser',
  toko: 'convenience', warung: 'convenience', apotek: 'pharmacy',
  restoran: 'restaurant', kafe: 'cafe', warkop: 'cafe', penginapan: 'guest_house',
  sekolah: 'school', bank: 'bank', kos: 'guest_house', fotokopi: 'copyshop'
};

function getCategoryFilters(category) {
  const tag = normalizeText(category || 'all').toLowerCase();
  switch (tag) {
    case 'restaurant':
      return ['["amenity"~"^(restaurant|cafe|fast_food|food_court|bar|ice_cream)$"]'];
    case 'hairdresser':
      return ['["shop"~"^(hairdresser|beauty|barber|cosmetics)$"]'];
    case 'car_repair':
      return ['["shop"~"^(car_repair|motorcycle_repair|motorcycle|car_parts|tyres)$"]'];
    case 'clothes':
      return ['["shop"~"^(clothes|boutique|fashion|shoes|tailor)$"]'];
    case 'clinic':
      return ['["amenity"~"^(clinic|dentist|doctors|pharmacy|hospital)$"]', '["healthcare"]'];
    case 'hotel':
      return ['["tourism"~"^(hotel|guest_house|motel|hostel)$"]'];
    case 'laundry':
      return ['["shop"="laundry"]', '["amenity"="laundry"]'];
    case 'all':
      return [
        '["shop"]',
        '["craft"]',
        '["amenity"~"^(restaurant|cafe|fast_food|food_court|bar|pharmacy|clinic|dentist|doctors|bank|car_wash|marketplace|driving_school|photo_booth)$"]',
        '["tourism"~"^(hotel|guest_house|motel|hostel)$"]'
      ];
    default: {
      let value = tag.replace(/[^a-z0-9_:-]/g, '');
      value = CUSTOM_ALIASES[value] || value;
      if (!value) return getCategoryFilters('all');
      // Cocokkan nilai pada key OSM umum (amenity/shop/craft/office/leisure/tourism)
      return [`[~"^(amenity|shop|craft|office|leisure|tourism|healthcare)$"~"^${value}$"]`];
    }
  }
}

function getWebsiteClause(websiteFilter) {
  if (websiteFilter === 'no_website') return '[!"website"][!"contact:website"][!"url"]';
  if (websiteFilter === 'has_website') return '[~"^(website|contact:website|url)$"~"."]';
  return '';
}

function buildOverpassQuery(lat, lon, category, websiteFilter) {
  const bbox = `${(lat - RADIUS_DEG).toFixed(6)},${(lon - RADIUS_DEG).toFixed(6)},${(lat + RADIUS_DEG).toFixed(6)},${(lon + RADIUS_DEG).toFixed(6)}`;
  const web = getWebsiteClause(websiteFilter);
  const statements = getCategoryFilters(category)
    .map(f => `nwr${f}["name"]${web}(${bbox});`)
    .join('');
  return `[out:json][timeout:15];(${statements});out tags center ${MAX_RESULTS};`;
}

// ---------- HTTP ----------
async function fetchJson(url, options = {}, timeoutMs = 10000, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') throw makeError(`Timeout setelah ${Math.round(timeoutMs / 1000)} detik`);
      throw makeError(`Gagal terhubung: ${err && err.cause && err.cause.code ? err.cause.code : (err && err.message) || 'network error'}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw makeError(`HTTP ${response.status} ${response.statusText || ''}`.trim(), { status: response.status });
    }

    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    // Overpass yang sedang overload sering membalas HTTP 200 berisi HTML/XML.
    if (payload === null) throw makeError('Respons bukan JSON valid (server mungkin sibuk)');
    return payload;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
}

// ---------- Geocoding (Nominatim, cadangan Photon) ----------
async function geocodeNominatim(city) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('accept-language', 'id');
  url.searchParams.set('limit', '1');
  url.searchParams.set('q', city);
  const data = await fetchJson(url.toString(), {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json', 'Referer': 'https://vercel.app/' }
  }, GEOCODE_TIMEOUT_MS);
  if (!Array.isArray(data) || !data.length) return null;
  const lat = parseFloat(data[0].lat);
  const lon = parseFloat(data[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, displayName: data[0].display_name || city };
}

async function geocodePhoton(city) {
  const url = new URL(PHOTON_URL);
  url.searchParams.set('q', city);
  url.searchParams.set('limit', '1');
  const data = await fetchJson(url.toString(), {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
  }, GEOCODE_TIMEOUT_MS);
  const feature = data && Array.isArray(data.features) ? data.features[0] : null;
  if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) return null;
  const [lon, lat] = feature.geometry.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const p = feature.properties || {};
  const displayName = [p.name, p.county || p.city, p.state, p.country].filter(Boolean).join(', ') || city;
  return { lat, lon, displayName };
}

async function geocodeCity(city, failures) {
  const key = city.toLowerCase();
  const cached = geoCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let location = null;
  for (const [label, fn] of [['Nominatim', geocodeNominatim], ['Photon', geocodePhoton]]) {
    try {
      location = await fn(city);
      if (location) break;
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
    }
  }
  if (location) geoCache.set(key, { expiresAt: Date.now() + GEO_TTL_MS, value: location });
  return location;
}

// ---------- Overpass (bertahap: server cadangan dipanggil saat yang utama gagal/lambat) ----------
function queryOverpass(query, failures) {
  const master = new AbortController();
  const body = new URLSearchParams({ data: query }).toString();

  return new Promise((resolve, reject) => {
    let launched = 0;
    let failed = 0;
    let done = false;
    const timers = [];

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      master.abort(); // hentikan request lain yang masih berjalan
      fn(value);
    };

    const launchNext = () => {
      if (done || launched >= OVERPASS_ENDPOINTS.length) return;
      const endpoint = OVERPASS_ENDPOINTS[launched++];
      // Jika server ini lambat, siapkan server berikutnya sebagai cadangan.
      if (launched < OVERPASS_ENDPOINTS.length) timers.push(setTimeout(launchNext, HEDGE_DELAY_MS));

      fetchJson(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': 'application/json',
          'User-Agent': USER_AGENT
        },
        body
      }, OVERPASS_TIMEOUT_MS, master.signal).then(data => {
        const empty = !Array.isArray(data.elements) || data.elements.length === 0;
        if (empty && data.remark && /runtime error|timed out|out of memory/i.test(String(data.remark))) {
          throw makeError(`Overpass: ${String(data.remark).slice(0, 120)}`);
        }
        finish(resolve, data);
      }).catch(err => {
        if (done) return;
        failures.push(`${new URL(endpoint).host}: ${err.message}`);
        failed++;
        if (failed >= OVERPASS_ENDPOINTS.length) {
          finish(reject, makeError('Semua server pencarian OpenStreetMap gagal merespons. Coba lagi beberapa saat atau persempit lokasi/kategori.', { status: 503 }));
        } else {
          launchNext(); // langsung coba server berikutnya tanpa menunggu
        }
      });
    };

    launchNext();
  });
}

// ---------- Parsing hasil ----------
function normalizeWebsite(raw) {
  let value = String(raw || '').split(/[;,\s]/)[0].trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value.replace(/^\/+/, '');
  try {
    const u = new URL(value);
    return /^https?:$/.test(u.protocol) ? u.toString() : '';
  } catch {
    return '';
  }
}

function normalizePhone(raw) {
  const first = String(raw || '').split(/[;,/]/)[0];
  let digits = first.replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('62')) digits = '0' + digits.slice(2);
  else if (digits.startsWith('8')) digits = '0' + digits;
  return digits;
}

function parseBusinesses(elements, city, lat, lon) {
  const seen = new Set();
  const list = [];
  for (const item of elements || []) {
    const tags = item.tags || {};
    const name = tags.name || tags['name:id'] || tags.brand;
    if (!name) continue;

    const uid = `${item.type}_${item.id}`;
    if (seen.has(uid)) continue;
    seen.add(uid);

    const center = item.center || {};
    const rawPhone = tags.phone || tags['contact:phone'] || tags['contact:whatsapp'] || tags.mobile || tags['contact:mobile'] || '';
    const website = normalizeWebsite(tags.website || tags['contact:website'] || tags.url);
    const address = [
      tags['addr:street'],
      tags['addr:housenumber'],
      tags['addr:suburb'] || tags['addr:district'] || tags['addr:village'],
      tags['addr:city'] || city
    ].filter(Boolean).join(', ') || `${city} (Peta Area)`;
    const categoryName = tags.amenity || tags.shop || tags.craft || tags.tourism || tags.office || tags.leisure || tags.healthcare || 'UMKM';

    list.push({
      id: `osm_${uid}`,
      name: String(name),
      category: capitalize(String(categoryName).replace(/_/g, ' ')),
      address,
      city,
      phone: normalizePhone(rawPhone),
      rawPhone: String(rawPhone),
      website,
      lat: item.lat != null ? item.lat : (center.lat != null ? center.lat : lat),
      lon: item.lon != null ? item.lon : (center.lon != null ? center.lon : lon)
    });
  }
  return list;
}

function applyWebsiteFilter(items, websiteFilter) {
  if (websiteFilter === 'no_website') return items.filter(i => !i.website);
  if (websiteFilter === 'has_website') return items.filter(i => Boolean(i.website));
  return items;
}

function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body && typeof body === 'object' ? body : {};
}

// ---------- Handler ----------
async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return send(res, 405, { ok: false, error: 'Method tidak diizinkan. Gunakan POST.' });
  }

  const failures = [];
  try {
    const body = readBody(req);
    const city = normalizeText(body.city);
    const category = normalizeText(body.category || 'all').toLowerCase() || 'all';
    const websiteFilter = ['all', 'no_website', 'has_website'].includes(body.websiteFilter) ? body.websiteFilter : 'no_website';

    if (!city) return send(res, 400, { ok: false, error: 'Kota atau lokasi wajib diisi.' });

    const cacheKey = JSON.stringify({ c: city.toLowerCase(), category, websiteFilter });
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return send(res, 200, { ...cached.payload, cached: true });
    if (cached) searchCache.delete(cacheKey);

    const location = await geocodeCity(city, failures);
    if (!location) {
      if (failures.length) {
        return send(res, 502, { ok: false, code: 'GEOCODER_ERROR', error: 'Layanan pencari lokasi sedang tidak merespons. Coba lagi sebentar.', details: failures });
      }
      return send(res, 404, { ok: false, code: 'LOCATION_NOT_FOUND', error: 'Lokasi tidak ditemukan. Coba tulis lebih lengkap, mis. "Mojosari, Mojokerto".' });
    }

    const query = buildOverpassQuery(location.lat, location.lon, category, websiteFilter);
    const overpassData = await queryOverpass(query, failures);
    const parsed = parseBusinesses(overpassData.elements, city, location.lat, location.lon);
    const results = applyWebsiteFilter(parsed, websiteFilter);

    const payload = {
      ok: true,
      city,
      location,
      results,
      count: results.length
    };
    searchCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
    return send(res, 200, payload);
  } catch (error) {
    console.error('[api/search]', error && error.message, failures);
    const status = Number.isInteger(error && error.status) ? error.status : 502;
    return send(res, status, {
      ok: false,
      code: 'SEARCH_PROVIDER_ERROR',
      error: (error && error.message) || 'Pencarian gagal diproses.',
      details: failures.slice(0, 8)
    });
  }
}

module.exports = handler;
module.exports.config = { maxDuration: 30 };
