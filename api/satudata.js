// Vercel Serverless Function: /api/satudata  (letakkan di folder: api/satudata.js)
// Satu Data Indonesia (data.go.id) memakai CKAN Action API publik: package_search. Tanpa API key.
'use strict';

const UA = 'BizFinderPro/1.2 (+https://vercel.app)';
const g = globalThis;

// ---------- Helper (tanpa dependency, tanpa CORS terbuka: frontend & API satu domain Vercel) ----------
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function makeError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

function cleanText(value, max = 80) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').slice(0, max);
}

function intParam(value, def, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function queryOf(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try { return Object.fromEntries(new URL(req.url, 'http://localhost').searchParams); } catch { return {}; }
}

// Cache memori sederhana (hidup selama instance serverless masih hangat)
function makeCache(name, ttlMs, maxEntries = 100) {
  const store = g[name] || new Map();
  g[name] = store;
  return {
    get(key) {
      const hit = store.get(key);
      if (hit && hit.exp > Date.now()) return hit.value;
      if (hit) store.delete(key);
      return null;
    },
    set(key, value) {
      if (store.size >= maxEntries) store.delete(store.keys().next().value);
      store.set(key, { exp: Date.now() + ttlMs, value });
    }
  };
}

// Mengembalikan JSON dari upstream; tidak pernah meneruskan HTML/teks mentah.
async function fetchJson(url, label, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', ...headers }, signal: controller.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') throw makeError(label + ' timeout setelah ' + Math.round(timeoutMs / 1000) + ' detik.', { status: 504 });
      const code = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || 'network error';
      throw makeError(label + ' tidak dapat diakses (' + String(code).slice(0, 80) + ').', { status: 502 });
    }
    const text = await response.text();
    if (!response.ok) {
      const status = response.status;
      const msg = status === 429 ? label + ': rate limit tercapai (HTTP 429). Coba lagi beberapa saat.'
        : status === 404 ? label + ': endpoint tidak ditemukan (HTTP 404).'
        : status === 401 || status === 403 ? label + ': akses ditolak (HTTP ' + status + ').'
        : status >= 500 ? label + ': server sedang bermasalah (HTTP ' + status + ').'
        : label + ': permintaan ditolak (HTTP ' + status + ').';
      throw makeError(msg, { status: status === 429 ? 429 : 502 });
    }
    try { return JSON.parse(text); } catch {
      throw makeError(label + ': respons bukan JSON valid (endpoint mungkin berubah atau diblokir).', { status: 502 });
    }
  } finally {
    clearTimeout(timer);
  }
}

function guard(req, res, source) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.setHeader('Allow', 'GET, OPTIONS'); res.end(); return false; }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); send(res, 405, { ok: false, source, error: 'Method tidak diizinkan. Gunakan GET.' }); return false; }
  return true;
}

// ---------- CKAN package_search -> struktur sederhana ----------
function pickFormats(resources) {
  const set = new Set((resources || []).map(r => r && r.format ? String(r.format).trim().toUpperCase() : '').filter(Boolean));
  return set.size ? [...set].join(', ') : null;
}

function normalizeDataset(d, portalBase, sourceLabel) {
  const name = d.name || d.id || null;
  const text = v => (v == null || String(v).trim() === '' ? null : String(v).trim());
  return {
    title: text(d.title) || text(d.name),
    description: text(d.notes) ? String(d.notes).trim().slice(0, 400) : null,
    organization: d.organization && text(d.organization.title) ? text(d.organization.title) : null,
    format: pickFormats(d.resources),
    url: name ? portalBase + '/dataset/' + encodeURIComponent(name) : null,
    dataset: text(d.name),
    updated: text(d.metadata_modified),
    source: sourceLabel
  };
}

function parseSearch(payload) {
  if (!payload || payload.success !== true || !payload.result || !Array.isArray(payload.result.results)) {
    throw makeError('Struktur respons CKAN tidak dikenali.', { status: 502 });
  }
  return payload.result;
}

// data.go.id sudah bermigrasi ke portal baru (bukan CKAN lagi), sehingga /api/3/action di sana 404.
// Katalog CKAN lama tetap di katalog.data.go.id.
const PORTALS = [
  { base: 'https://katalog.data.go.id', api: 'https://katalog.data.go.id/api/3/action/package_search' }
];
const SOURCE = 'Satu Data Indonesia';
const TIMEOUT_MS = 20000;
const cache = makeCache('__bizSatuDataCache', 10 * 60 * 1000);

module.exports = async function handler(req, res) {
  if (!guard(req, res, SOURCE)) return;
  const q = queryOf(req);
  const query = cleanText(q.q);
  if (!query) return send(res, 400, { ok: false, source: SOURCE, error: 'Parameter q wajib diisi, mis. /api/satudata?q=UMKM' });
  const limit = intParam(q.limit, 10, 1, 50);
  const page = intParam(q.page, 1, 1, 1000);

  const key = JSON.stringify([query.toLowerCase(), limit, page]);
  const hit = cache.get(key);
  if (hit) return send(res, 200, { ...hit, cached: true });

  const failures = [];
  let lastStatus = 502;
  for (const portal of PORTALS) {
    const url = new URL(portal.api);
    url.searchParams.set('q', query);
    url.searchParams.set('rows', String(limit));
    url.searchParams.set('start', String((page - 1) * limit));
    try {
      const result = parseSearch(await fetchJson(url.toString(), new URL(portal.base).host, TIMEOUT_MS));
      const results = result.results.map(d => normalizeDataset(d, portal.base, SOURCE));
      const body = { ok: true, source: SOURCE, query, page, limit, total: Number.isFinite(result.count) ? result.count : null, count: results.length, results };
      if (!results.length) body.message = 'Tidak ada dataset yang cocok untuk kata kunci ini.';
      cache.set(key, body);
      return send(res, 200, body);
    } catch (err) {
      failures.push(err.message);
      lastStatus = err.status || 502;
    }
  }
  return send(res, lastStatus === 429 ? 429 : lastStatus === 504 ? 504 : 502, { ok: false, source: SOURCE, error: 'Satu Data Indonesia tidak dapat diakses saat ini.', details: failures });
};
module.exports.config = { maxDuration: 30 };
