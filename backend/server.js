// ---------------------------------------------Server.js ----------------------------------------------------

// ========================================
// CRITICAL: Load environment variables FIRST
// ========================================
// This MUST be the first require() to ensure
// all env vars are available before any other module
const envLoader = require('./config/env-loader');

// -------------------- Imports & Env --------------------
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const axios = require('axios'); // for SOAP note generation
const sql = require('mssql');   // MSSQL driver
const { Sequelize } = require('sequelize');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const nodemailer = require('nodemailer');

const { sequelize, connectToDatabase, closeDatabase } = require('./database/database-config');
const { getAzureSqlConnection } = require('./database/azure-db-helper');



console.log('[BOOT] Instance:', process.env.WEBSITE_INSTANCE_ID || process.pid);

// -------------------- Debug helpers --------------------
const DEBUG_LOGS = (process.env.DEBUG_LOGS || 'true').toLowerCase() === 'true';
function dlog(...args) {
  if (DEBUG_LOGS) console.log(...['[DEBUG]'].concat(args));
}
function dwarn(...args) {
  console.warn(...['[WARN]'].concat(args));
}
function derr(...args) {
  console.error(...['[ERROR]'].concat(args));
}
function trimStr(s, max = 140) {
  if (typeof s !== 'string') return s;
  return s.length > max ? `${s.slice(0, max)}…(${s.length})` : s;
}
function safeDataPreview(obj) {
  try {
    const s = JSON.stringify(obj);
    return trimStr(s, 300);
  } catch {
    return '[unserializable]';
  }
}

// NEW: numeric coercion helper for telemetry
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// --- Safe global socket snapshot (fast-fail + local fallback) ---
async function safeFetchSockets(io, namespace = "/") {
  const nsp = io.of(namespace);

  // Always include local sockets immediately (never blocks)
  const local = Array.from(nsp.sockets?.values?.() || []);

  const adapter = nsp.adapter;
  const supportsGlobal = typeof nsp.fetchSockets === "function" && adapter && adapter.broadcast?.apply;
  if (!supportsGlobal) return local;

  try {
    // Short guard so device-list / identify / health never stall on a stale peer
    const guard = new Promise((_, reject) => setTimeout(() => reject(new Error("guard-timeout")), 750));
    const globalSockets = await Promise.race([nsp.fetchSockets(), guard]);

    // Merge local + global by socket.id
    const byId = new Map(local.map(s => [s.id, s]));
    for (const s of globalSockets) byId.set(s.id, s);
    return Array.from(byId.values());
  } catch (e) {
    console.warn("[WARN] [safeFetchSockets] global fetch failed; using local only:", e.message);
    return local;
  }
}


// -------------------- Env Flags --------------------
const IS_PROD =
  (process.env.NODE_ENV || '').toLowerCase().startsWith('prod') ||
  !!process.env.WEBSITE_SITE_NAME; // Azure sets this

// -------------------- Config & Servers --------------------
console.log('[INIT] Starting server initialization...');
const PORT = process.env.PORT || 8080;
console.log(`[CONFIG] Using port: ${PORT}`);

// (DO NOT redeclare IS_PROD here — use the one already defined above)

const app = express();

// Azure App Service runs behind a reverse proxy (TLS terminated upstream)
if (IS_PROD) {
  app.set('trust proxy', 1);
}

const server = http.createServer(app);
console.log('[HTTP] Server created');

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'], // include polling
  allowEIO3: true,
  pingInterval: 25000,
  pingTimeout: 30000,
});

console.log('[SOCKET.IO] Socket.IO server initialized');


// -------------------- Middleware --------------------
app.use(cors());
app.use(express.json());
console.log('[MIDDLEWARE] CORS + JSON enabled');

// -------------------- Session Store (Prod: Redis) --------------------
let sessionStore;

if (IS_PROD && process.env.REDIS_URL) {
  const connectRedis = require('connect-redis');
  // connect-redis v9 CommonJS: class is usually at .RedisStore
  const RedisStore = connectRedis.RedisStore || connectRedis.default || connectRedis;

  const sessionRedis = createClient({
    url: process.env.REDIS_URL,
    socket: {
      tls: (process.env.REDIS_URL || '').startsWith('rediss://'),
    },
  });

  sessionRedis.on('error', (err) =>
    console.error('[SESSION][REDIS] error', err)
  );

  sessionRedis.connect().then(
    () => console.log('[SESSION][REDIS] connected'),
    (err) =>
      console.error(
        '[SESSION][REDIS] connect failed (continuing)',
        err?.message || err
      )
  );

  sessionStore = new RedisStore({
    client: sessionRedis,
    prefix: 'sess:',
  });
}


// Session middleware for platform admin
const sessionSecret = process.env.SESSION_SECRET || 'change-me-in-production';
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,

    // ✅ critical for Azure scale-out / restarts
    store: sessionStore || undefined,

    // helps when behind proxy (pairs with trust proxy)
    proxy: IS_PROD,

    cookie: {
      httpOnly: true,

      // ✅ REQUIRED for HTTPS + Azure proxy
      sameSite: IS_PROD ? 'none' : 'lax',
      secure: IS_PROD,

      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

console.log('[MIDDLEWARE] Session enabled');

// ✅ Connect to Azure SQL via Sequelize on boot (non-fatal if it fails)
(async () => {
  try {
    await connectToDatabase();
    console.log('🚀 [DB] Azure SQL connection established');
  } catch (err) {
    console.error('❌ [DB] Failed to connect to Azure SQL (continuing without DB):', err?.message || err);
    // NOTE: Do not exit; server keeps running without DB.
  }
})();


// // -------------------- UI routes (migrated from frontend/server.js) --------------------
// 🧩 Paths
const FRONTEND_VIEWS = path.join(__dirname, '..', 'frontend', 'views');
const FRONTEND_PUBLIC = path.join(__dirname, '..', 'frontend', 'public');
const BACKEND_PUBLIC = path.join(__dirname, 'public');

// 🧠 Choose which directory actually exists
const VIEWS_DIR = fs.existsSync(FRONTEND_VIEWS) ? FRONTEND_VIEWS : BACKEND_PUBLIC;
const PUBLIC_DIR = fs.existsSync(FRONTEND_PUBLIC) ? FRONTEND_PUBLIC : BACKEND_PUBLIC;

app.use('/public', express.static(PUBLIC_DIR));
console.log(`[STATIC] Serving UI assets from ${PUBLIC_DIR}`);

// Keep HTML fresh (safe for XR flows)
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

const sendView = (name) => (_req, res) => {
  const filePath = path.join(VIEWS_DIR, name);
  if (!fs.existsSync(filePath)) {
    console.warn(`[WARN] Missing view: ${filePath}`);
    return res.status(404).send(`View not found: ${name}`);
  }

  try {
    const html = fs.readFileSync(filePath, 'utf8');

    // inject TURN config if function available
    const injected = (typeof injectTurnConfig === 'function')
      ? injectTurnConfig(html)
      : html;

    // Make sure the result is HTML
    res.type('html').send(injected);
  } catch (err) {
    console.error('[sendView] error reading / sending view:', err);
    res.status(500).send('Server error');
  }
};

// PWA assets — keep this ABOVE any /device HTML route
// Serve both common manifest URLs, but point both to device.webmanifest
app.get(['/manifest.webmanifest', '/device.webmanifest'], (req, res) => {
  res.type('application/manifest+json');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'device.webmanifest')); // file exists here
});

// Map ALL service-worker entrypoints to the same script
app.get(['/sw.js', '/sw-device.js', '/device/sw.js'], (req, res) => {
  res.type('application/javascript');
  res.set('Service-Worker-Allowed', '/device/');             // allow /device/* scope
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'sw-device.js'));       // NOTE: no /js subfolder
});


// Pretty routes → views
app.get(['/device', '/device/'], sendView('device.html'));
app.get(['/dashboard', '/dashboard/'], sendView('dashboard.html'));
app.get(['/scribe-cockpit', '/scribe-cockpit/'], sendView('scribe-cockpit.html'));
app.get(['/operator', '/operator/'], sendView('operator.html'));
app.get(['/platform', '/platform/'], sendView('platform.html'));
app.get('/', sendView('index.html'));




// -------------------- Static --------------------
// Frontend now serves all UI. Do NOT expose ../frontend here.
const backendPublic = path.join(__dirname, 'public');
if (fs.existsSync(backendPublic)) {
  app.use(express.static(backendPublic)); // keep only if you really have backend-only assets
  console.log(`[STATIC] Serving static from ${backendPublic}`);
} else {
  dlog('[STATIC] backend/public not found');
}

