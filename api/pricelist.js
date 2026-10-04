// Vercel Serverless Function: /api/pricelist  (letakkan di folder: api/pricelist.js)
// Modul PRICE INTELLIGENCE berbasis adapter. Sengaja TIDAK ada sumber harga bawaan:
// belum ada sumber harga publik yang terverifikasi stabil & boleh dipakai, jadi tidak ada harga yang dikarang.
// Tambahkan sumber nyata ke PRICE_SOURCES di bawah setelah memastikan lisensi/ToS-nya mengizinkan.

// Isi hanya jika sumber harga yang Anda tambahkan memang membutuhkan API key.
const PRICE_API_KEY = "PASTE_PRICE_API_KEY_DI_SINI";

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
      throw makeError(label + ' tidak dapat diakses saat ini.', { status: 502 });
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

const SOURCE = 'Price Intelligence';
const TIMEOUT_MS = 20000;
const cache = makeCache('__bizPriceCache', 10 * 60 * 1000);
const hasPriceKey = () => typeof PRICE_API_KEY === 'string' && PRICE_API_KEY.trim() !== '' && !/^PASTE_/i.test(PRICE_API_KEY.trim());

// Kontrak adapter:
// PRICE_SOURCES.namaSumber = {
//   name: 'Nama sumber',            // tampil di response
//   needsKey: false,                // true bila butuh PRICE_API_KEY
//   supports: (q) => boolean,       // apakah sumber ini relevan untuk query q
//   fetch: async ({ q, location, page, limit, apiKey, fetchJson }) => [
//     { product, price, unit, currency: 'IDR', location, date, url, source }   // field yang tidak ada -> null
//   ]
// };
const PRICE_SOURCES = {
  // (kosong: belum ada sumber harga publik yang terverifikasi)
};

module.exports = async function handler(req, res) {
  if (!guard(req, res, SOURCE)) return;
  const q = queryOf(req);
  const query = cleanText(q.q);
  if (!query) return send(res, 400, { ok: false, source: SOURCE, error: 'Parameter q wajib diisi, mis. /api/pricelist?q=beras' });
  const location = cleanText(q.location, 60) || null;
  const limit = intParam(q.limit, 20, 1, 100);
  const page = intParam(q.page, 1, 1, 1000);

  const key = JSON.stringify([query.toLowerCase(), (location || '').toLowerCase(), limit, page]);
  const hit = cache.get(key);
  if (hit) return send(res, 200, { ...hit, cached: true });

  const results = [];
  const warnings = [];
  const used = [];
  for (const id of Object.keys(PRICE_SOURCES)) {
    const s = PRICE_SOURCES[id];
    try {
      if (!s || typeof s.fetch !== 'function' || (s.supports && !s.supports(query))) continue;
      if (s.needsKey && !hasPriceKey()) { warnings.push((s.name || id) + ': PRICE_API_KEY belum dikonfigurasi.'); continue; }
      const rows = await s.fetch({ q: query, location, page, limit, apiKey: hasPriceKey() ? PRICE_API_KEY.trim() : null,
        fetchJson: (url, headers) => fetchJson(url, s.name || id, TIMEOUT_MS, headers) });
      used.push(s.name || id);
      for (const r of Array.isArray(rows) ? rows : []) {
        results.push({ product: r.product == null ? null : r.product, price: Number.isFinite(r.price) ? r.price : null, unit: r.unit || null, currency: r.currency || null,
          location: r.location || null, date: r.date || null, url: r.url || null, source: r.source || s.name || id });
      }
    } catch (err) {
      warnings.push((s && s.name || id) + ': ' + String(err.message || 'gagal').replace(PRICE_API_KEY, '***').slice(0, 200));
    }
  }

  const body = { ok: true, source: SOURCE, query, location, page, limit, count: Math.min(results.length, limit), results: results.slice(0, limit), sources: used };
  if (warnings.length) body.warnings = warnings;
  if (!results.length) body.message = 'Belum tersedia sumber harga publik yang kompatibel untuk query ini.';
  cache.set(key, body);
  return send(res, 200, body);
};
module.exports.config = { maxDuration: 30 };
