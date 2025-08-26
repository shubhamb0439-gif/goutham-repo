// // -------------------- Imports & Env --------------------
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

const dotenv = require('dotenv');
const envCandidates = [
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', '.env'),
];
let loadedFrom = null;
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    loadedFrom = p;
    break;
  }
}
console.log('[ENV] .env loaded from:', loadedFrom || 'process.env only');
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
// -------------------- Config & Servers --------------------
console.log('[INIT] Starting server initialization...');
const PORT = process.env.PORT || 8080;
console.log(`[CONFIG] Using port: ${PORT}`);
const app = express();
const server = http.createServer(app);
console.log('[HTTP] Server created');
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket'], // Azure-friendly
  pingInterval: 25000,
  pingTimeout: 30000,
});
console.log('[SOCKET.IO] Socket.IO server initialized');
// -------------------- Middleware --------------------
app.use(cors());
app.use(express.json());
console.log('[MIDDLEWARE] CORS + JSON enabled');
// // -------------------- Static --------------------
// const staticPaths = [
//   path.join(__dirname, 'public'),
//   path.join(__dirname, '../frontend'),
// ];
// let staticPathFound = null;
// for (const dir of staticPaths) {
//   if (fs.existsSync(dir)) {
//     app.use(express.static(dir));
//     staticPathFound = dir;
//     console.log(`[STATIC] Serving static from ${dir}`);
//   } else {
//     dlog('[STATIC] Not found:', dir);
//   }
// }
// if (!staticPathFound) dwarn('⚠️ No static path found.');
 
// // Route for cockpit page (works with backend/public or ../frontend)
// app.get(['/scribe-cockpit', '/scribe-cockpit.html'], (req, res) => {
//   const candidates = [
//     path.join(__dirname, 'public', 'scribe-cockpit.html'),
//     path.join(__dirname, '..', 'frontend', 'scribe-cockpit.html'),
//   ];
//   const hit = candidates.find(p => fs.existsSync(p));
//   console.log('[ROUTE] /scribe-cockpit hit. Candidates:', candidates, 'Chosen:', hit);
//   if (!hit) return res.status(404).send('scribe-cockpit.html not found');
//   res.sendFile(hit);
// });

// -------------------- Static --------------------
const staticPaths = [
  path.join(__dirname, 'public'),
  path.join(__dirname, '../frontend'),  // or '../frontend/dist' if build output
];

let staticPathFound = null;
for (const dir of staticPaths) {
  if (fs.existsSync(dir)) {
    app.use(express.static(dir));
    staticPathFound = dir;
    console.log(`[STATIC] Serving static from ${dir}`);
  } else {
    console.log('[STATIC] Not found:', dir);
  }
}
if (!staticPathFound) console.warn('⚠️ No static path found.');

// -------------------- Cockpit Route --------------------
app.get(['/scribe-cockpit', '/scribe-cockpit.html'], (req, res) => {
  const candidates = [
    path.join(__dirname, 'public', 'scribe-cockpit.html'),
    path.join(__dirname, '..', 'frontend', 'scribe-cockpit.html'),
    path.join(__dirname, '..', 'frontend', 'dist', 'scribe-cockpit.html'), // 👈 include dist if you build frontend
  ];

  const hit = candidates.find(p => fs.existsSync(p));
  console.log('[ROUTE] /scribe-cockpit hit. Candidates:', candidates, 'Chosen:', hit);

  if (!hit) {
    return res.status(404).send('scribe-cockpit.html not found');
  }
  res.sendFile(hit);
});

// -------------------- 404 handler (MUST be last) --------------------
app.use((req, res) => {
  res.status(404).send('Not Found');
});
 
// -------------------- TURN Injection --------------------
function injectTurnConfig(html) {
  dlog('[TURN] injectTurnConfig start');
  const cfg = `
    <script>
      window.TURN_CONFIG = {
        urls: '${process.env.TURN_URL || ''}',
        username: '${process.env.TURN_USERNAME || ''}',
        credential: '${process.env.TURN_CREDENTIAL || ''}'
      };
    </script>`;
  dlog('[TURN] injectTurnConfig done');
  return html.replace('</body>', `${cfg}\n</body>`);
}