// -------------------- TURN Injection --------------------
function injectTurnConfig(html) {
  const raw = (process.env.TURN_URL || '').split(/[,\s]+/).filter(Boolean);

  const expand = (u) => {
    if (!u) return [];
    // If full turn/turns URL provided, use as-is
    if (/^(stun|turns?):/i.test(u)) return [u];
    // If only a host was given (e.g. "turn.example.com"), synthesize common variants.
    const host = String(u).replace(/:\d+$/, '');
    return [
      `turns:${host}:443?transport=tcp`,   // <- critical for iOS/corporate/captive networks
      `turns:${host}:5349?transport=tcp`,
      `turn:${host}:3478?transport=tcp`,
      `turn:${host}:3478?transport=udp`
    ];
  };

  // Flatten all provided items (comma/space separated env)
  const urls = raw.flatMap(expand);

  const cfg = `
    <script>
      window.TURN_CONFIG = {
        urls: ${urls.length <= 1 ? JSON.stringify(urls[0] || '') : JSON.stringify(urls)},
        username: ${JSON.stringify(process.env.TURN_USERNAME || '')},
        credential: ${JSON.stringify(process.env.TURN_CREDENTIAL || '')}
      };
    </script>`;

  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${cfg}\n</body>`) : (html + cfg);
}



// -------------------- Room Concept State --------------------
const clients = new Map();        // xrId -> socket
const desktopClients = new Map(); // xrId -> desktop socket
const onlineDevices = new Map();  // xrId -> socket (convenience)
// NEW: latest battery snapshot per device
const batteryByDevice = new Map(); // xrId -> { pct, charging, ts }

// NEW: latest network telemetry per device
// shape: { xrId, connType, wifiDbm, wifiMbps, wifiBars, cellDbm, cellBars, ts }
const telemetryByDevice = new Map();

const qualityByDevice = new Map(); // xrId -> latest webrtc quality snapshot

dlog('[ROOM] State maps initialized');

// --- Time-series history for charts (keep last 24 hours) ---
const METRIC_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const telemetryHist = new Map(); // xrId -> [{ ts, connType, wifiMbps, netDownMbps, netUpMbps, batteryPct }]
const qualityHist = new Map();   // xrId -> [{ ts, jitterMs, rttMs, lossPct, bitrateKbps }]


function pushHist(map, xrId, sample) {
  const arr = map.get(xrId) || [];
  arr.push(sample);
  const cutoff = Date.now() - METRIC_WINDOW_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
  map.set(xrId, arr);
}


// ===============================
// Option B: DB-driven 1:1 pairing
// ===============================

// In-memory exclusivity map (case-insensitive keys)
// key = normalized xrId (lowercase)
// value = normalized partner xrId (lowercase)
const pairedWith = new Map();

function normXr(x) {
  return String(x || '').trim().toUpperCase();
}

// Normalize pair for comparisons / uniqueness (case-insensitive)
function normalizePair(a, b) {
  return [normXr(a), normXr(b)].sort().join('|');
}

// Canonical room id for a pair (case-insensitive room naming)
function getRoomIdForPair(a, b) {
  const [one, two] = [normXr(a), normXr(b)].sort();
  const roomId = `pair:${one}:${two}`;
  dlog('[ROOM] getRoomIdForPair', a, b, '=>', roomId);
  return roomId;
}

// Helper: find an online socket by xrId (case-insensitive) using your existing clients Map
function getClientSocketByXrIdCI(xrId) {
  const wanted = normXr(xrId);
  for (const [key, sock] of clients.entries()) {
    if (normXr(key) === wanted) return sock;
  }
  return null;
}

// Helper: clear pairing on disconnect (we will call this in disconnect later)
function clearPairByXrId(xrId) {
  const me = normXr(xrId);
  const partner = pairedWith.get(me);
  if (partner) pairedWith.delete(partner);
  pairedWith.delete(me);
  return partner || null;
}

function isAlreadyPaired(xrId) {
  return pairedWith.has(normXr(xrId));
}

function listRoomMembers(roomId) {
  const set = io.sockets.adapter.rooms.get(roomId);
  if (!set) {
    dlog('[ROOM] listRoomMembers: empty for', roomId);
    return [];
  }
  const members = Array.from(set).map((sid) => {
    const s = io.sockets.sockets.get(sid);
    return s?.data?.xrId || sid;
  });
  dlog('[ROOM] listRoomMembers', roomId, '=>', members);
  return members;
}

function collectPairs() {
  const pairs = [];
  for (const [roomId] of io.sockets.adapter.rooms) {
    if (!roomId.startsWith('pair:')) continue;
    const members = listRoomMembers(roomId); // returns xrIds (original casing)
    if (members.length >= 2) {
      const key = normalizePair(members[0], members[1]); // case-insensitive
      const [a, b] = key.split('|');
      pairs.push({ a, b }); // will be normalized (lowercase)
    }
  }
  return pairs;
}

function broadcastPairs() {
  const pairs = collectPairs();
  io.emit('room_update', { pairs });
  dlog('[PAIR] broadcastPairs:', pairs);
}

// ---- DB resolvers using Sequelize (you already use sequelize.query elsewhere) ----
// NOTE: This assumes `sequelize` and `Sequelize` are in scope in server.js (they are in your existing routes).

async function resolveUserIdByXrId(xrId) {
  const xr = normXr(xrId);
  if (!xr) return null;

  const rows = await sequelize.query(
    `
      SELECT TOP 1 id
      FROM System_Users
      WHERE row_status = 1
        AND LOWER(LTRIM(RTRIM(xr_id))) = :xr
    `,
    { replacements: { xr }, type: Sequelize.QueryTypes.SELECT }
  );

  return rows?.[0]?.id ?? null;
}

async function resolvePartnerUserId(userId) {
  if (!userId) return null;

  const rows = await sequelize.query(
    `
      SELECT TOP 1
        CASE
          WHEN scribe_user_id = :userId THEN provider_user_id
          WHEN provider_user_id = :userId THEN scribe_user_id
          ELSE NULL
        END AS partnerUserId
      FROM Scribe_Provider_Mapping
      WHERE row_status = 1
        AND (:userId IN (scribe_user_id, provider_user_id))
      ORDER BY id DESC
    `,
    { replacements: { userId }, type: Sequelize.QueryTypes.SELECT }
  );

  return rows?.[0]?.partnerUserId ?? null;
}

async function resolveXrIdByUserId(userId) {
  if (!userId) return null;

  const rows = await sequelize.query(
    `
      SELECT TOP 1 xr_id
      FROM System_Users
      WHERE row_status = 1
        AND id = :userId
    `,
    { replacements: { userId }, type: Sequelize.QueryTypes.SELECT }
  );

  const xr = rows?.[0]?.xr_id;
  return xr ? String(xr).trim() : null;
}

async function tryDbAutoPair(deviceId) {
  dlog('[DB_AUTO_PAIR] attempt for', deviceId);

  if (isAlreadyPaired(deviceId)) {
    const stalePartner = clearPairByXrId(deviceId);
    dlog('[DB_AUTO_PAIR] cleared stale pairing for', deviceId, 'oldPartner=', stalePartner);

    // Also clear stale socket roomId state (safe even if already null)
    const meSock = getClientSocketByXrIdCI(deviceId);
    if (meSock) meSock.data.roomId = null;

    if (stalePartner) {
      const pSock = getClientSocketByXrIdCI(stalePartner);
      if (pSock) pSock.data.roomId = null;
    }

    // Do NOT return; continue attempting fresh DB pairing
  }



  const myUserId = await resolveUserIdByXrId(deviceId);
  dlog('[DB_AUTO_PAIR] myUserId:', myUserId);
  if (!myUserId) return false;

  const partnerUserId = await resolvePartnerUserId(myUserId);
  dlog('[DB_AUTO_PAIR] partnerUserId:', partnerUserId);
  if (!partnerUserId) return false;

  const partnerId = await resolveXrIdByUserId(partnerUserId);
  dlog('[DB_AUTO_PAIR] partnerId:', partnerId);
  const partnerXr = normXr(partnerId);
  if (!partnerXr) return false;

  const meXr = normXr(deviceId);
  if (meXr === partnerXr) {
    dlog('[DB_AUTO_PAIR] mapping points to self; refusing', { deviceId, partnerXr });
    return false;
  }

  const meSocket = getClientSocketByXrIdCI(deviceId);
  const partnerSocket = getClientSocketByXrIdCI(partnerXr);
  dlog('[DB_AUTO_PAIR] me?', !!meSocket, 'partner?', !!partnerSocket);
  if (!meSocket || !partnerSocket) return false;

  if (isAlreadyPaired(deviceId) || isAlreadyPaired(partnerXr)) {
    dlog('[DB_AUTO_PAIR] one side already paired, skipping');
    return false;
  }

  const roomId = getRoomIdForPair(deviceId, partnerXr);
  const room = io.sockets.adapter.rooms.get(roomId);
  const memberCount = room ? room.size : 0;
  dlog('[DB_AUTO_PAIR] roomId:', roomId, 'current members:', memberCount, '(not used to block pairing)');


  await meSocket.join(roomId);
  await partnerSocket.join(roomId);

  meSocket.data.roomId = roomId;
  partnerSocket.data.roomId = roomId;

  pairedWith.set(meXr, partnerXr);
  pairedWith.set(partnerXr, meXr);

  dlog('[DB_AUTO_PAIR] joined both to', roomId);

  const members = listRoomMembers(roomId);
  io.to(roomId).emit('room_joined', { roomId, members });

  await broadcastDeviceList(roomId);



  broadcastPairs();
  return true;
}


// -------------------- Utilities --------------------
function roomOf(xrId) {
  return `xr:${normXr(xrId)}`;
}

const messageHistory = [];
dlog('[STATE] messageHistory initialized');




async function buildDeviceListGlobal() {
  dlog('[DEVICE_LIST] building (global via fetchSockets)');
  const sockets = await safeFetchSockets(io, "/");
  const byId = new Map();

  for (const s of sockets) {
    const id = s?.data?.xrId;
    if (!id) continue;

    // Pull latest battery snapshot if we have one
    const b = batteryByDevice?.get(id) || {};
    // 🔵 NEW: network telemetry snapshot
    const t = telemetryByDevice?.get(id) || null;

    byId.set(id, {
      xrId: id,
      deviceName: s.data?.deviceName || 'Unknown',
      // Battery fields
      battery: (typeof b.pct === 'number') ? b.pct : null,
      charging: !!b.charging,
      batteryTs: b.ts || null,
      // 🔵 Telemetry fields (optional)
      ...(t ? { telemetry: t } : {}),
    });
  }

  const list = [...byId.values()];
  dlog('[DEVICE_LIST] built:', list);
  return list;
}

// ✅ NEW: Build device list strictly for a given room (pair isolation)
async function buildDeviceListForRoom(roomId) {
  dlog('[DEVICE_LIST] building (room via fetchSockets):', roomId);
  if (!roomId) return [];

  const sockets = await safeFetchSockets(io, "/");
  const byId = new Map();

  for (const s of sockets) {
    // ✅ Only include sockets that are actually in this room
    if (!s?.rooms?.has(roomId)) continue;

    const id = s?.data?.xrId;
    if (!id) continue;

    const b = batteryByDevice?.get(id) || {};
    const t = telemetryByDevice?.get(id) || null;

    byId.set(id, {
      xrId: id,
      deviceName: s.data?.deviceName || 'Unknown',
      battery: (typeof b.pct === 'number') ? b.pct : null,
      charging: !!b.charging,
      batteryTs: b.ts || null,
      ...(t ? { telemetry: t } : {}),
    });
  }

  const list = [...byId.values()];

  // ✅ Enforce strict one-to-one pair: max 2 devices
  if (list.length > 2) {
    dwarn('[DEVICE_LIST] Room has >2 members (should never happen):', roomId, list.map(x => x.xrId));
    return list.slice(0, 2);
  }

  dlog('[DEVICE_LIST] built (room):', roomId, list);
  return list;
}



// ✅ Updated: can broadcast globally (default) OR to a specific room if roomId is provided
async function broadcastDeviceList(roomId) {
  dlog('[DEVICE_LIST] broadcast start', roomId ? `(room: ${roomId})` : '(global)');
  try {
    const list = roomId ? await buildDeviceListForRoom(roomId) : await buildDeviceListGlobal();

    if (roomId) {
      io.to(roomId).emit('device_list', list);  // ✅ room-only
    } else {
      io.emit('device_list', list);             // ✅ unchanged global behavior
    }

    dlog('[DEVICE_LIST] broadcast done (size:', list.length, ')', roomId ? `(room: ${roomId})` : '(global)');
  } catch (e) {
    dwarn('[DEVICE_LIST] Failed to build list:', e.message);
  }
}


// ✅ Updated: can broadcast empty list globally (default) OR to a specific room if roomId is provided
function broadcastEmptyDeviceListOnce(roomId) {
  try {
    if (roomId) {
      dlog('[DEVICE_LIST] broadcasting EMPTY list (room):', roomId);
      io.to(roomId).emit('device_list', []);
    } else {
      dlog('[DEVICE_LIST] broadcasting EMPTY list (blackout/global)');
      io.emit('device_list', []); // ✅ unchanged global behavior
    }
  } catch (e) {
    dwarn('[DEVICE_LIST] empty broadcast failed:', e.message);
  }
}


function addToMessageHistory(message) {
  messageHistory.push({ ...message, id: Date.now(), timestamp: new Date().toISOString() });
  if (messageHistory.length > 100) {
    messageHistory.shift();
  }
  dlog('[MSG_HISTORY] added; len=', messageHistory.length);
}

// -------------------- Routes --------------------
app.get('/health', async (_req, res) => {
  dlog('[HEALTH] request');
  try {
    const sockets = await safeFetchSockets(io, "/");
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      instanceId: process.env.WEBSITE_INSTANCE_ID || process.pid,
      connectedClients: sockets.length,
    });
  } catch {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      instanceId: process.env.WEBSITE_INSTANCE_ID || process.pid,
      connectedClients: 'unknown',
    });
  }
});

app.post('/api/medications/availability', async (req, res) => {
  dlog('[MEDICATION_API] request received');
  try {
    const { names } = req.body;

    if (!Array.isArray(names)) {
      return res.status(400).json({ error: 'Expected "names" array in request body' });
    }

    if (names.length === 0) {
      return res.json({ results: [] });
    }

    dlog(`[MEDICATION_API] Checking ${names.length} medication(s)`);

    const schema = 'dbo';
    const table = 'DrugMaster';
    const nameCol = 'drug';

    function normalizeTerm(s) {
      return String(s || '')
        .toLowerCase()
        .replace(/[ \-\/\.,'()]/g, '');
    }

    function extractDrugQuery(raw) {
      if (!raw) return null;
      let s = String(raw)
        .replace(/^[-•]\s*/u, '')
        .replace(/\(.*?\)/g, '')
        .replace(/\b(tablet|tablets|tab|tabs|capsule|capsules|cap|caps|syrup|susp(?:ension)?|inj(?:ection)?)\b/gi, '')
        .replace(/\b(po|od|bd|tid|qid|prn|q\d+h|iv|im|sc|sl)\b/gi, '')
        .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|kg|ml|l|iu|units|%)\b/gi, '')
        .split(/\b\d/)[0]
        .replace(/[.,;:/]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return s || null;
    }

    async function findDrugMatch(q) {
      const raw = String(q || '').trim();
      const rawLike = `%${raw}%`;
      const norm = normalizeTerm(raw);
      const normLike = `%${norm}%`;

      const normExpr = `
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(
                      REPLACE(LOWER([${nameCol}]), '-', ''), ',', ''), '/', ''), '.', ''), '''', ''), ' ', ''), '(', ''), ')', '')
      `;

      const sql = `
        SELECT TOP 1 [${nameCol}] AS name
        FROM [${schema}].[${table}]
        WHERE status = 1
          AND [${nameCol}] IS NOT NULL
          AND (
            LOWER([${nameCol}]) = LOWER(:raw)
            OR LOWER([${nameCol}]) LIKE LOWER(:rawLike)
            OR ${normExpr} = :norm
            OR ${normExpr} LIKE :normLike
          )
        ORDER BY
          CASE
            WHEN ${normExpr} = :norm THEN 1
            WHEN LOWER([${nameCol}]) = LOWER(:raw) THEN 2
            WHEN ${normExpr} LIKE :normLike THEN 3
            ELSE 4
          END,
          [${nameCol}];
      `;

      const rows = await sequelize.query(sql, {
        replacements: { raw, rawLike, norm, normLike },
        type: Sequelize.QueryTypes.SELECT
      });
      return rows?.[0]?.name || null;
    }

    const results = [];
    for (const name of names) {
      const query = extractDrugQuery(name);
      if (!query) {
        results.push({ name, available: false });
        continue;
      }

      try {
        const matched = await findDrugMatch(query);
        results.push({ name, available: !!matched });
        dlog(`[MEDICATION_API] "${name}" => ${matched ? 'AVAILABLE' : 'NOT FOUND'}`);
      } catch (e) {
        dwarn(`[MEDICATION_API] Error checking "${name}":`, e.message);
        results.push({ name, available: false });
      }
    }

    res.json({ results });
  } catch (err) {
    derr('[MEDICATION_API] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// -------------------- Login check middleware --------------------
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }
  next();
}


// -------------------- Platform Admin Routes --------------------

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'superadmin') {
    return next();
  }
  return res.status(401).json({ ok: false, message: 'Unauthorized' });
}

// 🔐 Screen-level permission guard based on Access_Rights
function requireScreen(screenId) {
  return async (req, res, next) => {
    try {
      if (!req.session || !req.session.user) {
        return res.status(401).json({ ok: false, message: 'Not logged in' });
      }

      const { type, userRoleMappingId } = req.session.user;

      // SuperAdmin TYPE always allowed to pass
      if (type === 'SuperAdmin') {
        return next();
      }

      if (!userRoleMappingId) {
        return res
          .status(403)
          .json({ ok: false, message: 'No screen access configured' });
      }

      const userId = req.session.user.id;

      // ✅ Effective permission = User_Additional_Permissions override OR Access_Rights default
      const rows = await sequelize.query(
        `
        SELECT TOP 1 ss.id
        FROM [dbo].[System_Screens] ss
        LEFT JOIN [dbo].[Access_Rights] ar
          ON ar.system_screen_id = ss.id
         AND ar.user_role_mapping_id = :urmId
         AND ar.row_status = 1
        LEFT JOIN [dbo].[User_Additional_Permissions] uap
          ON uap.system_screen_id = ss.id
         AND uap.user_id = :userId
         AND uap.row_status = 1
         AND (uap.start_date IS NULL OR uap.start_date <= SYSDATETIME())
         AND (uap.end_date   IS NULL OR uap.end_date   >= SYSDATETIME())
        WHERE ss.id = :screenId
          AND ss.row_status = 1
          -- if override exists use uap.read, else fallback to ar.read
          AND COALESCE(uap.[read], ar.[read], 0) = 1
        `,
        {
          replacements: {
            userId,
            urmId: userRoleMappingId,
            screenId,
          },
          type: Sequelize.QueryTypes.SELECT,
        }
      );


      if (!rows || rows.length === 0) {
        return res
          .status(403)
          .json({ ok: false, message: 'You do not have access to this screen' });
      }

      return next();
    } catch (err) {
      console.error('[PLATFORM] requireScreen error:', err);
      return res
        .status(500)
        .json({ ok: false, message: 'Internal server error' });
    }
  };
}

// 🔐 Screen-level WRITE permission guard (Create User, etc.)
function requireScreenWrite(screenId) {
  return async (req, res, next) => {
    try {
      if (!req.session || !req.session.user) {
        return res.status(401).json({ ok: false, message: 'Not logged in' });
      }

      const { type, userRoleMappingId, id: userId } = req.session.user;

      // SuperAdmin always allowed
      if (type === 'SuperAdmin') {
        return next();
      }

      if (!userRoleMappingId) {
        return res
          .status(403)
          .json({ ok: false, message: 'No screen access configured' });
      }

      const rows = await sequelize.query(
        `
        SELECT TOP 1 ss.id
        FROM [dbo].[System_Screens] ss
        LEFT JOIN [dbo].[Access_Rights] ar
          ON ar.system_screen_id = ss.id
         AND ar.user_role_mapping_id = :urmId
         AND ar.row_status = 1
        LEFT JOIN [dbo].[User_Additional_Permissions] uap
          ON uap.system_screen_id = ss.id
         AND uap.user_id = :userId
         AND uap.row_status = 1
         AND (uap.start_date IS NULL OR uap.start_date <= SYSDATETIME())
         AND (uap.end_date   IS NULL OR uap.end_date   >= SYSDATETIME())
        WHERE ss.id = :screenId
          AND ss.row_status = 1
          -- require effective WRITE = 1
          AND COALESCE(uap.[write], ar.[write], 0) = 1
        `,
        {
          replacements: {
            userId,
            urmId: userRoleMappingId,
            screenId,
          },
          type: Sequelize.QueryTypes.SELECT,
        }
      );

      if (!rows || rows.length === 0) {
        return res
          .status(403)
          .json({ ok: false, message: 'You do not have write access to this screen' });
      }

      return next();
    } catch (err) {
      console.error('[PLATFORM] requireScreenWrite error:', err);
      return res
        .status(500)
        .json({ ok: false, message: 'Internal server error' });
    }
  };
}


app.post('/api/platform/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    // Basic validation
    if (!email || !password) {
      return res
        .status(400)
        .json({ ok: false, message: 'Email and password required' });
    }

    // Look up the user in the real schema
    // Super Admin is defined as:
    //   Persona:    'Employee'
    //   Department: 'IT'
    //   Type:       'SuperAdmin'
    //   Status:     'Active' (optional check – allows NULL)
    const rows = await sequelize.query(
      `
      SELECT TOP 1
        su.id,
        su.full_name,
        su.email,
        su.password,
        su.manager_user_id,
        su.clinic_id,
        su.xr_id,
        su.status_id,
        su.user_role_mapping_id,
        p.persona,
        d.department,
        t.type,
        s.status
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm
        ON su.user_role_mapping_id = urm.id
      JOIN [dbo].[Personas] p
        ON urm.persona_id = p.id
      JOIN [dbo].[Departments] d
        ON urm.department_id = d.id
      JOIN [dbo].[Types] t
        ON urm.type_id = t.id
      LEFT JOIN [dbo].[Status] s
        ON su.status_id = s.id
      WHERE su.email = :email
        AND su.row_status = 1
        AND urm.row_status = 1
        AND p.row_status = 1
        AND d.row_status = 1
        AND t.row_status = 1
      `,
      {
        replacements: { email },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (!rows || rows.length === 0) {
      return res
        .status(401)
        .json({ ok: false, message: 'Invalid credentials' });
    }

    const user = rows[0];

    // ✅ For now: allow ANY active System_Users row to log in to the Platform.
    // Later you can tighten this to check persona/department/type again.
    const isActive = !user.status || user.status === 'Active';

    if (!isActive) {
      return res
        .status(403)
        .json({ ok: false, message: 'Not authorized for platform (inactive user)' });
    }

    // Plain-text password check for now (matches your seeded row)
    if (user.password !== password) {
      return res
        .status(401)
        .json({ ok: false, message: 'Invalid credentials' });
    }

    // Decide if this DB user is the true Master Admin / SuperAdmin
    const isSuperAdminUser =
      user.type === 'SuperAdmin' ||              // from Types table
      user.full_name === 'Master Admin' ||       // your seeded name in System_Users
      user.email === 'admin@company.com';        // adjust if your master admin email differs

    // Create session – keep the same shape so existing frontend logic still works
    req.session.user = {
      role: isSuperAdminUser ? 'superadmin' : 'user',   // 🔑 only Master Admin gets 'superadmin'
      id: user.id,
      name: user.full_name,
      email: user.email,
      persona: user.persona,
      department: user.department,
      type: user.type,
      userType: user.type,                               // alias used by frontend checks
      xrId: user.xr_id || null,
      clinicId: user.clinic_id || null,
      managerUserId: user.manager_user_id || null,
      userRoleMappingId: user.user_role_mapping_id || null,
    };

    if (isSuperAdminUser) {
      console.log('[PLATFORM] ✅ SuperAdmin logged in via System_Users:', user.email);
    } else {
      console.log('[PLATFORM] ✅ Platform user logged in via System_Users:', user.email);
    }

    // ✅ NEW: If logged-in user is Provider, log provider list (id/email/xr_id) as JSON.
    // This is side-effect-free: does not change response/session and cannot block login.
    // ✅ Provider-only: log ONLY the logged-in provider (id/email/xr_id)
    if (String(user.persona || '').toLowerCase() === 'provider') {
      console.log(
        '[PLATFORM][PROVIDER_ME_JSON]',
        JSON.stringify(
          {
            ok: true,
            provider: {
              id: user.id,
              email: user.email,
              xr_id: user.xr_id || null,
            },
          },
          null,
          2
        )
      );
    }

    // Response shape kept compatible with old code (we only ADD extra fields)
    return res.json({
      ok: true,
      role: req.session.user.role,
      email: user.email,
      name: user.full_name,

      // 👇 NEW helper fields (do NOT break old frontend that only reads ok/role/email/name)
      id: user.id,
      persona: user.persona,
      department: user.department,
      type: user.type,
      managerUserId: user.manager_user_id,
      clinicId: user.clinic_id,
      xrId: user.xr_id,
      userRoleMappingId: user.user_role_mapping_id,
    });

  } catch (err) {
    console.error('[PLATFORM] Login error (System_Users):', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});





app.get('/api/platform/me', (req, res) => {
  if (req.session && req.session.user) {
    const u = req.session.user;
    return res.json({
      ok: true,
      role: u.role,
      email: u.email,
      name: u.name,
      type: u.type,
      userType: u.userType || u.type,
      id: u.id,

      // ✅ add these (safe)
      userRoleMappingId: u.userRoleMappingId,
      xrId: u.xrId,
      clinicId: u.clinicId,
      managerUserId: u.managerUserId,
      department: u.department,
      persona: u.persona,
    });
  }
  return res.json({ ok: false });
});


app.post('/api/platform/logout', (req, res) => {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) {
        console.error('[PLATFORM] Logout error:', err);
        return res.status(500).json({ ok: false, message: 'Logout failed' });
      }
      return res.json({ ok: true });
    });
  } else {
    return res.json({ ok: true });
  }
});

app.get('/platform/secure/ping', requireSuperAdmin, (req, res) => {
  const conn = getAzureSqlConnection();
  const dbStatus = conn ? 'configured' : 'mock_mode';
  return res.json({
    ok: true,
    message: 'Authorized',
    user: req.session.user,
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/platform/config-status', (req, res) => {
  return res.json({
    env: envLoader.envStatus,
    ready: envLoader.isReady,
    loadedFrom: envLoader.loadedFrom || 'process.env only',
  });
});

app.get('/api/platform/stats', requireLogin, async (req, res) => {
  try {
    // --- 1. Total users (from System_Users) -------------------------
    const totalUsersResult = await sequelize.query(
      `
      SELECT COUNT(*) AS count
      FROM [dbo].[System_Users]
      WHERE row_status = 1
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const totalUsers = totalUsersResult[0]?.count || 0;

    // --- 2. Providers (persona = 'Provider') -----------------------
    const totalProvidersResult = await sequelize.query(
      `
      SELECT COUNT(*) AS count
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm ON su.user_role_mapping_id = urm.id
      JOIN [dbo].[Personas] p ON urm.persona_id = p.id
      WHERE su.row_status = 1
        AND urm.row_status = 1
        AND p.row_status = 1
        AND p.persona = 'Provider'
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const totalProviders = totalProvidersResult[0]?.count || 0;

    // --- 3. Employees (persona = 'Employee') -----------------------
    const totalEmployeesResult = await sequelize.query(
      `
      SELECT COUNT(*) AS count
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm ON su.user_role_mapping_id = urm.id
      JOIN [dbo].[Personas] p ON urm.persona_id = p.id
      WHERE su.row_status = 1
        AND urm.row_status = 1
        AND p.row_status = 1
        AND p.persona = 'Employee'
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const totalEmployees = totalEmployeesResult[0]?.count || 0;

    // --- 4. Scribes (Employee + type = 'Scribe') -------------------
    const totalScribesResult = await sequelize.query(
      `
      SELECT COUNT(*) AS count
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm ON su.user_role_mapping_id = urm.id
      JOIN [dbo].[Personas] p ON urm.persona_id = p.id
      JOIN [dbo].[Types] t ON urm.type_id = t.id
      WHERE su.row_status = 1
        AND urm.row_status = 1
        AND p.row_status = 1
        AND t.row_status = 1
        AND p.persona = 'Employee'
        AND t.type = 'Scribe'
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const totalScribes = totalScribesResult[0]?.count || 0;

    // --- 5. Build response object ---------------------------------
    const stats = {
      totalUsers,
      totalProviders,
      totalScribes,
      totalEmployees,
      recentLogins: [], // we’ll wire this up later
    };

    return res.json({ ok: true, stats });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/stats error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});


// -------------------- Screens visible to current platform user --------------------
app.get('/api/platform/my-screens', requireLogin, async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser) {
      return res.status(401).json({ ok: false, message: 'Not logged in' });
    }

    const userRoleMappingId = sessionUser.userRoleMappingId;
    const userType = sessionUser.type; // e.g. 'SuperAdmin', 'Scribe', 'Employee'

    // SuperAdmin: see all screens with full permissions
    if (userType === 'SuperAdmin') {
      const screens = await sequelize.query(
        `
        SELECT
          id,
          screen_name,
          route_path,
          1 AS [read],
          1 AS [write],
          1 AS [edit],
          1 AS [delete]
        FROM [dbo].[System_Screens]
        WHERE row_status = 1
        ORDER BY id
        `,
        { type: Sequelize.QueryTypes.SELECT }
      );

      return res.json({ ok: true, screens });
    }


    // Everyone else: defaults from Access_Rights + optional overrides from User_Additional_Permissions
    if (!userRoleMappingId) {
      // no mapping id – safest is to return no screens
      return res.json({ ok: true, screens: [] });
    }

    const userId = sessionUser.id;

    const screens = await sequelize.query(
      `
      SELECT
        ss.id,
        ss.screen_name,
        ss.route_path,
        -- effective permissions: per-user override first, then role default
        COALESCE(uap.[read],  ar.[read],  0) AS [read],
        COALESCE(uap.[write], ar.[write], 0) AS [write],
        COALESCE(uap.[edit],  ar.[edit],  0) AS [edit],
        COALESCE(uap.[delete],ar.[delete],0) AS [delete]
      FROM [dbo].[System_Screens] ss
      LEFT JOIN [dbo].[Access_Rights] ar
        ON ar.system_screen_id = ss.id
       AND ar.user_role_mapping_id = :userRoleMappingId
       AND ar.row_status = 1
      LEFT JOIN [dbo].[User_Additional_Permissions] uap
        ON uap.system_screen_id = ss.id
       AND uap.user_id = :userId
       AND uap.row_status = 1
       AND (uap.start_date IS NULL OR uap.start_date <= SYSDATETIME())
       AND (uap.end_date   IS NULL OR uap.end_date   >= SYSDATETIME())
      WHERE ss.row_status = 1
        -- only show screens where effective READ = 1
        AND COALESCE(uap.[read], ar.[read], 0) = 1
      ORDER BY ss.id
      `,
      {
        replacements: { userRoleMappingId, userId },
        type: Sequelize.QueryTypes.SELECT,
      }
    );


    return res.json({ ok: true, screens });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/my-screens error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});

// Helper: normalize rights from old & new payload shapes into
// [{ screenId, read, write, edit, delete }]
function normalizeScreenRights(rawRights) {
  const result = [];
  if (!Array.isArray(rawRights)) return result;

  for (const entry of rawRights) {
    if (!entry) continue;

    // NEW shape: { screenId, read, write, edit, delete }
    if (typeof entry === 'object') {
      const screenId = Number(entry.screenId ?? entry.id);
      if (!Number.isFinite(screenId)) continue;

      result.push({
        screenId,
        read: entry.read ? 1 : 0,
        write: entry.write ? 1 : 0,
        edit: entry.edit ? 1 : 0,
        delete: entry.delete ? 1 : 0,
      });
      continue;
    }

    // OLD shape: "1", "2", 3 → defaults to READ=1 only
    const screenId = Number(entry);
    if (!Number.isFinite(screenId)) continue;

    result.push({
      screenId,
      read: 1,
      write: 0,
      edit: 0,
      delete: 0,
    });
  }

  return result;
}




app.post('/api/platform/create-user', requireLogin, requireScreenWrite(6), async (req, res) => {

  try {
    // ---- 0. Normalise incoming body (support old + new field names) ----
    const body = req.body || {};

    const category =
      body.category ||
      body.userCategory ||       // old / alternative name
      body.persona ||
      null;

    const name = body.name || body.full_name || null;
    const email = body.email || null;

    const department =
      body.department ||
      body.dept ||
      null;

    const type =
      body.type ||
      body.userType ||          // old field name
      body.typeName ||
      null;

    const status = body.status || null;

    const password =
      body.password ||
      body.tempPassword ||      // if frontend ever uses a different key
      null;

    const rights =
      Array.isArray(body.rights) ? body.rights :
        Array.isArray(body.screenAccess) ? body.screenAccess :
          Array.isArray(body.screenRights) ? body.screenRights :
            [];

    // Normalize rights into consistent structure
    const normalizedRights = normalizeScreenRights(rights);



    const reportingManagerId =
      body.reportingManagerId ||
      body.reportingManager ||
      body.managerUserId ||
      null;

    const clinicId = body.clinicId || body.clinic || null;
    const xrId = body.xrId || body.xr_id || null;
    const primaryProviderId =
      body.primaryProviderUserId ||
      body.primaryProviderId ||
      body.primaryProvider ||
      null;

    // Small debug to help if this ever fails again
    console.log('[PLATFORM] /create-user incoming body (sanitised):', {
      category,
      name,
      email,
      department,
      type,
      status,
      hasPassword: !!password,
      rights,
      reportingManagerId,
      clinicId,
      xrId,
      primaryProviderId
    });

    // --- 1. Basic validation --------------------------------------------
    if (!category || !name || !email || !status || !password) {
      return res.status(400).json({
        ok: false,
        message: 'All fields are required'
      });
    }

    // Normalize category to match Personas values
    const normalizedCategory = String(category).toLowerCase();

    // Personas table: 'Employee' and 'Provider'
    // For Scribe, we treat persona = 'Employee' with type = 'Scribe'
    let personaName;
    if (normalizedCategory === 'provider') {
      personaName = 'Provider';
    } else {
      // Employee, Scribe, etc. → Employee persona
      personaName = 'Employee';
    }

    // If department not supplied, default sensibly
    const departmentName =
      department || (normalizedCategory === 'provider' ? 'OPS' : 'IT');

    // Decide which "type" (Types table) to use
    let typeName = type || 'Employee';

    // Our Types table does NOT have "Provider" as a type.
    // Providers should use the "Employee" type entry.
    if (normalizedCategory === 'provider') {
      typeName = 'Employee';
    }

    const statusName = status; // 'Active' / 'Inactive'


    // --- 2. Look up IDs from master tables ------------------------------

    const personaRow = await sequelize.query(
      `
      SELECT id
      FROM [dbo].[Personas]
      WHERE persona = :personaName
        AND row_status = 1
      `,
      {
        replacements: { personaName },
        type: Sequelize.QueryTypes.SELECT
      }
    );
    if (!personaRow.length) {
      return res
        .status(400)
        .json({ ok: false, message: 'Invalid persona/category' });
    }
    const personaId = personaRow[0].id;

    const deptRow = await sequelize.query(
      `
      SELECT id
      FROM [dbo].[Departments]
      WHERE department = :departmentName
        AND row_status = 1
      `,
      {
        replacements: { departmentName },
        type: Sequelize.QueryTypes.SELECT
      }
    );
    if (!deptRow.length) {
      return res
        .status(400)
        .json({ ok: false, message: 'Invalid department' });
    }
    const departmentId = deptRow[0].id;

    const typeRow = await sequelize.query(
      `
      SELECT id
      FROM [dbo].[Types]
      WHERE type = :typeName
        AND row_status = 1
      `,
      {
        replacements: { typeName },
        type: Sequelize.QueryTypes.SELECT
      }
    );
    if (!typeRow.length) {
      return res
        .status(400)
        .json({ ok: false, message: 'Invalid type' });
    }
    const typeId = typeRow[0].id;

    const statusRow = await sequelize.query(
      `
      SELECT id
      FROM [dbo].[Status]
      WHERE status = :statusName
        AND row_status = 1
      `,
      {
        replacements: { statusName },
        type: Sequelize.QueryTypes.SELECT
      }
    );
    if (!statusRow.length) {
      return res
        .status(400)
        .json({ ok: false, message: 'Invalid status' });
    }
    const statusId = statusRow[0].id;

    // --- 3. Check if email already exists in System_Users ----------------
    const existingUser = await sequelize.query(
      `
      SELECT id
      FROM [dbo].[System_Users]
      WHERE email = :email
        AND row_status = 1
      `,
      {
        replacements: { email },
        type: Sequelize.QueryTypes.SELECT
      }
    );
    if (existingUser.length) {
      return res.status(400).json({
        ok: false,
        message: 'A user with this email already exists'
      });
    }

    const createdById = (req.session.user && req.session.user.id) || null;

    // --- 4. Insert into User_Role_Mapping + System_Users (transaction) ---

    const transaction = await sequelize.transaction();

    try {
      // 4a) Insert into User_Role_Mapping and get id via OUTPUT
      const roleRowsRaw = await sequelize.query(
        `
        INSERT INTO [dbo].[User_Role_Mapping] (
          persona_id,
          department_id,
          type_id,
          created_date,
          created_by,
          modified_date,
          modified_by,
          row_status
        )
        OUTPUT INSERTED.id AS id
        VALUES (
          :personaId,
          :departmentId,
          :typeId,
          SYSDATETIME(),
          :createdBy,
          SYSDATETIME(),
          :createdBy,
          1
        )
        `,
        {
          replacements: {
            personaId,
            departmentId,
            typeId,
            createdBy: createdById
          },
          type: Sequelize.QueryTypes.SELECT,
          transaction
        }
      );

      console.log(
        '[DEBUG] roleRowsRaw from User_Role_Mapping insert:',
        roleRowsRaw
      );

      let userRoleMappingId = null;
      if (Array.isArray(roleRowsRaw)) {
        if (
          roleRowsRaw.length &&
          roleRowsRaw[0] &&
          typeof roleRowsRaw[0].id !== 'undefined'
        ) {
          userRoleMappingId = roleRowsRaw[0].id;
        } else if (
          Array.isArray(roleRowsRaw[0]) &&
          roleRowsRaw[0].length &&
          roleRowsRaw[0][0] &&
          typeof roleRowsRaw[0][0].id !== 'undefined'
        ) {
          userRoleMappingId = roleRowsRaw[0][0].id;
        }
      }

      if (!userRoleMappingId) {
        throw new Error(
          'User_Role_Mapping insert did not return an id (check roleRowsRaw debug log)'
        );
      }

      // 4b) Insert into System_Users
      const managerUserId = reportingManagerId || null;

      await sequelize.query(
        `
        INSERT INTO [dbo].[System_Users] (
          full_name,
          email,
          password,
          manager_user_id,
          clinic_id,
          xr_id,
          status_id,
          user_role_mapping_id,
          created_date,
          created_by,
          modified_date,
          modified_by,
          row_status
        )
        VALUES (
          :full_name,
          :email,
          :password,
          :manager_user_id,
          :clinic_id,
          :xr_id,
          :status_id,
          :user_role_mapping_id,
          SYSDATETIME(),
          :created_by,
          SYSDATETIME(),
          :created_by,
          1
        )
        `,
        {
          replacements: {
            full_name: name,
            email,
            password, // still plain, matching your seed; can switch to bcrypt later
            manager_user_id: managerUserId,
            clinic_id: clinicId || null,
            xr_id: xrId || null,
            status_id: statusId,
            user_role_mapping_id: userRoleMappingId,
            created_by: createdById
          },
          type: Sequelize.QueryTypes.INSERT,
          transaction
        }
      );
      // 4c) Insert screen rights into Access_Rights (if any screens were selected)
      if (normalizedRights && normalizedRights.length > 0) {
        for (const r of normalizedRights) {
          const screenId = Number(r.screenId);
          if (!Number.isFinite(screenId)) continue; // skip bad values

          await sequelize.query(
            `
            INSERT INTO [dbo].[Access_Rights] (
              user_role_mapping_id,
              system_screen_id,
              [read],
              [write],
              [edit],
              [delete],
              created_date,
              created_by,
              modified_date,
              modified_by,
              row_status
            )
            VALUES (
              :user_role_mapping_id,
              :system_screen_id,
              :read,
              :write,
              :edit,
              :delete,
              SYSDATETIME(),
              :created_by,
              SYSDATETIME(),
              :created_by,
              1
            )
            `,
            {
              replacements: {
                user_role_mapping_id: userRoleMappingId,
                system_screen_id: screenId,
                read: r.read ? 1 : 0,
                write: r.write ? 1 : 0,
                edit: r.edit ? 1 : 0,
                delete: r.delete ? 1 : 0,
                created_by: createdById,
              },
              type: Sequelize.QueryTypes.INSERT,
              transaction,
            }
          );
        }
      }



      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    console.log('[PLATFORM] System_Users user created:', {
      name,
      email,
      category: personaName,
      department: departmentName,
      type: typeName
    });

    // --- 5. Send welcome email with login credentials --------------------
    try {
      await sendNewLoginEmail({
        to: email,
        name,
        email,
        password
      });
    } catch (mailErr) {
      console.error(
        '[PLATFORM] Failed to send welcome email:',
        mailErr.message || mailErr
      );
      // Do NOT fail the request just because email failed
    }

    return res.json({
      ok: true,
      message: 'User created in System_Users and login email sent'
    });
  } catch (err) {
    console.error('[PLATFORM] Create user error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});

// -------------------- USERS FOR ASSIGN USERS TABLE --------------------
// Returns providers + scribes with any existing assignment rows.
// - SuperAdmin  → sees all providers + all scribes
// - Manager     → sees all providers + only scribes that report to them
// - Manager     → sees all providers + only scribes that report to them
// - Manager     → sees all providers + only scribes that report to them
// - Manager     → sees all providers + only scribes that report to them
// - Manager     → sees all providers + only scribes that report to them
// - Manager     → sees all providers + only scribes that report to them
app.get('/api/platform/users', requireLogin, requireScreen(8), async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser) {
      return res.status(401).json({ ok: false, message: 'Not logged in' });
    }

    const currentUserId = sessionUser.id;
    const isSuperAdmin =
      sessionUser.role === 'superadmin' || sessionUser.type === 'SuperAdmin';
    const isSuperAdminBit = isSuperAdmin ? 1 : 0;

    const sql = `
      SELECT
        su.id,
        su.full_name,
        su.email,
        su.xr_id,
        su.clinic_id,
        CASE
          WHEN vur.persona_id = 5 THEN 'Provider'
          WHEN vur.type_id   = 4 THEN 'Scribe'
          ELSE 'Other'
        END AS userType
      FROM [dbo].[System_Users] su
      JOIN [dbo].[View_User_Role_Mapping] vur
        ON su.user_role_mapping_id = vur.id
      WHERE
        su.row_status = 1
        AND su.status_id = 1
        AND (
             -- Providers
             vur.persona_id = 5
             OR
             -- Scribes (SuperAdmin sees all; Manager only own reportees)
             (
               vur.type_id = 4
               AND (
                 :isSuperAdmin = 1
                 OR su.manager_user_id = :managerId
               )
             )
        )
      ORDER BY su.full_name ASC;
    `;

    const rows = await sequelize.query(sql, {
      replacements: {
        isSuperAdmin: isSuperAdminBit,
        managerId: currentUserId,
      },
      type: Sequelize.QueryTypes.SELECT,
    });

    const users = (rows || []).map((u) => ({
      id: u.id,
      name: u.full_name,
      email: u.email,
      xr_id: u.xr_id,
      clinic_id: u.clinic_id,
      userType: u.userType,       // 'Provider' or 'Scribe'
      // mapping fields start empty; Save will fill them
      provider_id: null,
      scribe_id: null,
      level: null,
    }));

    return res.json({ ok: true, users });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/users error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});




app.post('/api/platform/assign-user', requireSuperAdmin, async (req, res) => {
  try {
    const { userId, providerId, scribeId, level } = req.body;

    if (!userId) {
      return res.status(400).json({ ok: false, message: 'User ID is required' });
    }

    const checkQuery = 'SELECT * FROM [dbo].[assignusers] WHERE user_id = :userId';
    const existing = await sequelize.query(checkQuery, {
      replacements: { userId },
      type: Sequelize.QueryTypes.SELECT,
    });

    if (existing && existing.length > 0) {
      const updateQuery = `
        UPDATE [dbo].[assignusers]
        SET provider_id = :providerId, scribe_id = :scribeId, level = :level, updated_at = GETDATE()
        WHERE user_id = :userId
      `;
      await sequelize.query(updateQuery, {
        replacements: { userId, providerId: providerId || null, scribeId: scribeId || null, level: level || null },
        type: Sequelize.QueryTypes.UPDATE,
      });
    } else {
      const insertQuery = `
        INSERT INTO [dbo].[assignusers] (user_id, provider_id, scribe_id, level, created_at)
        VALUES (:userId, :providerId, :scribeId, :level, GETDATE())
      `;
      await sequelize.query(insertQuery, {
        replacements: { userId, providerId: providerId || null, scribeId: scribeId || null, level: level || null },
        type: Sequelize.QueryTypes.INSERT,
      });
    }

    console.log('[PLATFORM] User assignment updated:', { userId, providerId, scribeId, level });
    return res.json({ ok: true, message: 'Assignment saved successfully' });
  } catch (err) {
    console.error('[PLATFORM] Assign user error:', err);
    return res.status(500).json({ ok: false, message: 'Internal server error' });
  }
});


// -------------------- ASSIGN USERS DROPDOWN OPTIONS --------------------
// Returns:
//  - scribes: 
//      Master Admin  -> ALL scribes in System_Users
//      Manager       -> ONLY scribes where manager_user_id = current manager
//  - providers: ALL providers (for now, both Master Admin & Manager)
// New Assign Users top-panel dropdown options
app.get('/api/platform/assign-users/options', requireLogin, requireScreen(8), async (req, res) => {

  try {
    const sessionUser = req.session.user;
    if (!sessionUser) {
      return res.status(401).json({ ok: false, message: 'Not logged in' });
    }

    const currentUserId = sessionUser.id;
    // Master Admin flag:
    //  - role === 'superadmin' (we set this in /api/platform/login)
    //  - OR Types.type === 'SuperAdmin'
    const isMasterAdmin =
      sessionUser.role === 'superadmin' ||
      sessionUser.type === 'SuperAdmin';

    const isMasterAdminBit = isMasterAdmin ? 1 : 0;

    // 👇 Scribes:
    // - type_id = 4 in View_User_Role_Mapping = Scribe
    // - if NOT Master Admin, restrict by manager_user_id
    const scribesQuery = `
  SELECT
    su.id,
    su.full_name,
    su.email,
    su.xr_id,
    su.manager_user_id,
    mgr.full_name AS manager_name
  FROM [dbo].[System_Users] su
  LEFT JOIN [dbo].[System_Users] mgr
    ON mgr.id = su.manager_user_id
   AND mgr.row_status = 1
  WHERE
    su.row_status = 1
    AND su.user_role_mapping_id IN (
      SELECT id
      FROM [dbo].[View_User_Role_Mapping]
      WHERE type_id = 4      -- Scribe
    )
    AND (
      :isMasterAdmin = 1
      OR su.manager_user_id = :currentUserId
    )
  ORDER BY su.full_name;
`;


    // 👇 Providers:
    // - persona_id = 5 in View_User_Role_Mapping = Provider
    // - no manager filter (both Master Admin & Manager see all providers)
    const providersQuery = `
      SELECT
        su.id,
        su.full_name,
        su.email,
        su.xr_id,
        su.clinic_id
      FROM [dbo].[System_Users] su
      WHERE
        su.row_status = 1
        AND su.status_id = 1
        AND su.user_role_mapping_id IN (
          SELECT id
          FROM [dbo].[View_User_Role_Mapping]
          WHERE persona_id = 5   -- Provider
        )
      ORDER BY su.full_name;
    `;


    const [scribes, providers] = await Promise.all([
      sequelize.query(scribesQuery, {
        replacements: { currentUserId, isMasterAdmin: isMasterAdminBit },
        type: Sequelize.QueryTypes.SELECT,
      }),
      sequelize.query(providersQuery, {
        type: Sequelize.QueryTypes.SELECT,
      }),
    ]);

    return res.json({
      ok: true,
      scope: isMasterAdmin ? 'all' : 'manager', // just for debugging in UI
      scribes,       // [{ id, full_name }]
      providers,     // [{ id, full_name }]
    });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/assign-users/options error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});

// -------------------- Scribe ⇄ Provider mappings (bottom Assign Users grid) --------------------
// Returns one row per active mapping in Scribe_Provider_Mapping.
// - Master Admin: sees all mappings
// - Manager: sees only mappings where *their* scribes are mapped
// - Master Admin: sees all mappings
// - Manager: sees only mappings where *their* scribes are mapped
app.get('/api/platform/scribe-provider-mapping', requireLogin, requireScreen(8), async (req, res) => {

  try {
    const sessionUser = req.session.user;
    if (!sessionUser) {
      return res.status(401).json({ ok: false, message: 'Not logged in' });
    }

    const currentUserId = sessionUser.id;
    const isMasterAdmin =
      sessionUser.role === 'superadmin' ||
      sessionUser.type === 'SuperAdmin';
    const isMasterAdminBit = isMasterAdmin ? 1 : 0;

    const rows = await sequelize.query(
      `
      SELECT
        m.id,

        -- Scribe side
        s.id          AS scribe_id,
        s.full_name   AS scribe_name,
        s.email       AS scribe_email,
        s.xr_id       AS scribe_xr_id,

        -- Provider side
        p.id          AS provider_id,
        p.full_name   AS provider_name,
        p.email       AS provider_email,
        p.xr_id       AS provider_xr_id,
        p.clinic_id   AS provider_clinic_id,
        c.clinic      AS provider_clinic_name,


        -- Manager of the scribe
        mgr.full_name AS scribe_manager_name
      FROM [dbo].[Scribe_Provider_Mapping] m
      JOIN [dbo].[System_Users] s
        ON m.scribe_user_id = s.id
       AND s.row_status = 1
      JOIN [dbo].[System_Users] p
        ON m.provider_user_id = p.id
       AND p.row_status = 1
       LEFT JOIN [dbo].[Clinics] c
      ON p.clinic_id = c.id
      AND c.row_status = 1
      LEFT JOIN [dbo].[System_Users] mgr
        ON s.manager_user_id = mgr.id
       AND mgr.row_status = 1
      WHERE
        m.row_status = 1
        AND (
          :isMasterAdmin = 1
          OR s.manager_user_id = :managerId
        )
      ORDER BY
        s.full_name ASC,
        p.full_name ASC;
      `,
      {
        replacements: {
          isMasterAdmin: isMasterAdminBit,
          managerId: currentUserId,
        },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    // Shape it nicely for the frontend (no behavior impact on other routes)
    const mappings = rows.map((r) => ({
      id: r.id,
      scribe: {
        id: r.scribe_id,
        name: r.scribe_name,
        email: r.scribe_email,
        xrId: r.scribe_xr_id,
        managerName: r.scribe_manager_name || null,
      },
      provider: {
        id: r.provider_id,
        name: r.provider_name,
        email: r.provider_email,
        xrId: r.provider_xr_id,
        // ✅ add these
        clinic_id: r.provider_clinic_id,
        clinic_name: r.provider_clinic_name,

      },
    }));

    return res.json({ ok: true, mappings });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/scribe-provider-mapping (GET) error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});

// Create / update a Scribe ⇄ Provider mapping from the top "Save Assignment" button
// Create / update a Scribe ⇄ Provider mapping from the top "Save Assignment" button
app.post('/api/platform/scribe-provider-mapping', requireLogin, requireScreenWrite(8), async (req, res) => {

  try {
    const sessionUser = req.session.user;
    if (!sessionUser) {
      return res.status(401).json({ ok: false, message: 'Not logged in' });
    }

    const { scribeUserId, providerUserId } = req.body || {};
    const scribeId = parseInt(scribeUserId, 10);
    const providerId = parseInt(providerUserId, 10);

    if (!scribeId || !providerId) {
      return res.status(400).json({
        ok: false,
        message: 'scribeUserId and providerUserId are required',
      });
    }

    const currentUserId = sessionUser.id;
    const isMasterAdmin =
      sessionUser.role === 'superadmin' ||
      sessionUser.type === 'SuperAdmin';

    // Managers can only assign their own scribes
    if (!isMasterAdmin) {
      const [check] = await sequelize.query(
        `
        SELECT TOP 1 id
        FROM [dbo].[System_Users]
        WHERE id = :scribeId
          AND manager_user_id = :managerId
          AND row_status = 1
        `,
        {
          replacements: { scribeId, managerId: currentUserId },
          type: Sequelize.QueryTypes.SELECT,
        }
      );

      if (!check) {
        return res.status(403).json({
          ok: false,
          message: 'You can only assign scribes that report to you',
        });
      }
    }

    const nowUserId = currentUserId || null;

    // Upsert model: one *active* mapping per scribe
    const existing = await sequelize.query(
      `
      SELECT TOP 1 id
      FROM [dbo].[Scribe_Provider_Mapping]
      WHERE scribe_user_id = :scribeId
        AND row_status = 1
      `,
      {
        replacements: { scribeId },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (existing && existing.length > 0) {
      // Update provider for this scribe
      const mappingId = existing[0].id;
      await sequelize.query(
        `
        UPDATE [dbo].[Scribe_Provider_Mapping]
        SET
          provider_user_id = :providerId,
          modified_date    = SYSDATETIME(),
          modified_by      = :userId
        WHERE id = :id
        `,
        {
          replacements: {
            id: mappingId,
            providerId,
            userId: nowUserId,
          },
          type: Sequelize.QueryTypes.UPDATE,
        }
      );
    } else {
      // Insert new mapping row
      await sequelize.query(
        `
        INSERT INTO [dbo].[Scribe_Provider_Mapping] (
          scribe_user_id,
          provider_user_id,
          created_date,
          created_by,
          modified_date,
          modified_by,
          row_status
        )
        VALUES (
          :scribeId,
          :providerId,
          SYSDATETIME(),
          :userId,
          SYSDATETIME(),
          :userId,
          1
        )
        `,
        {
          replacements: {
            scribeId,
            providerId,
            userId: nowUserId,
          },
          type: Sequelize.QueryTypes.INSERT,
        }
      );
    }

    console.log('[PLATFORM] Scribe_Provider_Mapping saved:', {
      scribeId,
      providerId,
      by: nowUserId,
    });

    return res.json({ ok: true, message: 'Mapping saved successfully' });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/scribe-provider-mapping (POST) error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});



// Lookup options for create-user form based on NEW XRBase schema
// -------------------- Create-User dropdown / lookup data --------------------
app.get('/api/platform/lookup-options', requireLogin, requireScreen(6), async (req, res) => {

  try {
    const personasQuery = `
      SELECT id, persona
      FROM [dbo].[Personas]
      WHERE row_status = 1
      ORDER BY id
    `;

    const departmentsQuery = `
      SELECT id, department
      FROM [dbo].[Departments]
      WHERE row_status = 1
      ORDER BY id
    `;

    const typesQuery = `
      SELECT id, type
      FROM [dbo].[Types]
      WHERE row_status = 1
      ORDER BY id
    `;

    const statusesQuery = `
      SELECT id, status
      FROM [dbo].[Status]
      WHERE row_status = 1
      ORDER BY id
    `;

    const clinicsQuery = `
      SELECT id, clinic
      FROM [dbo].[Clinics]
      WHERE row_status = 1
      ORDER BY id
    `;

    const screensQuery = `
      SELECT id, screen_name, route_path
      FROM [dbo].[System_Screens]
      WHERE row_status = 1
      ORDER BY id
    `;

    // All active MANAGERS (Types.type = 'Manager') for Reporting Manager dropdown
    const managersQuery = `
      SELECT
        su.id,
        su.full_name
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm
        ON su.user_role_mapping_id = urm.id
      JOIN [dbo].[Types] t
        ON urm.type_id = t.id
      WHERE su.row_status = 1
        AND urm.row_status = 1
        AND t.row_status = 1
        AND t.type = 'Manager'
      ORDER BY su.full_name ASC
    `;




    // ✅ now we grab 7 results, including managers
    const [personas, departments, types, statuses, clinics, screens, managers] =
      await Promise.all([
        sequelize.query(personasQuery, { type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(departmentsQuery, { type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(typesQuery, { type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(statusesQuery, { type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(clinicsQuery, { type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(screensQuery, { type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(managersQuery, { type: Sequelize.QueryTypes.SELECT }), // 👈 NEW
      ]);


    return res.json({
      ok: true,
      options: {
        personas,
        departments,
        types,
        statuses,
        clinics,
        screens,
        managers,   // 👈 NEW: list of { id, full_name } for Reporting Manager dropdown
      },
    });

  } catch (err) {
    console.error('[PLATFORM] /api/platform/lookup-options error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});

// -------------------- Providers for a clinic (Primary Provider dropdown) --------------------
app.get('/api/platform/providers', requireLogin, requireScreen(6), async (req, res) => {
  try {
    const clinicId = parseInt(req.query.clinicId, 10);

    if (!clinicId || Number.isNaN(clinicId)) {
      return res.status(400).json({
        ok: false,
        message: 'clinicId is required and must be a number',
      });
    }

    // A "provider" = active user in that clinic with effective READ=1 for XR Device (screen 4)
    // A "provider" = active user in that clinic whose persona is Provider
    // A "provider" = active user in that clinic whose persona is Provider
    const providers = await sequelize.query(
      `
      SELECT
        su.id,
        su.full_name
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm
        ON su.user_role_mapping_id = urm.id
       AND urm.row_status = 1
      JOIN [dbo].[Personas] p
        ON urm.persona_id = p.id
       AND p.row_status = 1
       AND p.persona = 'Provider'
      WHERE
        su.clinic_id = :clinicId
        AND su.status_id = 1      -- Active
        AND su.row_status = 1
      ORDER BY
        su.full_name ASC
      `,
      {
        replacements: { clinicId },
        type: Sequelize.QueryTypes.SELECT,
      }
    );



    return res.json({ ok: true, providers });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/providers error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});



// -------------------- USER RELATIONS (Manager + Reportees) --------------------
app.get('/api/platform/my-relations', requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // 1️⃣ Load this user's full profile including manager
    const [me] = await sequelize.query(`
      SELECT 
        su.id,
        su.full_name,
        su.email,
        su.manager_user_id,
        mgr.full_name AS manager_name
      FROM System_Users su
      LEFT JOIN System_Users mgr 
        ON mgr.id = su.manager_user_id AND mgr.row_status = 1
      WHERE su.id = :userId AND su.row_status = 1
    `, {
      replacements: { userId },
      type: Sequelize.QueryTypes.SELECT
    });

    // 2️⃣ Load all reportees under this user
    const reportees = await sequelize.query(`
      SELECT 
        su.id,
        su.full_name,
        su.email
      FROM System_Users su
      WHERE su.manager_user_id = :userId 
        AND su.row_status = 1
      ORDER BY su.full_name
    `, {
      replacements: { userId },
      type: Sequelize.QueryTypes.SELECT
    });

    return res.json({
      ok: true,
      me,
      manager: me.manager_user_id
        ? { id: me.manager_user_id, name: me.manager_name }
        : null,
      reportees
    });

  } catch (err) {
    console.error('my-relations error:', err);
    return res.status(500).json({ ok: false, message: 'Internal server error' });
  }
});


// -------------------- SUBTREE HIERARCHY FOR CURRENT USER --------------------
app.get('/api/platform/my-hierarchy', requireLogin, async (req, res) => {
  try {
    const currentUserId = req.session.user && req.session.user.id;
    if (!currentUserId) {
      return res.status(401).json({ ok: false, message: 'Not logged in' });
    }

    // 1️⃣ Load ALL active users with role/persona/department
    const users = await sequelize.query(
      `
      SELECT
        su.id,
        su.full_name,
        su.email,
        su.manager_user_id,
        su.xr_id,
        su.clinic_id,
        urm.id AS user_role_mapping_id,
        p.persona,
        d.department,
        t.type AS role_type
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm
        ON su.user_role_mapping_id = urm.id
       AND urm.row_status = 1
      LEFT JOIN [dbo].[Personas] p
        ON urm.persona_id = p.id
       AND p.row_status = 1
      LEFT JOIN [dbo].[Departments] d
        ON urm.department_id = d.id
       AND d.row_status = 1
      LEFT JOIN [dbo].[Types] t
        ON urm.type_id = t.id
       AND t.row_status = 1
      WHERE su.row_status = 1
      ORDER BY su.full_name ASC
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );

    if (!users || users.length === 0) {
      return res.json({ ok: true, roots: [], stats: { totalUsers: 0 } });
    }

    // 2️⃣ Build id -> node map
    const byId = new Map();
    users.forEach((u) => {
      byId.set(u.id, {
        id: u.id,
        name: u.full_name,
        email: u.email,
        manager_user_id: u.manager_user_id,
        xrId: u.xr_id,
        clinicId: u.clinic_id,
        userRoleMappingId: u.user_role_mapping_id,
        persona: u.persona,
        department: u.department,
        role: u.role_type, // 'SuperAdmin', 'Manager', 'Scribe', 'Employee', etc.
        children: [],
      });
    });

    // 3️⃣ Hook each user to their manager
    users.forEach((u) => {
      const node = byId.get(u.id);
      if (u.manager_user_id && byId.has(u.manager_user_id)) {
        byId.get(u.manager_user_id).children.push(node);
      }
    });

    const rootNode = byId.get(currentUserId);
    if (!rootNode) {
      return res.json({
        ok: false,
        message: 'Current user not found in hierarchy',
      });
    }

    // 4️⃣ Collect subtree stats (current user + everyone under them)
    const collected = [];
    (function collect(node) {
      collected.push(node);
      if (Array.isArray(node.children)) {
        node.children.forEach(collect);
      }
    })(rootNode);

    const totalUsers = collected.length;
    const totalManagers = collected.filter((u) => u.role === 'Manager').length;
    const totalScribes = collected.filter((u) => u.role === 'Scribe').length;
    const totalProviders = collected.filter((u) => u.persona === 'Provider').length;

    const stats = {
      totalUsers,
      totalManagers,
      totalScribes,
      totalProviders,
    };

    return res.json({
      ok: true,
      roots: [rootNode], // subtree starting at THIS user
      stats,
    });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/my-hierarchy error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});



// -------------------- FULL USER HIERARCHY (SuperAdmin only) --------------------
app.get('/api/platform/user-hierarchy', requireSuperAdmin, async (req, res) => {
  try {
    // 1️⃣ Load ALL active users with role/persona/department
    const users = await sequelize.query(
      `
      SELECT
        su.id,
        su.full_name,
        su.email,
        su.manager_user_id,
        su.xr_id,
        su.clinic_id,
        urm.id AS user_role_mapping_id,
        p.persona,
        d.department,
        t.type AS role_type
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm
        ON su.user_role_mapping_id = urm.id
       AND urm.row_status = 1
      LEFT JOIN [dbo].[Personas] p
        ON urm.persona_id = p.id
       AND p.row_status = 1
      LEFT JOIN [dbo].[Departments] d
        ON urm.department_id = d.id
       AND d.row_status = 1
      LEFT JOIN [dbo].[Types] t
        ON urm.type_id = t.id
       AND t.row_status = 1
      WHERE su.row_status = 1
      ORDER BY su.full_name ASC
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );

    // 2️⃣ Build a map: id -> node
    const byId = new Map();
    users.forEach((u) => {
      byId.set(u.id, {
        id: u.id,
        name: u.full_name,
        email: u.email,
        manager_user_id: u.manager_user_id,
        xrId: u.xr_id,
        clinicId: u.clinic_id,
        userRoleMappingId: u.user_role_mapping_id,
        persona: u.persona,
        department: u.department,
        role: u.role_type,   // e.g. 'SuperAdmin', 'Manager', 'Scribe', 'Member'
        children: [],
      });
    });

    // 3️⃣ Attach children to their manager; collect roots
    const roots = [];
    users.forEach((u) => {
      const node = byId.get(u.id);
      if (u.manager_user_id && byId.has(u.manager_user_id)) {
        byId.get(u.manager_user_id).children.push(node);
      } else {
        // No valid manager → top-level in the tree
        roots.push(node);
      }
    });

    // 4️⃣ Simple stats for dashboard / profile header
    const totalUsers = users.length;
    const totalManagers = users.filter((u) => u.role_type === 'Manager').length;
    const totalScribes = users.filter((u) => u.role_type === 'Scribe').length;
    const totalProviders = users.filter((u) => u.persona === 'Provider').length;

    const stats = {
      totalUsers,
      totalManagers,
      totalScribes,
      totalProviders,
    };

    return res.json({
      ok: true,
      roots,     // full tree: SuperAdmin -> Managers -> Employees etc.
      stats,     // useful summary
    });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/user-hierarchy error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});




// ================== EMAIL (login user welcome) ==================
const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecure = (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const emailFrom = process.env.EMAIL_FROM || smtpUser || 'no-reply@example.com';

// Create a reusable transporter (only if config is present)
let mailTransporter = null;
if (smtpHost && smtpUser && smtpPass) {
  mailTransporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });
} else {
  console.warn('[MAIL] SMTP not fully configured – emails will be skipped');
}

async function sendNewLoginEmail({ to, name, email, password }) {
  if (!mailTransporter) {
    console.warn('[MAIL] Transporter not available – skip sending email to', to);
    return;
  }

  const subject = 'Your XR Platform login details';
  const text = [
    `Hi ${name || 'User'},`,
    '',
    'Your XR Platform login has been created.',
    '',
    `Login URL: http://localhost:8080/platform`,
    `Email: ${email}`,
    `Password: ${password}`,
    '',
    'Please sign in and change your password after first login.',
    '',
    'Thanks,',
    'XR Platform',
  ].join('\n');

  const html = `
    <p>Hi ${name || 'User'},</p>
    <p>Your <strong>XR Platform</strong> login has been created.</p>
    <p>
      <strong>Login URL:</strong> <a href="http://localhost:8080/platform">http://localhost:8080/platform</a><br/>
      <strong>Email:</strong> ${email}<br/>
      <strong>Password:</strong> ${password}
    </p>
    <p>Please sign in and change your password after first login.</p>
    <p>Thanks,<br/>XR Platform</p>
  `;

  try {
    await mailTransporter.sendMail({
      from: emailFrom,
      to,
      subject,
      text,
      html,
    });
    console.log('[MAIL] Login details sent to', to);
  } catch (err) {
    console.error('[MAIL] Failed to send login email to', to, err.message || err);
  }
}



// -------------------- Create Login User (System_Users) --------------------
app.post('/api/auth/create-user', requireSuperAdmin, async (req, res) => {
  try {
    const { name, email, password, reportingManager } = req.body || {};
    // Optional screen rights for this auth-created user (not used by default)
    const rights = Array.isArray(req.body?.rights) ? req.body.rights : [];


    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ ok: false, message: 'Name, email, and password are required' });
    }

    // 1) Check if a System_Users row already exists for this email
    const existing = await sequelize.query(
      `
      SELECT id
      FROM [dbo].[System_Users]
      WHERE email = :email
        AND row_status = 1
      `,
      {
        replacements: { email },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (existing && existing.length > 0) {
      return res
        .status(400)
        .json({ ok: false, message: 'A user with this email already exists' });
    }

    // 2) Look up basic role + status IDs.
    // For now, treat login-created users as Employee / IT / Member / Active.
    // For now, treat login-created users as Employee / IT / Employee / Active.
    // 2) Look up basic role + status IDs.
    // For now, treat login-created users as Employee / IT / Employee / Active.
    const personaRow = await sequelize.query(
      `SELECT id FROM [dbo].[Personas] WHERE persona = 'Employee' AND row_status = 1`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const deptRow = await sequelize.query(
      `SELECT id FROM [dbo].[Departments] WHERE department = 'IT' AND row_status = 1`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const typeRow = await sequelize.query(
      `SELECT id FROM [dbo].[Types] WHERE type = 'Employee' AND row_status = 1`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const statusRow = await sequelize.query(
      `SELECT id FROM [dbo].[Status] WHERE status = 'Active' AND row_status = 1`,
      { type: Sequelize.QueryTypes.SELECT }
    );


    if (!personaRow.length || !deptRow.length || !typeRow.length || !statusRow.length) {
      return res
        .status(500)
        .json({ ok: false, message: 'Master data (Personas/Departments/Types/Status) missing' });
    }

    const personaId = personaRow[0].id;
    const departmentId = deptRow[0].id;
    const typeId = typeRow[0].id;
    const statusId = statusRow[0].id;

    const createdById = (req.session.user && req.session.user.id) || null;

    // For now, we don’t resolve reportingManager → System_Users.id yet
    const managerUserId = null;

    // 3) Wrap inserts in a transaction
    const transaction = await sequelize.transaction();

    try {
      // 3a) Insert into User_Role_Mapping
      const [roleRows] = await sequelize.query(
        `
        INSERT INTO [dbo].[User_Role_Mapping] (
          persona_id,
          department_id,
          type_id,
          created_date,
          created_by,
          modified_date,
          modified_by,
          row_status
        )
        VALUES (
          :personaId,
          :departmentId,
          :typeId,
          SYSDATETIME(),
          :createdBy,
          SYSDATETIME(),
          :createdBy,
          1
        );
        SELECT SCOPE_IDENTITY() AS id;
        `,
        {
          replacements: { personaId, departmentId, typeId, createdBy: createdById },
          type: Sequelize.QueryTypes.SELECT,
          transaction,
        }
      );

      const userRoleMappingId = roleRows[0].id;

      // 3b) Insert into System_Users
      await sequelize.query(
        `
        INSERT INTO [dbo].[System_Users] (
          full_name,
          email,
          password,
          manager_user_id,
          clinic_id,
          xr_id,
          status_id,
          user_role_mapping_id,
          created_date,
          created_by,
          modified_date,
          modified_by,
          row_status
        )
        VALUES (
          :full_name,
          :email,
          :password,
          :manager_user_id,
          NULL,
          NULL,
          :status_id,
          :user_role_mapping_id,
          SYSDATETIME(),
          :created_by,
          SYSDATETIME(),
          :created_by,
          1
        )
        `,
        {
          replacements: {
            full_name: name,
            email,
            password,          // plain for now, same as before
            manager_user_id: managerUserId,
            status_id: statusId,
            user_role_mapping_id: userRoleMappingId,
            created_by: createdById,
          },
          type: Sequelize.QueryTypes.INSERT,
          transaction,
        }
      );

      // 3c) Insert screen rights into Access_Rights (if any screens were selected)
      if (rights && rights.length > 0) {
        for (const rawId of rights) {
          const screenId = Number(rawId);
          if (!Number.isFinite(screenId)) continue; // skip bad values

          await sequelize.query(
            `
            INSERT INTO [dbo].[Access_Rights] (
              user_role_mapping_id,
              system_screen_id,
              [read],
              [write],
              [edit],
              [delete],
              created_date,
              created_by,
              modified_date,
              modified_by,
              row_status
            )
            VALUES (
              :user_role_mapping_id,
              :system_screen_id,
              1,  -- read allowed
              0,  -- write
              0,  -- edit
              0,  -- delete
              SYSDATETIME(),
              :created_by,
              SYSDATETIME(),
              :created_by,
              1
            )
            `,
            {
              replacements: {
                user_role_mapping_id: userRoleMappingId,
                system_screen_id: screenId,
                created_by: createdById,
              },
              type: Sequelize.QueryTypes.INSERT,
              transaction,
            }
          );
        }
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }



    console.log('[AUTH/System_Users] Login user created via /api/auth/create-user:', {
      name,
      email,
    });

    // 4) Send welcome email (same helper)
    try {
      await sendNewLoginEmail({
        to: email,
        name,
        email,
        password,
      });
    } catch (mailErr) {
      console.error('[AUTH/System_Users] Failed to send welcome email:', mailErr.message || mailErr);
      // do not fail request because of email
    }

    return res.json({
      ok: true,
      message: 'Login user created in System_Users and email sent',
    });
  } catch (err) {
    console.error('[AUTH/System_Users] Create login user error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});



// -------------------- Simple DB Login (auth_users) --------------------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1) Basic validation
    if (!email || !password) {
      return res
        .status(400)
        .json({ ok: false, message: 'Email and password are required' });
    }

    // 2) Look up user in auth_users by email
    const users = await sequelize.query(
      `
      SELECT id, name, email, password_hash, reporting_manager
      FROM [dbo].[auth_users]
      WHERE email = :email
      `,
      {
        replacements: { email },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (!users || users.length === 0) {
      return res
        .status(401)
        .json({ ok: false, message: 'Invalid email or password' });
    }

    const user = users[0];

    // 3) For now: plain password compare (later we'll use bcrypt)
    if (user.password_hash !== password) {
      return res
        .status(401)
        .json({ ok: false, message: 'Invalid email or password' });
    }

    // 4) Success – return user info (no session/JWT yet)
    return res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        reporting_manager: user.reporting_manager,
      },
    });
  } catch (err) {
    console.error('[AUTH] /api/auth/login error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});



// ---- Desktop HTTP telemetry (beginner path) ----
app.post('/desktop-telemetry', (req, res) => {
  try {
    const d = req.body || {};
    const xrId = typeof d.xrId === 'string' ? d.xrId : null;
    if (!xrId) return res.status(400).json({ error: 'xrId required' });

    const rec = {
      xrId,
      connType: d.connType || 'other',
      // network (optional)
      wifiDbm: numOrNull(d.wifiDbm),
      wifiMbps: numOrNull(d.wifiMbps),
      wifiBars: numOrNull(d.wifiBars),
      cellDbm: numOrNull(d.cellDbm),
      cellBars: numOrNull(d.cellBars),
      netDownMbps: numOrNull(d.netDownMbps),
      netUpMbps: numOrNull(d.netUpMbps),
      // system
      cpuPct: numOrNull(d.cpuPct),
      memUsedMb: numOrNull(d.memUsedMb),
      memTotalMb: numOrNull(d.memTotalMb),
      deviceTempC: numOrNull(d.deviceTempC),
      ts: Date.now(),
    };

    // latest snapshot for device rows
    telemetryByDevice.set(xrId, rec);

    // history (drives charts/detail modal)
    pushHist(telemetryHist, xrId, {
      ts: rec.ts,
      connType: rec.connType,
      wifiMbps: rec.wifiMbps,
      netDownMbps: rec.netDownMbps,
      netUpMbps: rec.netUpMbps,
      batteryPct: batteryByDevice.get(xrId)?.pct ?? null,
      cpuPct: rec.cpuPct,
      memUsedMb: rec.memUsedMb,
      memTotalMb: rec.memTotalMb,
      deviceTempC: rec.deviceTempC,
    });

    // broadcast to dashboards (same event Android uses)
    io.emit('telemetry_update', rec);

    dlog('[desktop-telemetry] update', rec);
    res.status(204).end();
  } catch (e) {
    dwarn('[desktop-telemetry] bad payload:', e?.message || e);
    res.status(400).json({ error: 'bad payload' });
  }
});


// -------------------- Redis Adapter --------------------
(async () => {
  try {
    const REDIS_URL = process.env.REDIS_URL;
    if (REDIS_URL) {
      const useTls = (process.env.REDIS_TLS || 'true').toLowerCase() === 'true';
      dlog('[REDIS] connecting', { REDIS_URL: trimStr(REDIS_URL, 80), useTls });
      const pub = createClient({ url: REDIS_URL, socket: { tls: useTls } });
      const sub = pub.duplicate();
      await Promise.all([pub.connect(), sub.connect()]);
      io.adapter(createAdapter(pub, sub));
      console.log('[SOCKET.IO] Redis adapter attached');
    } else {
      dwarn('[SOCKET.IO] No REDIS_URL set. Running without Redis adapter.');
    }
  } catch (e) {
    derr('[SOCKET.IO] Redis adapter failed; continuing in-memory:', e.message);
  }
})();

// ---- Medication sanitizer: keep only "pure" medication (name ± strength) ----
function normalizeMedicationList(raw) {
  // Accept string or array; split strings into items
  let items = Array.isArray(raw) ? raw.slice() :
    typeof raw === 'string' ? raw.split(/[\n;,]+/) : [];

  return items
    .map(s => (s ?? '').toString())
    // strip bullets/numbering
    .map(s => s.replace(/^\s*[-•\u2022\u25CF]*\s*\d*[.)]?\s*/g, '').trim())
    // keep only the leading "drug name [strength unit]" and drop trailing sentences
    .map(s => {
      // Try to capture: Name (letters, numbers, spaces, -, /) + optional strength (e.g., 500 mg)
      const m = s.match(/^([A-Za-z][A-Za-z0-9\s\-\/]+?(?:\s+\d+(?:\.\d+)?\s*(?:mg|mcg|g|kg|ml|mL|l|L|iu|IU|units|mcL|µg|%))?)/);
      if (m) return m[1].trim();

      // Fallback: cut at the first sentence break, but keep decimals like "2.5 mg"
      const cut = s.split(/(?<!\d)\.(?!\d)/)[0]; // split on period not between digits
      return cut.trim();
    })
    // remove common instruction tails if any slipped through
    .map(s => s.replace(/\b(take|give|use|apply|instill|one|two|daily|once|twice|bid|tid|qid|po|prn|before|after|with|without|meals?|for|x|weeks?|days?|hours?)\b.*$/i, '').trim())
    // collapse extra spaces
    .map(s => s.replace(/\s{2,}/g, ' ').trim())
    // drop empties
    .filter(s => s.length > 0);
}

async function generateSoapNote(transcript) {
  try {
    const prompt = `
Based on the provided transcript, generate a structured SOAP note.
Sections (always in this order):
- Chief Complaints
- History of Present Illness
- Subjective
- Objective
- Assessment
- Plan
- Medication
 
Rules:
- Each section should be an array of strings OR "No data available".
- If info missing, explicitly write "No data available".
- JSON only, no extra commentary.
 
Transcript:
${transcript.trim()}
    `.trim();

    // ---------- ENV ----------
    const ABACUS_API_KEY = process.env.ABACUS_API_KEY;
    const ABACUS_MODEL = (process.env.ABACUS_MODEL || "gpt-4o").trim();
    const ABACUS_TEMPERATURE = Number(process.env.ABACUS_TEMPERATURE || 0.2);

    if (!ABACUS_API_KEY) {
      throw new Error("Missing ABACUS_API_KEY in environment");
    }

    // ---------- ROUTELLM CHAT COMPLETION ----------
    const response = await axios.post(
      "https://routellm.abacus.ai/v1/chat/completions",
      {
        model: ABACUS_MODEL,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: ABACUS_TEMPERATURE,
        stream: false, // IMPORTANT: keep false for JSON
      },
      {
        headers: {
          Authorization: `Bearer ${ABACUS_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );

    const rawContent =
      response?.data?.choices?.[0]?.message?.content || "";

    if (!rawContent) {
      throw new Error("Empty response from RouteLLM");
    }

    // ---------- CLEAN & PARSE JSON ----------
    const soapNoteContent = rawContent
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");

    let parsed;
    try {
      parsed = JSON.parse(soapNoteContent);
    } catch (e) {
      const first = soapNoteContent.indexOf("{");
      const last = soapNoteContent.lastIndexOf("}");
      if (first !== -1 && last !== -1) {
        parsed = JSON.parse(soapNoteContent.slice(first, last + 1));
      } else {
        throw e;
      }
    }

    return {
      "Chief Complaints": parsed["Chief Complaints"] || ["No data available"],
      "History of Present Illness":
        parsed["History of Present Illness"] || ["No data available"],
      "Subjective": parsed["Subjective"] || ["No data available"],
      "Objective": parsed["Objective"] || ["No data available"],
      "Assessment": parsed["Assessment"] || ["No data available"],
      "Plan": parsed["Plan"] || ["No data available"],
      "Medication": parsed["Medication"] || ["No data available"],
    };

  } catch (err) {
    console.error("[SOAP_NOTE] generation failed:", err.message);
    return {
      "Chief Complaints": ["Error generating note"],
      "History of Present Illness": ["Error generating note"],
      "Subjective": ["Error generating note"],
      "Objective": ["Error generating note"],
      "Assessment": ["Error generating note"],
      "Plan": ["Error generating note"],
      "Medication": ["Error generating note"],
    };
  }
}

// Parse Medication from SOAP note, check dbo.DrugMaster.drug, and log availability
async function checkSoapMedicationAvailability(soapNote, opts = {}) {
  const schema = opts.schema || 'dbo';
  const table = opts.table || 'DrugMaster';
  const nameCol = opts.nameCol || 'drug';

  // Normalize a term in JS exactly the same way we normalize in SQL
  function normalizeTerm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[ \-\/\.,'()]/g, ''); // remove spaces and punctuation
  }

  function extractDrugQuery(raw) {
    if (!raw) return null;
    let s = String(raw)
      .replace(/^[-•]\s*/u, '')
      .replace(/\(.*?\)/g, '')
      .replace(/\b(tablet|tablets|tab|tabs|capsule|capsules|cap|caps|syrup|susp(?:ension)?|inj(?:ection)?)\b/gi, '')
      .replace(/\b(po|od|bd|tid|qid|prn|q\d+h|iv|im|sc|sl)\b/gi, '')
      .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|kg|ml|l|iu|units|%)\b/gi, '')
      .split(/\b\d/)[0]
      .replace(/[.,;:/]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return s || null;
  }

  // Updated: stronger, consistent matching with status=1 filter
  async function findDrugMatch(q) {
    const raw = String(q || '').trim();
    const rawLike = `%${raw}%`;
    const norm = normalizeTerm(raw);
    const normLike = `%${norm}%`;

    // SQL-side normalization expression (mirrors normalizeTerm)
    const normExpr = `
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(LOWER([${nameCol}]), '-', ''), ',', ''), '/', ''), '.', ''), '''', ''), ' ', ''), '(', ''), ')', '')
    `;

    const sql = `
      SELECT TOP 1 [${nameCol}] AS name
      FROM [${schema}].[${table}]
      WHERE status = 1
        AND [${nameCol}] IS NOT NULL
        AND (
          -- Exact (raw)
          LOWER([${nameCol}]) = LOWER(:raw)
          -- Contains (raw)
          OR LOWER([${nameCol}]) LIKE LOWER(:rawLike)
          -- Exact (normalized)
          OR ${normExpr} = :norm
          -- Contains (normalized)
          OR ${normExpr} LIKE :normLike
        )
      ORDER BY
        CASE
          WHEN ${normExpr} = :norm THEN 1
          WHEN LOWER([${nameCol}]) = LOWER(:raw) THEN 2
          WHEN ${normExpr} LIKE :normLike THEN 3
          ELSE 4
        END,
        [${nameCol}];
    `;

    const rows = await sequelize.query(sql, {
      replacements: { raw, rawLike, norm, normLike },
      type: Sequelize.QueryTypes.SELECT
    });
    return rows?.[0]?.name || null;
  }

  const meds = Array.isArray(soapNote?.Medication) ? soapNote.Medication : [];
  const queries = Array.from(new Set(
    meds
      .map(m => typeof m === 'string' ? m : (m?.name || m?.drug || m?.Medication || ''))
      .map(extractDrugQuery)
      .filter(Boolean)
  ));

  if (queries.length === 0) {
    console.log('[DRUG_CHECK] No medication entries to check.');
    return { results: [] };
  }

  const results = [];
  console.log(`[DRUG_CHECK] Checking ${queries.length} medication name(s) against ${schema}.${table}.${nameCol} ...`);
  for (const q of queries) {
    try {
      const matched = await findDrugMatch(q);
      if (matched) {
        console.log(`[DRUG_CHECK] "${q}" => AVAILABLE (matched as "${matched}")`);
        results.push({ query: q, status: 'exists', matched });
      } else {
        console.log(`[DRUG_CHECK] "${q}" => NOT FOUND`);
        results.push({ query: q, status: 'not_found', matched: null });
      }
    } catch (e) {
      console.log(`[DRUG_CHECK] "${q}" => ERROR: ${e.message || e}`);
      results.push({ query: q, status: 'error', error: String(e) });
    }
  }

  const ok = results.filter(r => r.status === 'exists').length;
  const nf = results.filter(r => r.status === 'not_found').length;
  console.log(`[DRUG_CHECK] Summary: ${ok} found, ${nf} not found, ${results.length - ok - nf} errors.`);
  return { results };
}

// -------------------- Socket.IO Handlers --------------------
io.on('connection', (socket) => {
  console.log(`🔌 [CONNECTION] ${socket.id}`);
  dlog('[CONNECTION] handshake.query:', safeDataPreview(socket.handshake?.query));

  // Send recent message history
  if (messageHistory.length > 0) {
    const recent = messageHistory.slice(-10);
    dlog('[CONNECTION] sending message_history size=', recent.length);
    socket.emit('message_history', { type: 'message_history', messages: recent });
  }

  // after sending message_history (or right at the top of the connection handler)
  (async () => {
    try {
      // send current presence snapshot
      const list = await buildDeviceListGlobal();
      socket.emit('device_list', list);

      // send current active pair snapshot
      socket.emit('room_update', { pairs: collectPairs() });
    } catch (e) {
      dwarn('[connection] initial snapshots failed:', e?.message || e);
    }
  })();

  // -------- join --------
  socket.on('join', (xrId) => {
    dlog('[EVENT] join', xrId);
    socket.data.xrId = xrId;
    socket.join(roomOf(xrId));
    clients.set(xrId, socket);
    onlineDevices.set(xrId, socket);
    (async () => {
      try {
        const list = await buildDeviceListGlobal();
        socket.emit('device_list', list);
        await broadcastDeviceList();
      } catch (e) {
        derr('[join] broadcast err:', e.message);
      }
    })();
  });


  // -------- identify --------
  socket.on('identify', async ({ deviceName, xrId }) => {
    dlog('[EVENT] identify', { deviceName, xrId });

    // Validate
    if (!xrId || typeof xrId !== 'string') {
      dwarn('[IDENTIFY] missing/invalid xrId');
      socket.emit('error', { message: 'Missing xrId' });
      return socket.disconnect(true);
    }

    // ✅ normalize once (Option B)
    const XR = normXr(xrId);

    // 🔒 Duplicate xrId handling (NEWEST WINS): if an old socket exists, kick it and accept this one.
    try {
      const all = await safeFetchSockets(io, "/");
      const holder = all.find(s =>
        s.id !== socket.id &&
        typeof s.data?.xrId === 'string' &&
        normXr(s.data.xrId) === XR
      );

      if (holder) {
        const holderInfo = {
          xrId: XR,
          deviceName: holder.data?.deviceName || 'Unknown',
          since: holder.data?.connectedAt || null,
          socketId: holder.id,
        };
        dlog('[IDENTIFY] Duplicate xrId detected — disconnecting old socket, keeping new:', holderInfo);

        // Clear stale pairing state for this XR (and its partner) so re-pair works cleanly
        clearPairByXrId(XR);

        // Best-effort: disconnect the old socket
        try {
          try { holder.data.roomId = null; } catch { }
          holder.emit('replaced_by_new_session', { xrId: XR });
        } catch { }
        try {
          holder.disconnect(true);
        } catch (e) {
          dwarn('[IDENTIFY] failed to disconnect old holder:', e?.message || e);
        }
      }
    } catch (e) {
      dwarn('[IDENTIFY] fetchSockets failed; continuing cautiously:', e?.message || e);
    }


    // ✅ Accept this socket
    socket.data.deviceName = deviceName || 'Unknown';
    socket.data.xrId = XR;
    socket.data.connectedAt = Date.now();

    // try { await socket.join(roomOf(XR)); }
    // catch (e) { dwarn('[IDENTIFY] join room failed:', e?.message || e); }

    clients.set(XR, socket);
    onlineDevices.set(XR, socket);

    // Track desktop for convenience
    if ((deviceName?.toLowerCase().includes('desktop')) || XR === 'XR-1238') {
      desktopClients.set(XR, socket);
      dlog('[IDENTIFY] desktop client tracked', XR);
    }

    // Send ONLY self until DB pairing completes (prevents global device leak)
    try {
      const b = batteryByDevice?.get(XR) || {};
      const t = telemetryByDevice?.get(XR) || null;

      socket.emit('device_list', [{
        xrId: XR,
        deviceName: socket.data?.deviceName || 'Unknown',
        battery: (typeof b.pct === 'number') ? b.pct : null,
        charging: !!b.charging,
        batteryTs: b.ts || null,
        ...(t ? { telemetry: t } : {}),
      }]);
    } catch (e) {
      derr('[identify] self device_list error:', e.message);
    }


    try {
      if (!socket.data?.roomId) {
        await tryDbAutoPair(XR);
      } else {
        dlog('[IDENTIFY] Skipping tryDbAutoPair; already in room', socket.data.roomId);
      }
    } catch (e) {
      derr('[identify] tryDbAutoPair error:', e.message);
    }
  });

  // -------- metrics_subscribe / unsubscribe (NEW) --------
  socket.on('metrics_subscribe', ({ xrId }) => {
    if (!xrId) return;
    socket.join(`metrics:${xrId}`);
    socket.emit('metrics_snapshot', {
      xrId,
      telemetry: telemetryHist.get(xrId) || [],
      quality: qualityHist.get(xrId) || [],
    });
  });

  socket.on('metrics_unsubscribe', ({ xrId }) => {
    if (!xrId) return;
    socket.leave(`metrics:${xrId}`);
  });




  // -------- request_device_list --------
  socket.on('request_device_list', async () => {
    dlog('[EVENT] request_device_list');
    try {
      const roomId = socket.data?.roomId;

      // ✅ If paired → ONLY devices in this pair room
      if (roomId) {
        socket.emit('device_list', await buildDeviceListForRoom(roomId));
        return;
      }

      // ✅ NOT paired yet → ONLY show *this* device (self), never global
      const xrId = normXr(socket.data?.xrId);
      if (!xrId) {
        socket.emit('device_list', []);
        return;
      }

      const b = batteryByDevice?.get(xrId) || {};
      const t = telemetryByDevice?.get(xrId) || null;

      socket.emit('device_list', [{
        xrId,
        deviceName: socket.data?.deviceName || 'Unknown',
        battery: (typeof b.pct === 'number') ? b.pct : null,
        charging: !!b.charging,
        batteryTs: b.ts || null,
        ...(t ? { telemetry: t } : {}),
      }]);

    } catch (e) {
      dwarn('[request_device_list] failed:', e.message);
    }
  });


  // -------- pair_with --------
  // Option B: DB-driven auto pairing is enabled.
  // Keep this handler for backward compatibility (frontend may still emit it),
  // but do NOT allow manual pairing to override DB mapping.
  socket.on('pair_with', async ({ peerId }) => {
    dlog('[EVENT] pair_with (disabled - auto pairing)', { me: socket.data?.xrId, peerId });

    // If the socket is not identified yet, keep the old error behavior.
    const me = socket.data?.xrId;
    if (!me) {
      socket.emit('pair_error', { message: 'Identify first (missing xrId)' });
      return;
    }

    // If already paired, just tell the client what room it is in.
    if (socket.data?.roomId) {
      socket.emit('pair_error', {
        message: 'Auto pairing enabled (already paired)',
        roomId: socket.data.roomId,
      });
      return;
    }

    // Try DB auto pairing as a convenience (safe fallback).
    // This does NOT use peerId; server decides partner from DB.
    try {
      const ok = await tryDbAutoPair(me);
      if (!ok) {
        socket.emit('pair_error', {
          message: 'Auto pairing enabled. Partner not available yet (or no active DB mapping).',
        });
      }
    } catch (err) {
      derr('[pair_with] auto pairing fallback error:', err?.message || err);
      socket.emit('pair_error', { message: 'Auto pairing enabled, but pairing attempt failed.' });
    }
  });


  // -------- signal --------
  socket.on('signal', (payload) => {
    // 1) Normalize payload (object or JSON string)
    let msg = payload;
    try { msg = (typeof payload === 'string') ? JSON.parse(payload) : (payload || {}); }
    catch (e) { return dwarn('[signal] JSON parse failed'); }

    const { type } = msg;
    dlog('📡 [EVENT] signal', { type, preview: safeDataPreview(msg) });

    try {
      // 2) Intercept Android/Dock quality feed and **return** (don’t fall through)
      if (type === 'webrtc_quality_update') {
        const deviceId = msg.deviceId;
        const samples = Array.isArray(msg.samples) ? msg.samples : [];

        if (deviceId && samples.length) {
          // Store to the existing per-device history so your detail modal works
          for (const s of samples) {
            pushHist(qualityHist, deviceId, {
              ts: s.ts,
              jitterMs: numOrNull(s.jitterMs),
              rttMs: numOrNull(s.rttMs),
              lossPct: numOrNull(s.lossPct),
              bitrateKbps: numOrNull(s.bitrateKbps),
            });
          }

          // Stream the latest deltas to any open detail modal subscribers
          io.to(`metrics:${deviceId}`).emit('metrics_update', {
            xrId: deviceId,
            quality: samples.map(s => ({
              ts: s.ts,
              jitterMs: s.jitterMs,
              rttMs: s.rttMs,
              lossPct: s.lossPct,
              bitrateKbps: s.bitrateKbps,
            })),
          });

          // Broadcast to dashboards (powers the connection tiles)
          // Option B: route quality updates only to the paired room (no global emit)
          const roomId = socket.data?.roomId;
          if (roomId) io.to(roomId).emit('webrtc_quality_update', { deviceId, samples });

        }
        return; // ✅ do not route as a regular signaling message
      }

      // 3) offer/answer/ICE path (Option B: strict pair-room only)

      // ✅ Always trust socket identity, never payload
      const from = socket.data?.xrId;
      if (!from) {
        dwarn('[signal] missing socket.data.xrId; ignoring');
        return;
      }

      const data = msg.data;

      // ✅ OPTIONAL but recommended: allowlist only WebRTC signaling types from clients
      const allowed = new Set(['offer', 'answer', 'ice-candidate', 'request_offer']);
      if (!allowed.has(type)) {
        dwarn('[signal] blocked non-webrtc client signal type:', type);
        return;
      }

      const roomId = socket.data?.roomId;
      if (!roomId) {
        dwarn('[signal] no roomId (not paired yet); ignoring');
        socket.emit('signal_error', { message: 'Not paired yet (no room)' });
        return;
      }

      dlog('[signal] pair-room forward', { roomId, type });
      // Forward ONLY within pair room
      socket.to(roomId).emit('signal', { type, from, data });



    } catch (err) {
      derr('[signal] handler error:', err.message);
    }
  });


  // -------- control --------
  socket.on('control', (raw) => {
    // Accept string or object payloads
    let p = raw;
    try {
      p = (typeof raw === 'string') ? JSON.parse(raw) : (raw || {});
    } catch {
      p = (raw || {});
    }

    // Accept both `command` and `action`; keep original casing for compatibility
    const cmdRaw = (p.command != null ? p.command : p.action) || '';
    const cmd = String(cmdRaw);
    const from = socket.data?.xrId;
    if (!from) {
      dwarn('[control] missing socket.data.xrId; ignoring');
      return;
    }

    const to = p.to;
    const msg = p.message;

    dlog('🎮 [EVENT] control', { command: cmd, from, to, message: trimStr(msg || '') });

    // Keep both keys so all clients see what they expect
    const payload = { command: cmd, action: cmd, from, to, message: msg };


    try {
      // Option B strict isolation:
      // Ignore "to" and NEVER broadcast control globally.
      // Control messages must stay inside the paired room only.
      const roomId = socket.data?.roomId;
      if (!roomId) {
        dwarn('[control] no roomId (not paired yet); ignoring', { command: cmd });
        socket.emit('control_error', { message: 'Not paired yet (no room)', command: cmd });
        return;
      }

      dlog('[control] pair-room emit', { roomId, ignoredTo: to || null });
      io.to(roomId).emit('control', payload);

    } catch (err) {
      derr('[control] handler error:', err.message);
    }
  });

  // -------- message (transcript -> web console via signal) --------
  socket.on('message', (payload) => {
    dlog('[EVENT] message', safeDataPreview(payload));

    let data;
    try {
      data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (e) {
      return dwarn('[message] JSON parse failed:', e.message);
    }

    const type = data?.type || 'message';
    const from = socket.data?.xrId;
    if (!from) {
      dwarn('[message] missing socket.data.xrId; ignoring');
      return;
    }

    const to = data?.to;
    const text = data?.text;
    const urgent = !!data?.urgent;
    const timestamp = data?.timestamp || new Date().toISOString();
    // Option B strict isolation: all messaging must stay inside the paired room
    const pairRoomId = socket.data?.roomId || null;


    // ✳️ Intercept transcripts: forward to desktop's web console via a signal, then STOP
    if (type === 'transcript') {
      const out = {
        type: 'transcript',
        from,
        to: null,
        text,
        final: !!data?.final,
        timestamp,
      };

      try {
        // Forward transcript ONLY within pair room
        if (!pairRoomId) {
          dwarn('[transcript] no pairRoomId (not paired yet); ignoring');
          socket.emit('message_error', { message: 'Not paired yet (no room)' });
          return;
        }
        io.to(pairRoomId).emit('signal', { type: 'transcript_console', from, data: out });
        dlog('[transcript] emitted signal "transcript_console" to pair room', pairRoomId);


        // Generate SOAP note if this transcript is final
        if (out.final && out.text) {
          (async () => {
            try {
              const soapNote = await generateSoapNote(out.text);

              const target = pairRoomId;

              // Send SOAP note back to console UI
              if (target) {
                io.to(target).emit('signal', {
                  type: 'soap_note_console',
                  from,
                  data: soapNote,
                });
              }
              console.log('[SOAP_NOTE]', JSON.stringify(soapNote, null, 2));

              // Check Medication against dbo.DrugMaster(drug) and log availability
              const { results } = await checkSoapMedicationAvailability(soapNote, {
                schema: 'dbo',
                table: 'DrugMaster',
                nameCol: 'drug',
              });

              // Emit availability to both Dock (target) and Scribe Cockpit
              if (target) {
                io.to(target).emit('signal', {
                  type: 'drug_availability_console',
                  from,
                  data: results,
                });
              }

            } catch (e) {
              console.error('[SOAP/DRUG] failed:', e?.message || e);
            }
          })();
        }
      } catch (e) {
        dwarn('[transcript] emit failed:', e.message);
      }

      return; // stop normal message path
    }



    /// Normal chat message path (Option B: pair-room only)

    try {
      const msg = {
        type: 'message',
        from,
        to: null,
        text,
        urgent,
        sender: socket.data?.deviceName || from || 'unknown',
        xrId: from,
        timestamp,
      };
      addToMessageHistory(msg);

      if (!pairRoomId) {
        dwarn('[message] no pairRoomId (not paired yet); ignoring');
        socket.emit('message_error', { message: 'Not paired yet (no room)' });
        return;
      }

      dlog('[message] pair-room emit', { roomId: pairRoomId, ignoredTo: to || null });
      io.to(pairRoomId).emit('message', msg);

    } catch (err) {
      derr('[message] handler error:', err.message);
    }
  });






  // -------- clear-messages --------
  socket.on('clear-messages', ({ by }) => {
    dlog('[EVENT] clear-messages', { by });

    const roomId = socket.data?.roomId;
    if (!roomId) {
      dwarn('[clear-messages] no roomId; ignoring');
      return;
    }

    const payload = { type: 'message-cleared', by, messageId: Date.now() };
    io.to(roomId).emit('message-cleared', payload);
  });

  // -------- clear_confirmation --------
  socket.on('clear_confirmation', ({ device }) => {
    dlog('[EVENT] clear_confirmation', { device });

    const roomId = socket.data?.roomId;
    if (!roomId) {
      dwarn('[clear_confirmation] no roomId; ignoring');
      return;
    }

    const payload = { type: 'message_cleared', by: device, timestamp: new Date().toISOString() };
    io.to(roomId).emit('message_cleared', payload);
  });


  // -------- status_report --------
  socket.on('status_report', ({ from, status }) => {
    dlog('[EVENT] status_report', { from, status: trimStr(status || '') });
    const payload = {
      type: 'status_report',
      from,
      status,
      timestamp: new Date().toISOString(),
    };
    const roomId = socket.data?.roomId;
    if (roomId) {
      dlog('[status_report] room emit', roomId);
      io.to(roomId).emit('status_report', payload);
    } else {
      dlog('[status_report] global emit');
      io.emit('status_report', payload);
    }
  });

  // -------- battery (NEW) --------
  socket.on('battery', ({ xrId, batteryPct, charging }) => {
    try {
      const id = xrId || socket.data?.xrId;
      if (!id) return;
      const pct = Math.max(0, Math.min(100, Number(batteryPct)));
      const rec = { pct, charging: !!charging, ts: Date.now() };

      batteryByDevice.set(id, rec);
      io.emit('battery_update', { xrId: id, pct: rec.pct, charging: rec.charging, ts: rec.ts });
      dlog('[battery] update', { id, pct: rec.pct, charging: rec.charging });
    } catch (e) {
      dwarn('[battery] bad payload:', e?.message || e);
    }
  });

  // -------- telemetry (NEW) --------
  socket.on('telemetry', (payload) => {
    try {
      const d = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const xrId = d.xrId || socket.data?.xrId;
      if (!xrId) return;

      // keep ALL fields (network + system)
      const rec = {
        xrId,
        connType: d.connType || 'none',

        // network (existing)
        wifiDbm: numOrNull(d.wifiDbm),
        wifiMbps: numOrNull(d.wifiMbps),
        wifiBars: numOrNull(d.wifiBars),
        cellDbm: numOrNull(d.cellDbm),
        cellBars: numOrNull(d.cellBars),
        netDownMbps: numOrNull(d.netDownMbps),
        netUpMbps: numOrNull(d.netUpMbps),

        // 🔵 system (NEW)
        cpuPct: numOrNull(d.cpuPct),
        memUsedMb: numOrNull(d.memUsedMb),
        memTotalMb: numOrNull(d.memTotalMb),
        deviceTempC: numOrNull(d.deviceTempC),

        ts: Date.now(),
      };

      // keep latest snapshot for device rows
      telemetryByDevice.set(xrId, rec);

      // time-series history (for modal charts)
      pushHist(telemetryHist, xrId, {
        ts: rec.ts,
        connType: rec.connType,
        wifiMbps: rec.wifiMbps,
        netDownMbps: rec.netDownMbps,
        netUpMbps: rec.netUpMbps,
        batteryPct: batteryByDevice.get(xrId)?.pct ?? null,

        // include system series
        cpuPct: rec.cpuPct,
        memUsedMb: rec.memUsedMb,
        memTotalMb: rec.memTotalMb,
        deviceTempC: rec.deviceTempC,
      });

      // live delta for open detail modal subscribers
      io.to(`metrics:${xrId}`).emit('metrics_update', {
        xrId,
        telemetry: [telemetryHist.get(xrId).at(-1)]
      });

      // broadcast the latest snapshot to dashboards
      io.emit('telemetry_update', rec);

      dlog('[telemetry] update', rec);
    } catch (e) {
      dwarn('[telemetry] bad payload:', e?.message || e);
    }
  });




  socket.on('webrtc_quality', (q) => {
    dlog('[QUALITY] recv', q);
    try {
      const xrId = (q && q.xrId) || socket.data?.xrId;
      if (!xrId) return;

      const snap = {
        xrId,
        ts: q.ts || Date.now(),
        jitterMs: numOrNull(q.jitterMs),
        lossPct: numOrNull(q.lossPct),
        rttMs: numOrNull(q.rttMs),
        fps: numOrNull(q.fps),
        dropped: numOrNull(q.dropped),
        nackCount: numOrNull(q.nackCount),
        // optional if your Dock computes it and sends it:
        bitrateKbps: numOrNull(q.bitrateKbps),
      };

      // keep latest (powers center tiles)
      qualityByDevice.set(xrId, snap);

      // 🔵 store to history + stream to detail subscribers
      pushHist(qualityHist, xrId, {
        ts: snap.ts,
        jitterMs: snap.jitterMs,
        rttMs: snap.rttMs,
        lossPct: snap.lossPct,
        bitrateKbps: snap.bitrateKbps,
      });
      io.to(`metrics:${xrId}`).emit('metrics_update', {
        xrId,
        quality: [qualityHist.get(xrId).at(-1)]
      });

      // existing broadcast (summary tiles)
      io.emit('webrtc_quality_update', Array.from(qualityByDevice.values()));
    } catch (e) {
      dwarn('[QUALITY] store/broadcast failed:', e?.message || e);
    }
  });




  // -------- message_history (on demand) --------
  socket.on('message_history', () => {
    dlog('[EVENT] message_history request');
    socket.emit('message_history', {
      type: 'message_history',
      messages: messageHistory.slice(-10),
    });
  });



  // Notify peers *before* Socket.IO removes the socket from rooms
  // Notify peers *before* Socket.IO removes the socket from rooms
  socket.on('disconnecting', () => {
    const xrId = normXr(socket.data?.xrId);
    if (!xrId) return;

    for (const roomId of socket.rooms) {
      if (roomId.startsWith('pair:')) {
        socket.to(roomId).emit('peer_left', { xrId, roomId });
        // optional compatibility ping
        socket.to(roomId).emit('desktop_disconnected', { xrId, roomId });

        dlog('[disconnecting] notified peer_left', { xrId, roomId });
        // ✅ NEW: update ONLY this room's device list (prevents global leak)
        broadcastEmptyDeviceListOnce(roomId);
      }
    }
  });





  socket.on('disconnect', async (reason) => {
    dlog('❎ [EVENT] disconnect', {
      reason,
      xrId: socket.data?.xrId,
      device: socket.data?.deviceName
    });

    try {
      const xrId = normXr(socket.data?.xrId);
      if (xrId) {
        // Remove from your in-memory maps
        clients.delete(xrId);
        onlineDevices.delete(xrId);

        // ✅ Capture room before clearing it
        const roomIdAtDisconnect = socket.data?.roomId;

        // ✅ Clear authoritative room routing for this socket
        socket.data.roomId = null;

        // ✅ Option B: release one-to-one lock (do this ONCE)
        const partner = clearPairByXrId(xrId);
        if (partner) {
          dlog('[PAIR] cleared pairing', { xrId, partner });
        }

        if (desktopClients.get(xrId) === socket) {
          desktopClients.delete(xrId);
          dlog('[disconnect] removed desktop client:', xrId);
        }

        // ✅ Broadcast device list ONLY to the pair room
        await broadcastDeviceList(roomIdAtDisconnect);

        // ✅ After Socket.IO prunes rooms, reflect pair changes
        setTimeout(() => {
          broadcastPairs();
        }, 0);
      }

    } catch (err) {
      derr('[disconnect] cleanup error:', err.message);
    }
  });






  // -------- error --------
  socket.on('error', (err) => {
    derr(`[SOCKET_ERROR] ${socket.id}:`, err?.message || err);
  });
});




// -------------------- Start & Shutdown --------------------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [SERVER] Running on http://0.0.0.0:${PORT}`);
});

process.on('uncaughtException', (err) => {
  derr('[FATAL] uncaughtException:', err?.stack || err?.message || err);
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  console.log('\n[SHUTDOWN] Starting graceful shutdown…');
  (async () => {
    try {
      const socketCount = io.sockets.sockets.size;
      dlog('[SHUTDOWN] active sockets:', socketCount);

      // 1) stop socket.io
      io.sockets.sockets.forEach((s) => s.disconnect(true));
      await new Promise((resolve) => io.close(resolve));
      console.log('[SHUTDOWN] Socket.IO closed');

      // 2) close HTTP server
      await new Promise((resolve) => server.close(resolve));
      console.log('[SHUTDOWN] HTTP server closed');

      // 3) close DB
      try {
        await closeDatabase();
      } catch (e) {
        dwarn('[SHUTDOWN] DB close error:', e?.message || e);
      }

      process.exit(0);
    } catch (e) {
      derr('[SHUTDOWN] error:', e?.message || e);
      process.exit(1);
    }
  })();
}

