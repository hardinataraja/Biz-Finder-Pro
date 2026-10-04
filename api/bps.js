// Vercel Serverless Function: /api/bps  (letakkan di folder: api/bps.js)
// Proxy ke BPS Web API resmi (https://webapi.bps.go.id). Format URL berbasis path:
//   https://webapi.bps.go.id/v1/api/list/model/{model}/domain/{domain}/var/{var}/th/{th}/key/{key}/
// Frontend cukup memanggil /api/bps?... dan tidak pernah melihat API key.

// =====================================================
// BPS API KEY
// Ganti nilai di bawah dengan API key BPS milik pengguna.
// Jangan menampilkan key ini ke frontend.
// =====================================================
const BPS_API_KEY = "PASTE_BPS_API_KEY_DI_SINI";

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

const BASE = 'https://webapi.bps.go.id/v1/api';
const SOURCE = 'BPS';
const TIMEOUT_MS = 25000;
const cache = makeCache('__bizBpsCache', 30 * 60 * 1000);

const MODELS = ['var', 'data', 'th', 'vervar', 'turvar', 'subject', 'unit', 'domain'];
const DOMAIN_TYPES = ['all', 'prov', 'kab', 'kabbyprov'];
const hasKey = () => typeof BPS_API_KEY === 'string' && BPS_API_KEY.trim() !== '' && !/^PASTE_/i.test(BPS_API_KEY.trim());

// Hapus key dari teks apa pun sebelum dikirim ke frontend.
const scrub = text => String(text == null ? '' : text).split(BPS_API_KEY).join('***').slice(0, 300);

// ---------- Validasi parameter ----------
function digits(value, label, max = 12) {
  const v = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(v) || v.length > max) throw makeError('Parameter ' + label + ' harus berupa angka.', { status: 400 });
  return v;
}

function buildRequest(q) {
  const domain = q.domain ? digits(q.domain, 'domain', 4) : '';
  const hasVar = q.var != null && q.var !== '';
  const model = cleanText(q.model || (hasVar ? 'data' : 'var'), 12).toLowerCase();
  if (!MODELS.includes(model)) throw makeError('Parameter model tidak didukung. Pilihan: ' + MODELS.join(', ') + '.', { status: 400 });

  const parts = [];
  let note = null;
  if (model === 'domain') {
    // Daftar wilayah/domain BPS
    const type = cleanText(q.type || 'all', 12).toLowerCase();
    if (!DOMAIN_TYPES.includes(type)) throw makeError('Parameter type tidak didukung. Pilihan: ' + DOMAIN_TYPES.join(', ') + '.', { status: 400 });
    parts.push('domain', 'type', type);
    if (q.prov) parts.push('prov', digits(q.prov, 'prov', 4));
  } else {
    if (!domain) throw makeError('Parameter domain wajib diisi, mis. /api/bps?domain=3500', { status: 400 });
    parts.push('list', 'model', model, 'domain', domain);
    if (hasVar) parts.push('var', digits(q.var, 'var'));
    if (q.vervar) parts.push('vervar', digits(q.vervar, 'vervar'));
    if (q.turvar) parts.push('turvar', digits(q.turvar, 'turvar'));
    if (q.th) parts.push('th', digits(q.th, 'th', 6));
    else if (q.year) {
      const year = parseInt(q.year, 10);
      if (!Number.isFinite(year) || year < 1901 || year > 2200) throw makeError('Parameter year tidak valid.', { status: 400 });
      // Periode BPS memakai ID (th). Untuk data tahunan, ID umumnya = tahun - 1900. Cek ID valid lewat model=th.
      parts.push('th', String(year - 1900));
      note = 'year dikonversi ke th=' + (year - 1900) + ' (konvensi data tahunan BPS). Gunakan model=th&var=<id> untuk melihat ID periode yang valid.';
    }
    if (q.keyword) parts.push('keyword', encodeURIComponent(cleanText(q.keyword, 60)));
    if (q.page) parts.push('page', String(intParam(q.page, 1, 1, 1000)));
    const lang = cleanText(q.lang || '', 3).toLowerCase();
    if (lang) { if (!['ind', 'eng'].includes(lang)) throw makeError('Parameter lang harus ind atau eng.', { status: 400 }); parts.push('lang', lang); }
  }
  return { path: parts.join('/'), model, note };
}

// ---------- Request ke BPS ----------
async function requestBps(path) {
  const url = BASE + '/' + path + '/key/' + encodeURIComponent(BPS_API_KEY.trim()) + '/';
  let payload;
  try {
    payload = await fetchJson(url, 'BPS', TIMEOUT_MS);
  } catch (err) {
    // 403 dari BPS umumnya berarti perlindungan bot/Cloudflare menolak IP server cloud.
    if (err.status === 502 && /HTTP 403|bukan JSON/.test(err.message)) {
      throw makeError('BPS menolak atau tidak membalas JSON untuk permintaan dari server ini (kemungkinan proteksi bot / key tidak valid).', { status: 502 });
    }
    throw makeError(scrub(err.message), { status: err.status || 502 });
  }
  if (payload && typeof payload === 'object' && String(payload.status).toLowerCase() === 'error') {
    const msg = scrub(payload.message || 'BPS mengembalikan error.');
    throw makeError(/key/i.test(msg) ? 'BPS API key tidak valid atau ditolak oleh BPS.' : 'BPS: ' + msg, { status: /key/i.test(msg) ? 401 : 502 });
  }
  return payload;
}

module.exports = async function handler(req, res) {
  if (!guard(req, res, SOURCE)) return;
  try {
    if (!hasKey()) return send(res, 503, { ok: false, source: SOURCE, error: 'BPS API key belum dikonfigurasi.' });
    const { path, model, note } = buildRequest(queryOf(req));

    const hit = cache.get(path);
    if (hit) return send(res, 200, { ...hit, cached: true });

    const data = await requestBps(path);
    const body = { ok: true, source: SOURCE, model, data };
    if (note) body.note = note;
    if (data && data['data-availability'] && data['data-availability'] !== 'available') body.message = 'BPS melaporkan data tidak tersedia untuk parameter ini.';
    cache.set(path, body);
    return send(res, 200, body);
  } catch (err) {
    return send(res, Number.isInteger(err.status) ? err.status : 502, { ok: false, source: SOURCE, error: scrub(err.message || 'BPS API tidak dapat diakses saat ini.') });
  }
};
module.exports.config = { maxDuration: 30 };