// -------------------- Room Concept State --------------------
const clients = new Map();        // xrId -> socket
const desktopClients = new Map(); // xrId -> desktop socket
const onlineDevices = new Map();  // xrId -> socket (convenience)
dlog('[ROOM] State maps initialized');

const allowedPairs = new Set([normalizePair('XR-1234', 'XR-1238')]);
const PAIRINGS_MAP = new Map([
  ['XR-1234', 'XR-1238'],
  ['XR-1238', 'XR-1234'],
]);
dlog('[ROOM] allowedPairs:', Array.from(allowedPairs));
dlog('[ROOM] PAIRINGS_MAP:', Array.from(PAIRINGS_MAP.entries()));

function normalizePair(a, b) {
  return [a, b].sort().join('|');
}
async function isPairAllowed(a, b) {
  const key = normalizePair(a, b);
  const allowed = allowedPairs.has(key);
  dlog('[PAIR] isPairAllowed?', a, b, '=>', allowed, 'key=', key);
  return allowed;
}
function getRoomIdForPair(a, b) {
  const [one, two] = [a, b].sort();
  const roomId = `pair:${one}:${two}`;
  dlog('[ROOM] getRoomIdForPair', a, b, '=>', roomId);
  return roomId;
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
async function tryAutoPair(deviceId) {
  dlog('[AUTO_PAIR] attempt for', deviceId);
  const partnerId = PAIRINGS_MAP.get(deviceId);
  dlog('[AUTO_PAIR] partnerId:', partnerId);
  if (!partnerId) return false;

  const meSocket = clients.get(deviceId);
  const partnerSocket = clients.get(partnerId);
  dlog('[AUTO_PAIR] me?', !!meSocket, 'partner?', !!partnerSocket);
  if (!meSocket || !partnerSocket) return false;

  const allowed = await isPairAllowed(deviceId, partnerId);
  if (!allowed) return false;

  const roomId = getRoomIdForPair(deviceId, partnerId);
  const room = io.sockets.adapter.rooms.get(roomId);
  const memberCount = room ? room.size : 0;
  dlog('[AUTO_PAIR] roomId:', roomId, 'current members:', memberCount);
  if (memberCount >= 2) return false;

  await meSocket.join(roomId);
  await partnerSocket.join(roomId);
  meSocket.data.roomId = roomId;
  partnerSocket.data.roomId = roomId;
  dlog('[AUTO_PAIR] joined both to', roomId);

  const members = listRoomMembers(roomId);
  io.to(roomId).emit('room_joined', { roomId, members });
  dlog('[AUTO_PAIR] room_joined emitted for', roomId, 'members:', members);
  return true;
}

// -------------------- Utilities --------------------
function roomOf(xrId) {
  return `xr:${xrId}`;
}

const messageHistory = [];
dlog('[STATE] messageHistory initialized');

async function buildDeviceListGlobal() {
  dlog('[DEVICE_LIST] building (global via fetchSockets)');
  const sockets = await io.fetchSockets();
  const byId = new Map();
  for (const s of sockets) {
    const id = s?.data?.xrId;
    if (!id) continue;
    byId.set(id, { xrId: id, deviceName: s.data.deviceName || 'Unknown' });
  }
  const list = [...byId.values()];
  dlog('[DEVICE_LIST] built:', list);
  return list;
}
async function broadcastDeviceList() {
  dlog('[DEVICE_LIST] broadcast start');
  try {
    const list = await buildDeviceListGlobal();
    io.emit('device_list', list);
    dlog('[DEVICE_LIST] broadcast done (size:', list.length, ')');
  } catch (e) {
    dwarn('[DEVICE_LIST] Failed to build list:', e.message);
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
    const sockets = await io.fetchSockets();
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

app.get('/', (_req, res) => {
  dlog('[ROUTE] /');
  if (!staticPathFound) return res.status(404).send('Static not found');
  const html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
  res.send(injectTurnConfig(html));
});
app.get('*', (req, res) => {
  dlog('[ROUTE] *', req.path);
  if (!staticPathFound) return res.status(404).send('Static not found');
  const html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
  res.send(injectTurnConfig(html));
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

  // Basic identity
  socket.data.deviceName = deviceName || 'Unknown';
  socket.data.xrId = xrId;

  // Always join personal room and register in maps
  try {
    await socket.join(roomOf(xrId));
  } catch (e) {
    dwarn('[IDENTIFY] failed to join personal room:', e?.message || e);
  }
  clients.set(xrId, socket);
  onlineDevices.set(xrId, socket);

  // ---- Refresh-safe desktop handling ----
  // If this is the desktop client, replace any existing desktop socket for the same xrId
  if ((deviceName?.toLowerCase().includes('desktop')) || xrId === 'XR-1238') {
    const existing = desktopClients.get(xrId);

    if (existing && existing.id !== socket.id) {
      dlog('[IDENTIFY] Detected existing desktop session for', xrId, '— replacing (likely refresh)');
      const prevRoomId = existing?.data?.roomId;

      // Move new socket into the previous room (if any) BEFORE disconnecting old one.
      if (prevRoomId) {
        try {
          await socket.join(prevRoomId);
          socket.data.roomId = prevRoomId;
          const members = listRoomMembers(prevRoomId);
          dlog('[IDENTIFY] Migrated new socket into previous room', prevRoomId, 'members:', members);
          io.to(prevRoomId).emit('room_joined', { roomId: prevRoomId, members });
        } catch (e) {
          dwarn('[IDENTIFY] Failed to migrate room on refresh:', e?.message || e);
          // If migration fails, fall back to auto-pair later.
          socket.data.roomId = null;
        }
      }

      // Politely notify and disconnect the old socket
      try { existing.emit('error', { message: 'Replaced by new session (refresh)' }); } catch {}
      try { existing.disconnect(true); } catch (e) { dwarn('[IDENTIFY] error disconnecting old desktop socket:', e?.message || e); }
    }

    // Track (or re-track) the desktop socket
    desktopClients.set(xrId, socket);
    dlog('[IDENTIFY] desktop client tracked', xrId);
  }

  // Echo list to this client and broadcast updated global list
  try {
    const list = await buildDeviceListGlobal();
    socket.emit('device_list', list);
    await broadcastDeviceList();
  } catch (e) {
    derr('[identify] device_list error:', e.message);
  }

  // If not already in a migrated room, attempt server-driven auto-pairing
  try {
    if (!socket.data?.roomId) {
      await tryAutoPair(xrId);
    } else {
      dlog('[IDENTIFY] Skipping tryAutoPair; already in room', socket.data.roomId);
    }
  } catch (e) {
    derr('[identify] tryAutoPair error:', e.message);
  }
});

  // -------- request_device_list --------
  socket.on('request_device_list', async () => {
    dlog('[EVENT] request_device_list');
    try {
      socket.emit('device_list', await buildDeviceListGlobal());
    } catch (e) {
      dwarn('[request_device_list] failed:', e.message);
    }
  });

  // -------- pair_with --------
  socket.on('pair_with', async ({ peerId }) => {
    dlog('[EVENT] pair_with', { me: socket.data?.xrId, peerId });
    try {
      const me = socket.data?.xrId;
      if (!me || !peerId) {
        dwarn('[pair_with] missing me or peerId');
        socket.emit('pair_error', { message: 'Identify and provide peerId' });
        return;
      }
      const allowed = await isPairAllowed(me, peerId);
      if (!allowed) {
        dwarn('[pair_with] not allowed', me, peerId);
        socket.emit('pair_error', { message: 'Pairing not allowed' });
        return;
      }
      const roomId = getRoomIdForPair(me, peerId);
      await socket.join(roomId);
      socket.data.roomId = roomId;

      const members = listRoomMembers(roomId);
      io.to(roomId).emit('room_joined', { roomId, members });
      dlog('[pair_with] room_joined emitted', { roomId, members });
    } catch (err) {
      derr('[pair_with] error:', err.message);
      socket.emit('pair_error', { message: 'Internal server error during pairing' });
    }
  });

  // -------- signal --------
  socket.on('signal', ({ type, from, to, data }) => {
    dlog('📡 [EVENT] signal', { type, from, to, dataPreview: safeDataPreview(data) });
    try {
      if (to) {
        dlog('[signal] direct target routing to', to);
        io.to(roomOf(to)).emit('signal', { type, from, data });
        return;
      }
      const roomId = socket.data?.roomId;
      if (!roomId) {
        dwarn('[signal] no "to" and no roomId; ignoring');
        socket.emit('signal_error', { message: 'No room joined and no "to" specified' });
        return;
      }
      dlog('[signal] room forward', roomId);
      socket.to(roomId).emit('signal', { type, from, data });
    } catch (err) {
      derr('[signal] handler error:', err.message);
    }
  });

  // -------- control --------
  socket.on('control', ({ command, from, to, message }) => {
    dlog('🎮 [EVENT] control', { command, from, to, message: trimStr(message || '') });
    const payload = { command, from, message };
    try {
      if (to) {
        dlog('[control] direct to', to);
        io.to(roomOf(to)).emit('control', payload);
      } else {
        const roomId = socket.data?.roomId;
        if (roomId) {
          dlog('[control] room emit', roomId);
          io.to(roomId).emit('control', payload);
        } else {
          dlog('[control] global emit');
          io.emit('control', payload);
        }
      }
    } catch (err) {
      derr('[control] handler error:', err.message);
    }
  });

  // -------- message --------
  // socket.on('message', ({ from, to, text, urgent }) => {
  //   dlog('[EVENT] message', { from, to, urgent, text: trimStr(text || '') });
  //   try {
  //     const msg = {
  //       type: 'message',
  //       from,
  //       to,
  //       text,
  //       urgent,
  //       sender: socket.data.deviceName || from || 'unknown',
  //       xrId: from,
  //       timestamp: new Date().toISOString(),
  //     };
  //     addToMessageHistory(msg);

  //     if (to) {
  //       dlog('[message] direct to', to);
  //       io.to(roomOf(to)).emit('message', msg);
  //     } else {
  //       const roomId = socket.data?.roomId;
  //       if (roomId) {
  //         dlog('[message] room emit', roomId);
  //         io.to(roomId).emit('message', msg);
  //       } else {
  //         dlog('[message] global broadcast (excluding sender)');
  //         socket.broadcast.emit('message', msg);
  //       }
  //     }
  //   } catch (err) {
  //     derr('[message] handler error:', err.message);
  //   }
  // });
  // -------- message (transcript-aware) --------
  
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
  const from = data?.from;
  const to   = data?.to;
  const text = data?.text;
  const urgent = !!data?.urgent;
  const timestamp = data?.timestamp || new Date().toISOString();

  // ✳️ Intercept transcripts: forward to desktop's web console via a signal, then STOP
  if (type === 'transcript') {
    const out = {
      type: 'transcript',
      from,
      to,
      text,
      final: !!data?.final,
      timestamp,
    };

    try {
      if (to) {
        // target the intended desktop only
        io.to(roomOf(to)).emit('signal', { type: 'transcript_console', from, data: out });
        dlog('[transcript] emitted signal "transcript_console" to', to);
      } else if (socket.data?.roomId) {
        // fallback: emit to current pair room
        io.to(socket.data.roomId).emit('signal', { type: 'transcript_console', from, data: out });
        dlog('[transcript] emitted signal "transcript_console" to room', socket.data.roomId);
      }
    } catch (e) {
      dwarn('[transcript] emit failed:', e.message);
    }

    return; // do NOT broadcast as a normal "message"
  }

  // Normal chat message path (unchanged)
  try {
    const msg = {
      type: 'message',
      from,
      to,
      text,
      urgent,
      sender: socket.data?.deviceName || from || 'unknown',
      xrId: from,
      timestamp,
    };
    addToMessageHistory(msg);

    if (to) {
      dlog('[message] direct to', to);
      io.to(roomOf(to)).emit('message', msg);
    } else {
      const roomId = socket.data?.roomId;
      if (roomId) {
        dlog('[message] room emit', roomId);
        io.to(roomId).emit('message', msg);
      } else {
        dlog('[message] global broadcast (excluding sender)');
        socket.broadcast.emit('message', msg);
      }
    }
  } catch (err) {
    derr('[message] handler error:', err.message);
  }
});





  // -------- clear-messages --------
  socket.on('clear-messages', ({ by }) => {
    dlog('[EVENT] clear-messages', { by });
    const payload = { type: 'message-cleared', by, messageId: Date.now() };
    io.emit('message-cleared', payload);
  });

  // -------- clear_confirmation --------
  socket.on('clear_confirmation', ({ device }) => {
    dlog('[EVENT] clear_confirmation', { device });
    const payload = { type: 'message_cleared', by: device, timestamp: new Date().toISOString() };
    io.emit('message_cleared', payload);
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

  // -------- message_history (on demand) --------
  socket.on('message_history', () => {
    dlog('[EVENT] message_history request');
    socket.emit('message_history', {
      type: 'message_history',
      messages: messageHistory.slice(-10),
    });
  });

  // -------- disconnect --------
  // socket.on('disconnect', async (reason) => {
  //   dlog('❎ [EVENT] disconnect', { reason, xrId: socket.data?.xrId, device: socket.data?.deviceName });
  //   try {
  //     const xrId = socket.data?.xrId;
  //     if (xrId) {
  //       clients.delete(xrId);
  //       onlineDevices.delete(xrId);
  //       if (desktopClients.get(xrId) === socket) {
  //         desktopClients.delete(xrId);
  //         dlog('[disconnect] removed desktop client:', xrId);
  //       }
  //     }
  //     await broadcastDeviceList();
  //   } catch (err) {
  //     derr('[disconnect] cleanup error:', err.message);
  //   }
  // });
//   socket.on('disconnect', async (reason) => {
//   dlog('❎ [EVENT] disconnect', { reason, xrId: socket.data?.xrId, device: socket.data?.deviceName });
//   try {
//     const xrId = socket.data?.xrId;
//     if (xrId) {
//       // Remove from your in-memory maps
//       clients.delete(xrId);
//       onlineDevices.delete(xrId);
//       if (desktopClients.get(xrId) === socket) {
//         desktopClients.delete(xrId);
//         dlog('[disconnect] removed desktop client:', xrId);
//       }

//       // 🔔 NEW: emit peer_left to any pair rooms this socket was in
//       for (const roomId of socket.rooms) {
//         if (roomId.startsWith('pair:')) {
//           socket.to(roomId).emit('peer_left', { xrId, roomId });
//           dlog('[disconnect] notified peer_left', { xrId, roomId });
//         }
//       }
//     }

//     // Still broadcast full device list so presence sync stays correct
//     await broadcastDeviceList();
//   } catch (err) {
//     derr('[disconnect] cleanup error:', err.message);
//   }
// });

// Notify peers *before* Socket.IO removes the socket from rooms
socket.on('disconnecting', () => {
  const xrId = socket.data?.xrId;
  if (!xrId) return;

  for (const roomId of socket.rooms) {
    if (roomId.startsWith('pair:')) {
      socket.to(roomId).emit('peer_left', { xrId, roomId });
      dlog('[disconnecting] notified peer_left', { xrId, roomId });
    }
  }
});

// Final cleanup and presence broadcast
socket.on('disconnect', async (reason) => {
  dlog('❎ [EVENT] disconnect', {
    reason,
    xrId: socket.data?.xrId,
    device: socket.data?.deviceName
  });

  try {
    const xrId = socket.data?.xrId;
    if (xrId) {
      // Remove from your in-memory maps
      clients.delete(xrId);
      onlineDevices.delete(xrId);

      if (desktopClients.get(xrId) === socket) {
        desktopClients.delete(xrId);
        dlog('[disconnect] removed desktop client:', xrId);
      }
    }

    // Broadcast device list so UIs update without manual refresh
    await broadcastDeviceList();
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
  try {
    const socketCount = io.sockets.sockets.size;
    dlog('[SHUTDOWN] active sockets:', socketCount);
    io.sockets.sockets.forEach((s) => s.disconnect(true));
    io.close(() => {
      console.log('[SHUTDOWN] Socket.IO closed');
      server.close(() => {
        console.log('[SHUTDOWN] HTTP server closed');
        process.exit(0);
      });
    });
  } catch (e) {
    derr('[SHUTDOWN] error:', e.message);
    process.exit(1);
  }
}
