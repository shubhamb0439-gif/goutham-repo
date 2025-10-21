// frontend/server.js
const path = require('path');
const http = require('http');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
 
const app = express();
 
/* -------------------- Local vs Public (no env vars) -------------------- */
// Local frontend port and hub
const LOCAL_PORT = 3000;
const LOCAL_HUB  = 'http://localhost:8080';
 
// Your public hub (Azure Apps)
const PUBLIC_HUB = 'https://xr-messaging-geexbheshbghhab7.centralindia-01.azurewebsites.net';
 
// Which hosts should be treated as "public" (request Host header, no port)
const PUBLIC_HOSTS = new Set([
  'xr-messaging-geexbheshbghhab7.centralindia-01.azurewebsites.net',
]);
 
// Decide hub per-request using Host header (never return undefined)
const resolveHub = (req) => {
  try {
    const hostHeader = (req && req.headers && req.headers.host) || '';
    const host = hostHeader.split(':')[0].toLowerCase();
    return PUBLIC_HOSTS.has(host) ? PUBLIC_HUB : LOCAL_HUB;
  } catch {
    return LOCAL_HUB;
  }
};
 
// Helpful startup logs
console.log('[FRONTEND] Public hosts:', Array.from(PUBLIC_HOSTS).join(', '));
console.log(`[FRONTEND] Local hub:   ${LOCAL_HUB}`);
console.log(`[FRONTEND] Public hub:  ${PUBLIC_HUB}`);
 
/* -------------------- 1) Proxy Socket.IO (HTTP + WebSocket) -------------------- */
// Cover both /socket.io and /socket.io/; choose target via router (no env needed)
const sioProxy = createProxyMiddleware(['/socket.io', '/socket.io/'], {
  target: LOCAL_HUB,          // initial value (overridden by router below)
  router: resolveHub,         // <-- switch to PUBLIC_HUB when Host is public
  changeOrigin: true,
  ws: true,
  logLevel: 'warn',
 
  onError: (err, req, res) => {
    console.error('[Socket.IO proxy error]', err?.message || err);
    // HTTP error path
    if (res && typeof res.writeHead === 'function' && typeof res.end === 'function') {
      try {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Socket proxy error (backend not reachable?)');
      } catch {}
      return;
    }
    // WebSocket upgrade path
    try { req?.socket?.destroy(); } catch {}
  },
 
  // Extra WS niceties
  onProxyReqWs: (_proxyReq, req, socket) => {
    socket.on('error', () => { try { socket.destroy(); } catch {} });
    if (!req.headers['connection']) _proxyReq.setHeader('Connection', 'Upgrade');
    if (!req.headers['upgrade'])    _proxyReq.setHeader('Upgrade', 'websocket');
  },
});
app.use(sioProxy);
 
/* -------------------- 2) Static assets and HTML routes (from /public) -------------------- */
const PUBLIC_DIR = path.join(__dirname, 'public');
 
// Serve assets at /public so your HTML references like /public/js/app.js work
app.use('/public', express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
 
// Helpers to send files (no-cache for HTML)
const sendHtml = (name) => (_req, res) => {
  const file = path.join(PUBLIC_DIR, name);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store, max-age=0'); // don't cache HTML
  res.sendFile(file);
};
const sendPublic = (name, type) => (_req, res) => {
  if (type) res.type(type);
  res.sendFile(path.join(PUBLIC_DIR, name));
};
 
/* -------------------- 3) PWA (Device) -------------------- */
app.get('/device.webmanifest', sendPublic('device.webmanifest', 'application/manifest+json'));
app.get('/sw-device.js',       sendPublic('sw-device.js',       'application/javascript'));
 
// Optional alias if you prefer /device/sw.js (keeps scope at /device/)
app.get('/device/sw.js', (_req, res) => {
  res.set('Service-Worker-Allowed', '/device/');
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'sw-device.js'));
});
 
/* -------------------- Keep HTML fresh (no caching) -------------------- */
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
    res.set('Cache-Control', 'no-store, max-age=0');
  }
  next();
});
 
/* -------------------- 4) Pretty routes → HTML in /public -------------------- */
app.get(['/device', '/device/'],                 sendHtml('device.html'));
app.get(['/dashboard', '/dashboard/'],           sendHtml('dashboard.html'));
app.get(['/scribe-cockpit', '/scribe-cockpit/'], sendHtml('scribe-cockpit.html'));
app.get(['/operator', '/operator/'],             sendHtml('operator.html')); // optional legacy
 
// Block direct .html access (e.g. /device.html)
app.get('/*.html', (_req, res) => res.status(404).type('text/plain').send('Not found'));
 
// Root → /public/index.html (Dock UI)
app.get('/', sendHtml('index.html'));
 
/* -------------------- 5) Start server + attach WS upgrade -------------------- */
const PORT = LOCAL_PORT; // no env vars — always 3000 for local; behind a proxy in prod
const server = app.listen(PORT, () => {
  console.log(`🟢 Frontend running at http://localhost:${PORT}`);
  console.log('↪  /socket.io routed per Host header');
  console.log(`    - Public hosts → ${PUBLIC_HUB}`);
  console.log(`    - Others       → ${LOCAL_HUB}`);
});
 
server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/socket.io')) {
    sioProxy.upgrade(req, socket, head);
  }
});