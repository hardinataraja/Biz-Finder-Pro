// Vercel Serverless Function: /api/website-check
// Hanya cek ketersediaan website bisnis (HEAD, timeout pendek). Bukan port/security scan.
'use strict';
const dns = require('dns').promises;
const net = require('net');
const TIMEOUT_MS = 4000;
const MAX_URLS = 8;
const UA = 'BizFinderPro/1.2 (website availability check)';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || /^(fc|fd|fe80|::ffff:)/.test(v);
}

async function check(raw) {
  let u;
  try { u = new URL(raw); } catch { return { url: raw, status: 'invalid' }; }
  if (!/^https?:$/.test(u.protocol)) return { url: raw, status: 'invalid' };
  try {
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some(a => isPrivate(a.address))) return { url: raw, status: 'blocked' };
  } catch { return { url: raw, status: 'unreachable', reason: 'DNS' }; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    // redirect manual: respons 3xx cukup membuktikan situs aktif, dan tidak mengikuti redirect ke jaringan internal.
    const r = await fetch(u, { method: 'HEAD', redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': UA } });
    return { url: raw, status: r.status < 500 ? 'reachable' : 'unreachable', code: r.status };
  } catch (e) {
    return { url: raw, status: 'unreachable', reason: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { ok: false, error: 'Gunakan POST.' }); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const urls = Array.isArray(body && body.urls) ? [...new Set(body.urls.map(String))].slice(0, MAX_URLS) : [];
  if (!urls.length) return send(res, 400, { ok: false, error: 'Daftar url kosong.' });
  const results = await Promise.all(urls.map(check));
  return send(res, 200, { ok: true, results });
};
module.exports.config = { maxDuration: 15 };
