// Local stand-in for the Vercel api/ functions: node scripts/dev-relay.mjs
import http from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT) || 8787;
const NAMES = new Set(['exposures', 'gaia', 'resolve', 'wise']);

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const m = /^\/api\/([a-z]+)\/?$/.exec(url.pathname);
  if (!m || !NAMES.has(m[1])) return jsonResponse(res, 404, { error: { code: 'NOT_FOUND', message: 'no such route' } });

  let mod;
  try {
    mod = await import(new URL(`../api/${m[1]}.js?t=${Date.now()}`, import.meta.url).href);
  } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(`${m[1]}.js`)) {
      return jsonResponse(res, 404, { error: { code: 'NOT_FOUND', message: `api/${m[1]}.js is missing` } });
    }
    console.error(e);
    return jsonResponse(res, 500, { error: { code: 'UPSTREAM_ERROR', message: 'module failed to load' } });
  }

  const method = (req.method || 'GET').toUpperCase();
  const fn = method === 'OPTIONS' ? mod.OPTIONS : method === 'HEAD' ? mod.HEAD || mod.GET : mod[method];
  if (typeof fn !== 'function') {
    return jsonResponse(res, 405, { error: { code: 'BAD_INPUT', message: 'method not allowed' } });
  }

  const request = new Request(url, { method: method === 'HEAD' ? 'GET' : method, headers: req.headers });
  const response = await fn(request);
  const headers = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(response.status, headers);
  if (method === 'HEAD' || !response.body) return res.end();
  Readable.fromWeb(response.body).pipe(res);
}

http
  .createServer(async (req, res) => {
    const t0 = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - t0}ms`);
    });
    try {
      await handle(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) jsonResponse(res, 500, { error: { code: 'UPSTREAM_ERROR', message: 'relay failure' } });
      else res.end();
    }
  })
  .listen(PORT, () => console.log(`dev relay on http://localhost:${PORT}/api/{${[...NAMES].join(',')}}`));
