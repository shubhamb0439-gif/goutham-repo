// frontend/server.js
const path = require('path');
const fs = require('fs');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// Azure fix: bind to PORT first; keep your FRONTEND_PORT fallback for local
const PORT = process.env.PORT || process.env.FRONTEND_PORT || 3000;

// Hub (Socket.IO + any REST) target
const HUB = process.env.HUB_URL || 'http://localhost:8080';

const app = express();

/* -------------------------------------------
 * 1) Proxy Socket.IO HTTP + WebSocket
 * ----------------------------------------- */
const sioProxy = createProxyMiddleware('/socket.io', {
  target: HUB,
  changeOrigin: true,
  ws: true,
  logLevel: 'warn',
});
app.use(sioProxy);

/* -------------------------------------------
 * 2) Static assets + helpers
 * ----------------------------------------- */
const VIEWS_DIR  = path.join(__dirname, 'views');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Serve /public/* with correct MIME types (prevents "text/html" errors)
if (fs.existsSync(PUBLIC_DIR)) {
  app.use('/public', express.static(PUBLIC_DIR, { fallthrough: false }));
  console.log(`[STATIC] /public -> ${PUBLIC_DIR}`);
} else {
  console.warn(`[STATIC] missing: ${PUBLIC_DIR} — /public/* will 404`);
}

// Small helpers
const sendView   = (name) => (_req, res) => res.sendFile(path.join(VIEWS_DIR,  name));
const sendPublic = (name) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, name));

/* -------------------------------------------
 * 3) PWA bits (manifest + service worker)
 *    - Keep both URLs if you use both in HTML
 *    - If you only use /device.webmanifest, you can remove /manifest.webmanifest
 * ----------------------------------------- */

// If you actually have frontend/public/manifest.webmanifest keep this; otherwise remove.
app.get('/manifest.webmanifest', sendPublic('manifest.webmanifest'));

// Your tree shows sw-device.js at frontend/public/sw-device.js, not /public/js/...
// Expose both /sw.js and /device/sw.js to the same file so scope works under /device/
app.get(['/sw.js', '/device/sw.js'], (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'sw-device.js'));
});

// Device-scoped manifest (this file exists in your tree)
app.get('/device.webmanifest', (_req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(PUBLIC_DIR, 'device.webmanifest'));
});

/* -------------------------------------------
 * 4) No-cache for HTML (safe for XR flows)
 * ----------------------------------------- */
app.use((req, res, next) => {
  if (req.method === 'GET' && req.headers.accept && req.headers.accept.includes('text/html')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

/* -------------------------------------------
 * 5) Pretty routes → explicit view files
 * ----------------------------------------- */
app.get(['/device', '/device/'],             sendView('device.html'));
app.get(['/dashboard', '/dashboard/'],       sendView('dashboard.html'));
app.get(['/scribe-cockpit', '/scribe-cockpit/'], sendView('scribe-cockpit.html'));
// Legacy alias if you still link it anywhere
app.get(['/operator', '/operator/'],         sendView('operator.html'));

// Block direct .html access (optional hygiene)
app.get('/*.html', (_req, res) => res.status(404).send('Not found'));

/* -------------------------------------------
 * 6) Root → index.html (Dock UI)
 * ----------------------------------------- */
app.get('/', sendView('index.html'));

/* -------------------------------------------
 * 7) Start + WS upgrade
 * ----------------------------------------- */
const server = app.listen(PORT, () => {
  console.log(`🟢 Frontend (frontend/server.js) listening on ${PORT}`);
  console.log(`↪  Proxy /socket.io → ${HUB}/socket.io`);
});
server.on('upgrade', sioProxy.upgrade);
