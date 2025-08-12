const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
require('dotenv').config();

console.log('[INIT] Starting server initialization...');

// Configuration
const PORT = process.env.PORT || 8080;
console.log(`[CONFIG] Using port: ${PORT}`);

const app = express();
const server = http.createServer(app);
console.log('[HTTP] Server created');

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
console.log('[SOCKET.IO] Socket.IO server initialized');

// Middleware
app.use(cors());
app.use(express.json());
console.log('[MIDDLEWARE] CORS and JSON middleware applied');

// Static file handling
const staticPaths = [
  path.join(__dirname, 'public'),
  path.join(__dirname, '../frontend')
];

console.log('[STATIC] Checking for static paths...');
let staticPathFound = null;
staticPaths.forEach((dir) => {
  if (fs.existsSync(dir)) {
    app.use(express.static(dir));
    staticPathFound = dir;
    console.log(`[STATIC] Serving from ${dir}`);
  }
});
if (!staticPathFound) {
  console.warn('⚠️ [STATIC] No static path found.');
}

// TURN injection into HTML
function injectTurnConfig(html) {
  console.log('[TURN] Injecting TURN configuration into HTML');
  const configScript = `
    <script>
      window.TURN_CONFIG = {
        urls: '${process.env.TURN_URL || ''}',
        username: '${process.env.TURN_USERNAME || ''}',
        credential: '${process.env.TURN_CREDENTIAL || ''}'
      };
    </script>
  `;
  return html.replace('</body>', `${configScript}\n</body>`);
}

// HTTP routes
app.get('/health', (req, res) => {
  console.log('[HEALTH] Health check requested');
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    connectedClients: clients.size
  });
});

app.get('/', (req, res) => {
  console.log('[ROUTE] Serving root path');
  if (!staticPathFound) {
    console.warn('[ROUTE] Static path not found for root');
    return res.status(404).send('Static not found');
  }
  const html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
  res.send(injectTurnConfig(html));
});

app.get('*', (req, res) => {
  console.log(`[ROUTE] Catch-all route for: ${req.path}`);
  if (!staticPathFound) {
    console.warn('[ROUTE] Static path not found for catch-all');
    return res.status(404).send('Static not found');
  }
  const html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
  res.send(injectTurnConfig(html));
});

// Socket.IO logic
const clients = new Map();         // xrId → socket
const desktopClients = new Map();  // xrId → socket (desktop sockets)
const messageHistory = [];         // simple in-memory message history (last 100)

// Pairing / rooms
// For now: an in-memory allowlist. Replace with DB query later.
const allowedPairs = new Set([
  // canonical pairs (sorted) e.g., normalizePair('XR-1234', 'XR-1238')
  // Add your allowed hard-coded pairs here temporarily
  // Example:
  // normalizePair('XR-1234', 'XR-1238'),
]);

console.log('[SOCKET.IO] Data structures initialized');

// Utility: canonical pair key (order-independent)
function normalizePair(a, b) {
  return [a, b].sort().join('|');
}

// Whether pair is allowed (async-ready for DB later)
async function isPairAllowed(a, b) {
  console.log('[PAIR] Checking allowed pair for:', a, b);
  // Replace this with a DB lookup in production.
  const key = normalizePair(a, b);
  const allowed = allowedPairs.has(key);
  console.log('[PAIR] Allowed?', allowed, 'key=', key);
  return allowed;
}

// Build device list for broadcasts
function buildDeviceList() {
  console.log('[DEVICE_LIST] Building device list');
  return [...clients.entries()].map(([xrId, s]) => ({
    xrId,
    deviceName: s?.data?.deviceName || 'Unknown'
  }));
}

function broadcastDeviceList() {
  console.log('[DEVICE_LIST] Broadcasting device list to all clients');
  const deviceList = Array.from(clients.entries()).map(([xrId, socket]) => ({
    xrId,
    deviceName: socket.data.deviceName || 'Unknown'
  }));
  io.emit('device_list', deviceList);
}

function logCurrentDevices() {
  console.log('[DEVICES] Current connected devices:');
  if (clients.size === 0) {
    console.log('   (none)');
    return;
  }
  for (const [xrId, socket] of clients.entries()) {
    console.log(`   - ${socket.data.deviceName || 'Unknown'} (${xrId})`);
  }
}

function broadcastToDesktop(type, data) {
  console.log(`[BROADCAST] Sending to desktop clients: ${type}`);
  for (const socket of desktopClients.values()) {
    socket.emit(type, data);
  }
}

