// Vercel Serverless Function: /api/search
// Node.js runtime. Tidak membutuhkan dependency tambahan.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

const memoryCache = globalThis.__bizFinderCache || new Map();
globalThis.__bizFinderCache = memoryCache;

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 18000;
const MAX_RESULTS = 50;
const MAX_QUERY_LENGTH = 80;

function json(res, status, body, extraHeaders = {}) {
  return res.status(status).set({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 's-maxage=300, stale-while-revalidate=600',
    ...extraHeaders
  }).json(body);
}

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim().slice(0, MAX_QUERY_LENGTH);
}

function cleanPhoneNumber(phone) {
  return String(phone || '').replace(/[^0-9]/g, '');
}

function capitalize(value) {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getCategoryFilter(category) {
  const categoryTag = normalizeText(category || 'all').toLowerCase();

  switch (categoryTag) {
    case 'restaurant':
      return '["amenity"~"restaurant|cafe|fast_food|food_court"]';
    case 'hairdresser':
      return '["shop"~"hairdresser|beauty"]';
    case 'car_repair':
      return '["shop"~"car_repair|motorcycle_repair"]';
    case 'clothes':
      return '["shop"~"clothes|boutique|fashion"]';
    case 'clinic':
      return '["amenity"~"clinic|dentist|doctors|pharmacy"]';
    case 'hotel':
      return '["tourism"~"hotel|guest_house|motel"]';
    case 'laundry':
      return '["shop"="laundry"]';
    case 'all':
      // Lebih ringan daripada mencari semua objek bernama tanpa tipe objek.
      return '["name"]["amenity"]';
    default:
      // Kategori custom dianggap sebagai nilai amenity OSM.
      return `["amenity"="${categoryTag.replace(/[^a-z0-9_:-]/g, '')}"]`;
  }
}

function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const timeout = createAbortSignal(timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: timeout.signal
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
      throw error;
    }

    if (!payload) {
      const error = new Error('Respons API tidak berisi JSON yang valid.');
      error.retryable = true;
      throw error;
    }

    return payload;
  } finally {
    timeout.clear();
  }
}

async function geocodeCity(city) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('accept-language', 'id');
  url.searchParams.set('limit', '1');
  url.searchParams.set('q', city);

  return fetchJson(url, {
    headers: {
      // Nominatim meminta identitas aplikasi yang jelas.
      'User-Agent': 'BizFinderPro/1.0 (Vercel serverless search)'
    }
  }, 10000);
}

function buildOverpassQuery(lat, lon, category) {
  // Sekitar 3 km dari titik hasil geocoding; area lebih kecil mengurangi timeout.
  const radius = 0.03;
  const south = lat - radius;
  const west = lon - radius;
  const north = lat + radius;
  const east = lon + radius;
  const filter = getCategoryFilter(category);

  return `[out:json][timeout:25];(node${filter}(${south},${west},${north},${east});way${filter}(${south},${west},${north},${east}););out center tags ${MAX_RESULTS};`;
}

async function queryOverpass(query) {
  const failures = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      return await fetchJson(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'BizFinderPro/1.0 (Vercel serverless search)'
        },
        body: new URLSearchParams({ data: query }).toString()
      }, REQUEST_TIMEOUT_MS);
    } catch (error) {
      failures.push(`${endpoint}: ${error.message}`);
      // Endpoint berikutnya dipakai hanya jika error bersifat retryable/network.
      if (error.retryable === false) break;
    }
  }

  const error = new Error('Semua server pencarian OpenStreetMap gagal merespons.');
  error.details = failures;
  error.status = 503;
  throw error;
}

function parseBusinesses(elements, city, lat, lon) {
  return (elements || []).reduce((list, item, index) => {
    const tags = item.tags || {};
    const name = tags.name || tags['name:id'] || tags.brand;
    if (!name) return list;

    const center = item.center || {};
    const phone = tags.phone || tags['contact:phone'] || tags['contact:whatsapp'] || tags.mobile || tags['contact:mobile'] || '';
    const website = tags.website || tags['contact:website'] || tags.url || '';
    const street = tags['addr:street'] || '';
    const houseNumber = tags['addr:housenumber'] || '';
    const suburb = tags['addr:suburb'] || tags['addr:district'] || '';
    const address = [street, houseNumber, suburb, city].filter(Boolean).join(', ') || `${city} (Peta Area)`;
    const categoryName = tags.amenity || tags.shop || tags.tourism || 'UMKM';

    list.push({
      id: `osm_${item.id}_${index}`,
      name,
      category: capitalize(String(categoryName).replace(/_/g, ' ')),
      address,
      city,
      phone: cleanPhoneNumber(phone),
      rawPhone: phone,
      website,
      lat: item.lat ?? center.lat ?? lat,
      lon: item.lon ?? center.lon ?? lon
    });

    return list;
  }, []);
}

function applyWebsiteFilter(items, websiteFilter) {
  if (websiteFilter === 'no_website') return items.filter(item => !item.website);
  if (websiteFilter === 'has_website') return items.filter(item => Boolean(item.website));
  return items;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }).end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Method tidak diizinkan. Gunakan POST.' }, {
      Allow: 'POST, OPTIONS'
    });
  }

  try {
    const body = req.body || {};
    const city = normalizeText(body.city);
    const category = normalizeText(body.category || 'all').toLowerCase() || 'all';
    const websiteFilter = ['all', 'no_website', 'has_website'].includes(body.websiteFilter)
      ? body.websiteFilter
      : 'no_website';

    if (!city) {
      return json(res, 400, { ok: false, error: 'Kota atau lokasi wajib diisi.' });
    }

    const cacheKey = JSON.stringify({ city: city.toLowerCase(), category, websiteFilter });
    const cached = memoryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return json(res, 200, { ...cached.payload, cached: true });
    }
    if (cached) memoryCache.delete(cacheKey);

    const geoData = await geocodeCity(city);
    if (!Array.isArray(geoData) || geoData.length === 0) {
      return json(res, 404, { ok: false, code: 'LOCATION_NOT_FOUND', error: 'Lokasi tidak ditemukan.' });
    }

    const location = geoData[0];
    const lat = Number.parseFloat(location.lat);
    const lon = Number.parseFloat(location.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return json(res, 502, { ok: false, error: 'Koordinat lokasi dari geocoder tidak valid.' });
    }

    const query = buildOverpassQuery(lat, lon, category);
    const overpassData = await queryOverpass(query);
    const parsed = parseBusinesses(overpassData.elements, city, lat, lon);
    const results = applyWebsiteFilter(parsed, websiteFilter);

    const payload = {
      ok: true,
      city,
      location: { lat, lon, displayName: location.display_name || city },
      results,
      count: results.length
    };

    memoryCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
    return json(res, 200, payload);
  } catch (error) {
    console.error('[api/search]', error);
    const status = Number.isInteger(error.status) ? error.status : 502;
    return json(res, status, {
      ok: false,
      code: 'SEARCH_PROVIDER_ERROR',
      error: error.message || 'Pencarian gagal diproses.',
      details: process.env.NODE_ENV === 'development' ? error.details : undefined
    });
  }
}