function broadcastToTarget(to, type, data) {
  console.log(`[TARGET] Sending to ${to}: ${type}`);
  const target = clients.get(to);
  if (target) {
    target.emit(type, data);
  } else {
    console.warn(`[TARGET] Target not found: ${to}`);
  }
}

function addToMessageHistory(message) {
  console.log('[MESSAGE_HISTORY] Adding message to history');
  messageHistory.push({
    ...message,
    id: Date.now(),
    timestamp: new Date().toISOString()
  });

  if (messageHistory.length > 100) {
    console.log('[MESSAGE_HISTORY] Trimming message history');
    messageHistory.shift();
  }
}

// Helper: compute deterministic room id for a pair
function getRoomIdForPair(a, b) {
  const [one, two] = [a, b].sort();
  return `pair:${one}:${two}`;
}

// Helper: get room members' xrIds (returns string array)
function listRoomMembers(roomId) {
  console.log('[ROOM] Listing members for', roomId);
  const set = io.sockets.adapter.rooms.get(roomId);
  if (!set) return [];
  return Array.from(set).map(sid => {
    const s = io.sockets.sockets.get(sid);
    return s?.data?.xrId || sid;
  });
}

// When server starts: listen for connections
io.on('connection', (socket) => {
  console.log(`🔌 [CONNECTION] New connection: ${socket.id}`);

  // If we have message history, send last few messages
  if (messageHistory.length > 0) {
    console.log(`[MESSAGE_HISTORY] Sending ${Math.min(10, messageHistory.length)} recent messages to new connection`);
    socket.emit('message_history', {
      type: 'message_history',
      messages: messageHistory.slice(-10)
    });
  }

  // Simple join (legacy)
  socket.on('join', (xrId) => {
    console.log(`[JOIN] Request from ${socket.id} to join as ${xrId}`);
    socket.data.xrId = xrId;
    clients.set(xrId, socket);
    console.log(`✅ [JOIN] Successfully joined as ${xrId}`);
    broadcastDeviceList();
    logCurrentDevices();
  });

  // Identification (deviceName + xrId)
  socket.on('identify', ({ deviceName, xrId }) => {
    console.log(`[IDENTIFY] Request from ${socket.id}: ${deviceName} (${xrId})`);
    try {
      socket.data.deviceName = deviceName || 'Unknown';
      socket.data.xrId = xrId;
      clients.set(xrId, socket);

      // Desktop detection
      if (deviceName?.toLowerCase().includes('desktop') || xrId === 'XR-1238') {
        console.log(`[IDENTIFY] Detected desktop client: ${xrId}`);
        if (desktopClients.has(xrId)) {
          console.warn(`[IDENTIFY] Duplicate desktop tab detected: ${xrId}`);
          socket.emit('error', { message: 'Duplicate desktop tab' });
          socket.disconnect();
          return;
        }
        desktopClients.set(xrId, socket);
      }

      console.log(`[IDENTIFY] Successfully identified: ${deviceName} (${xrId})`);

      // Send device list widely and echo to this client
      const list = buildDeviceList();
      io.emit('device_list', list);
      socket.emit('device_list', list);
    } catch (e) {
      console.error('[IDENTIFY] Error handling identify:', e);
    }
  });

  // ----------------------------
  // New: pair_with handler (join a private 1:1 room)
  // ----------------------------
  socket.on('pair_with', async ({ peerId }) => {
    console.log(`[PAIR] pair_with request from socket ${socket.id} (xrId=${socket.data?.xrId}) to peerId=${peerId}`);
    try {
      const me = socket.data?.xrId;
      if (!me) {
        console.warn('[PAIR] pair_with: socket has no xrId (identify first)');
        socket.emit('pair_error', { message: 'Identify before pairing' });
        return;
      }
      if (!peerId) {
        console.warn('[PAIR] pair_with: missing peerId');
        socket.emit('pair_error', { message: 'Missing peerId' });
        return;
      }

      // Validate pair permission
      const allowed = await isPairAllowed(me, peerId);
      if (!allowed) {
        console.warn('[PAIR] pair_with: pair not allowed', me, peerId);
        socket.emit('pair_error', { message: 'Pairing not allowed' });
        return;
      }

      const roomId = getRoomIdForPair(me, peerId);
      console.log(`[PAIR] Computed roomId=${roomId}`);

      // Inspect room membership size
      const roomSet = io.sockets.adapter.rooms.get(roomId);
      const memberCount = roomSet ? roomSet.size : 0;
      console.log(`[PAIR] Current members in ${roomId}: ${memberCount}`);

      if (memberCount >= 2) {
        console.warn('[PAIR] Room already full:', roomId);
        socket.emit('pair_error', { message: 'Room already full' });
        return;
      }

      // Join the room
      socket.join(roomId);
      socket.data.roomId = roomId;
      console.log(`[PAIR] Socket ${socket.id} (xrId=${me}) joined room ${roomId}`);

      // Broadcast room join info to members
      const members = listRoomMembers(roomId);
      io.to(roomId).emit('room_joined', { roomId, members });
      console.log('[PAIR] room_joined emitted for', roomId, 'members=', members);
    } catch (err) {
      console.error('[PAIR] pair_with handler error:', err);
      socket.emit('pair_error', { message: 'Internal server error during pairing' });
    }
  });

  // ----------------------------
  // WebRTC signaling
  // ----------------------------
  socket.on('signal', ({ type, from, to, data }) => {
    console.log(`📡 [SIGNAL] ${type} signal from ${from} to ${to || '(no to)'} (socket=${socket.id})`);
    try {
      // Preserve legacy direct-to behavior when 'to' is present
      if (to) {
        console.log('[SIGNAL] Using direct-target routing to', to);
        broadcastToTarget(to, 'signal', { type, from, data });
        return;
      }

      // If no 'to', try forwarding into socket's room
      const roomId = socket.data?.roomId;
      if (!roomId) {
        console.warn('[SIGNAL] Missing roomId and no "to" provided - cannot forward signal');
        socket.emit('signal_error', { message: 'No room joined and no "to" specified' });
        return;
      }

      // forward to other members in the room (not back to the sender)
      console.log(`[SIGNAL] Forwarding ${type} into room ${roomId}`);
      socket.to(roomId).emit('signal', { type, from, data });
    } catch (err) {
      console.error('[SIGNAL] Error handling signal:', err);
    }
  });

  // ----------------------------
  // Control commands
  // ----------------------------
  socket.on('control', ({ command, from, to, message }) => {
    console.log(`🎮 [CONTROL] ${command} command from ${from} to ${to || 'all'}`);
    const payload = { command, from, message };
    try {
      if (to) {
        broadcastToTarget(to, 'control', payload);
      } else {
        // If socket has room, send into room only; else broadcast global
        const roomId = socket.data?.roomId;
        if (roomId) {
          console.log('[CONTROL] Sending control into room', roomId);
          io.to(roomId).emit('control', payload);
        } else {
          io.emit('control', payload);
        }
      }
    } catch (err) {
      console.error('[CONTROL] Error handling control:', err);
    }
  });

  // ----------------------------
  // Messaging system
  // ----------------------------
  socket.on('message', ({ from, to, text, urgent }) => {
    console.log(`[MESSAGE] Received message from ${from} to ${to || '(no to)'}: ${text}`);
    try {
      const msg = {
        type: 'message',
        from,
        to,
        text,
        urgent,
        sender: socket.data.deviceName || from || 'unknown',
        xrId: from,
        timestamp: new Date().toISOString()
      };

      addToMessageHistory(msg);

      // routing:
      // 1) if 'to' present => direct
      // 2) else if room joined => room
      // 3) else => broadcast
      if (to) {
        broadcastToTarget(to, 'message', msg);
      } else {
        const roomId = socket.data?.roomId;
        if (roomId) {
          console.log('[MESSAGE] Emitting message into room', roomId);
          io.to(roomId).emit('message', msg);
        } else {
          console.log('[MESSAGE] Broadcasting message to everyone (legacy)');
          socket.broadcast.emit('message', msg);
        }
      }
    } catch (err) {
      console.error('[MESSAGE] Error processing message:', err);
    }
  });

  // ----------------------------
  // Clear messages
  // ----------------------------
  socket.on('clear-messages', ({ by }) => {
    console.log(`[CLEAR] Request to clear messages by ${by}`);
    const payload = { type: 'message-cleared', by, messageId: Date.now() };
    io.emit('message-cleared', payload);
  });

  socket.on('clear_confirmation', ({ device }) => {
    console.log(`[CLEAR_CONFIRM] Confirmation from ${device}`);
    const payload = {
      type: 'message_cleared',
      by: device,
      timestamp: new Date().toISOString()
    };
    broadcastToDesktop('message_cleared', payload);
  });

  // ----------------------------
  // Status reports
  // ----------------------------
  socket.on('status_report', ({ from, status }) => {
    console.log(`[STATUS_REPORT] Received from ${from}: ${status}`);
    const payload = {
      type: 'status_report',
      from,
      status,
      timestamp: new Date().toISOString()
    };

    // If in a private room, notify desktops in the room; else broadcast desktop clients
    const roomId = socket.data?.roomId;
    if (roomId) {
      console.log('[STATUS_REPORT] Emitting status report into room', roomId);
      io.to(roomId).emit('status_report', payload);
    } else {
      broadcastToDesktop('status_report', payload);
    }
  });

  // ----------------------------
  // Provide message history on demand
  // ----------------------------
  socket.on('message_history', () => {
    console.log(`[MESSAGE_HISTORY] Request from ${socket.id}`);
    socket.emit('message_history', {
      type: 'message_history',
      messages: messageHistory.slice(-10)
    });
  });

  // ----------------------------
  // Disconnect handling
  // ----------------------------
  socket.on('disconnect', (reason) => {
    console.log(`[DISCONNECT] Socket ${socket.id} disconnected. Reason: ${reason}`);
    try {
      const xrId = socket.data?.xrId;
      const roomId = socket.data?.roomId;

      // If socket was in a private room, notify room members and remove membership
      if (roomId) {
        console.log(`[DISCONNECT] Socket was in room ${roomId} - notifying other members`);
        // remove socket from room (socket.leave happens automatically on disconnect, but we still notify)
        io.to(roomId).emit('peer_left', { xrId: xrId || socket.id, roomId, timestamp: new Date().toISOString() });

        // After disconnect, check the remaining members: if none or only one (desktop left), handle cleanup if needed
        const remaining = io.sockets.adapter.rooms.get(roomId);
        const remainingCount = remaining ? remaining.size : 0;
        console.log(`[DISCONNECT] Remaining members in ${roomId}: ${remainingCount}`);
        // Note: If desktop disconnects, remaining XR should be disconnected or notified depending on policy.
        // We'll let room linger until both leave—clients should re-pair when desktop comes back.
      }

      if (xrId) {
        clients.delete(xrId);
        if (desktopClients.get(xrId) === socket) {
          desktopClients.delete(xrId);
          console.log(`[DISCONNECT] Removed desktop client: ${xrId}`);
          // When desktop disconnects, it's a policy decision: we can optionally notify the paired XR(s).
          // Find any rooms involving this desktop and notify members that room is terminated.
          // We'll attempt to find rooms where this xrId is a member (as one side of pair).
          // Build naive cleanup: iterate rooms and inform others
          for (const [rid, sids] of io.sockets.adapter.rooms) {
            if (!rid.startsWith('pair:')) continue;
            const members = listRoomMembers(rid);
            // if desktop xrId is part of this pair, emit room_terminated
            if (members.includes(xrId)) {
              console.log(`[DISCONNECT] Emitting room_terminated for ${rid}`);
              io.to(rid).emit('room_terminated', { roomId: rid, reason: 'desktop_disconnected' });
            }
          }
        }
        console.log(`❎ [DISCONNECT] ${socket.data.deviceName || 'Unknown'} (${xrId}) disconnected`);
      } else {
        console.log(`❎ [DISCONNECT] Anonymous ${socket.id} disconnected`);
      }
    } catch (err) {
      console.error('[DISCONNECT] Error during disconnect cleanup:', err);
    } finally {
      // Always refresh device list
      broadcastDeviceList();
      logCurrentDevices();
    }
  });

  socket.on('error', (err) => {
    console.error(`[SOCKET_ERROR] ${socket.id}:`, err);
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [SERVER] Running on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('uncaughtException', (err) => {
  console.error('[FATAL_ERROR] Uncaught exception:', err);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  console.log('\n[SHUTDOWN] Graceful shutdown initiated...');

  // Disconnect all sockets
  const socketCount = io.sockets.sockets.size;
  console.log(`[SHUTDOWN] Disconnecting ${socketCount} sockets...`);
  io.sockets.sockets.forEach(socket => {
    socket.disconnect(true);
  });

  // Close Socket.IO
  io.close(() => {
    console.log('[SHUTDOWN] Socket.IO server closed');

    // Close HTTP server
    server.close(() => {
      console.log('[SHUTDOWN] HTTP server closed');
      process.exit(0);
    });
  });
}

console.log('[INIT] Server initialization complete');
