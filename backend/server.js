// const express = require('express');
// const path = require('path');
// const WebSocket = require('ws');
// const fs = require('fs'); // Make sure to require fs
 
// const PORT = process.env.PORT || 8080;
// const app = express();
 
// // --- Static File Serving ---
// const staticPaths = [
//   path.join(__dirname, 'public')       // Primary location (where deployment puts files)
// ];
 
// let staticPathFound = null;
// staticPaths.forEach(possiblePath => {
//   if (fs.existsSync(possiblePath)) {
//     app.use(express.static(possiblePath));
//     console.log(`Serving static files from ${possiblePath}`);
//     staticPathFound = possiblePath;
//   }
// });
 
// if (!staticPathFound) {
//   console.error('ERROR: No static files directory found! Tried:', staticPaths);
// }
 
// // --- HEALTH CHECK ---
// app.get('/health', (req, res) => {
//   res.status(200).json({
//     status: 'healthy',
//     timestamp: new Date().toISOString(),
//     websocketClients: wss?.clients?.size || 0
//   });
// });
 
// // --- SPA fallback ---
// app.get('*', (req, res) => {
//   if (staticPathFound) {
//     res.sendFile(path.join(staticPathFound, 'index.html'));
//   } else {
//     res.status(404).send('Static files not found');
//   }
// });
 
const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');
require('dotenv').config();  // 1. Always at the top
 
const PORT = process.env.PORT || 8080;
const app = express();
 
// --- Static File Serving ---
const staticPaths = [
  path.join(__dirname, 'public'),         // For deployed builds
  path.join(__dirname, '../frontend')     // For development (your current structure)
];
 
let staticPathFound = null;
staticPaths.forEach(possiblePath => {
  if (fs.existsSync(possiblePath)) {
    app.use(express.static(possiblePath));
    console.log(`Serving static files from ${possiblePath}`);
    if (!staticPathFound) staticPathFound = possiblePath;
  }
});
if (!staticPathFound) {
  console.error('ERROR: No static files directory found! Tried:', staticPaths);
}
 
// --- Helper: Inject TURN config into HTML as a <script> tag ---
function injectTurnConfig(html) {
  const turnConfigScript = `
    <script>
      window.TURN_CONFIG = {
        urls: '${process.env.TURN_URL}',
        username: '${process.env.TURN_USERNAME}',
        credential: '${process.env.TURN_CREDENTIAL}'
      };
    </script>
  `;
  return html.replace('</body>', `${turnConfigScript}\n</body>`);
}
 
// --- HEALTH CHECK ---
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    websocketClients: wss?.clients?.size || 0
  });
});
 
// --- Serve index.html with TURN config injected on '/' route ---
app.get('/', (req, res) => {
  if (!staticPathFound) return res.status(404).send('Static files not found');
  let html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
  res.send(injectTurnConfig(html));
});
 
// --- SPA fallback: inject TURN config for any unknown route ---
app.get('*', (req, res) => {
  if (staticPathFound) {
    let html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
    res.send(injectTurnConfig(html));
  } else {
    res.status(404).send('Static files not found');
  }
});

// --- Rest of your WebSocket code remains unchanged ---
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP+WS] Server running on http://0.0.0.0:${PORT}`);
});
 
const wss = new WebSocket.Server({ server }); // attaches to HTTP server!
const clients = new Set();
const messageHistory = [];
 
// --- Heartbeat ---
const heartbeat = (ws) => { ws.isAlive = true; };
 
// --- WebSocket Connection Handler ---
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
 
  ws.on('pong', () => heartbeat(ws));
  ws.on('error', (error) => console.error('[WS ERROR]', error));
 
  // On new connection, send the last 10 messages (history)
  if (messageHistory.length > 0) {
    ws.send(JSON.stringify({
      type: 'message_history',
      messages: messageHistory.slice(-10),
    }));
  }
 
  ws.on('message', (message) => {
    // DEBUG: Log every message received
    console.log('[WS] Received:', message.toString());
 
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      console.warn('[WS WARNING] Non-JSON message received:', message.toString());
      return;
    }
 
    if (!data || typeof data !== 'object' || !data.type) {
      console.warn('[WS WARNING] Invalid message object:', data);
      return;
    }
 
    const { type, from, to, deviceName } = data;
 
    switch (type) {
      case 'identification':
        ws.deviceName = deviceName || 'Unknown';
        ws.xrId = data.xrId || null;
        console.log(`[CONNECTED] ${ws.deviceName} (${ws.xrId || 'no-id'})`);
        broadcastDeviceList();
        break;
 
      case 'message':
        // Add unique ID and timestamp
        const fullMessage = {
          ...data,
          id: Date.now(),
          timestamp: new Date().toISOString()
        };
        messageHistory.push(fullMessage);
        if (messageHistory.length > 100) messageHistory.shift();
        broadcastExcept(ws, fullMessage);
        break;
 
      case 'clear-messages':
        console.log('[MESSAGE] Clear requested by', data.by);
        const clearEvent = {
          type: 'message-cleared',
          by: data.by,
          messageId: Date.now()
        };
        broadcastAll(clearEvent);
        break;
 
      case 'clear_confirmation':
        broadcastToDesktop({
          type: 'message_cleared',
          by: data.device,
          timestamp: new Date().toISOString()
        });
        break;
 
      // ==== WEBRTC SIGNALING (OFFER/ANSWER/ICE) ====
      case 'offer':
      case 'webrtc-offer':
        console.log('[WEBRTC] Offer from', from || 'unknown', 'to', to);
        broadcastToTarget({
          type: 'offer',
          sdp: data.sdp,
          from,
          to
        }, ws);
        break;
 
      case 'answer':
      case 'webrtc-answer':
        console.log('[WEBRTC] Answer from', from || 'unknown', 'to', to);
        broadcastToTarget({
          type: 'answer',
          sdp: data.sdp,
          from,
          to
        }, ws);
        break;
 
      case 'ice-candidate':
        console.log('[WEBRTC] ICE candidate from', from || 'unknown', 'to', to);
        broadcastToTarget({
          type: 'ice-candidate',
          candidate: data.candidate,
          from,
          to
        }, ws);
        break;
 
      // =============================================
 
      case 'control-command':
      case 'control_command':
        console.log('[CONTROL] Forwarding control command:', data.command);
        broadcastAll({
          type: 'control-command',
          command: data.command,
          from
        });
        break;
 
      case 'status_report':
        console.log('[STATUS] Report from', from);
        broadcastToDesktop({
          type: 'status_report',
          from: from,
          status: data.status,
          timestamp: new Date().toISOString()
        });
        break;
 
      default:
        console.warn('[WS WARNING] Unknown type:', type);
    }
  });
 
  ws.on('close', (code, reason) => {
    clients.delete(ws);
    console.log(`[DISCONNECTED] ${ws.deviceName || 'Unknown'} (${ws.xrId || 'no-id'}) | Code: ${code}, Reason: ${reason.toString()}`);
    broadcastDeviceList();
  });
});
 
// ==== Broadcast helpers ====
function broadcastAll(data) {
  const msg = JSON.stringify(data);
  clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}
function broadcastExcept(sender, data) {
  const msg = JSON.stringify(data);
  clients.forEach(c => {
    if (c !== sender && c.readyState === WebSocket.OPEN) c.send(msg);
  });
}
function broadcastToDesktop(data) {
  const msg = JSON.stringify(data);
  clients.forEach(c => {
    if (
      (c.deviceName === 'Desktop App' || c.deviceName === 'Desktop' || c.xrId === 'XR-1238')
      && c.readyState === WebSocket.OPEN
    ) {
      c.send(msg);
    }
  });
}
function broadcastToTarget(data, sender) {
  if (data.to) {
    let sent = false;
    clients.forEach(c => {
      if (
        (c.xrId === data.to || c.deviceName === data.to)
        && c.readyState === WebSocket.OPEN
        && c !== sender
      ) {
        c.send(JSON.stringify(data));
        sent = true;
      }
    });
    if (!sent) {
      console.warn(`[WS] No client found for target xrId/deviceName: ${data.to}`);
    }
  } else {
    broadcastExcept(sender, data);
  }
}
function broadcastDeviceList() {
  const deviceList = Array.from(clients)
    .filter(c => c.deviceName)
    .map(c => ({ name: c.deviceName, xrId: c.xrId }));
 
  const msg = JSON.stringify({ type: 'device_list', devices: deviceList });
 
  clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}
 
// --- Heartbeat ping every 30s ---
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      console.log(`[WS] Terminating dead client: ${ws.deviceName || 'Unknown'}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
 
// --- Graceful shutdown ---
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
 
function shutdown() {
  console.log('Shutting down server...');
  clearInterval(interval);
  wss.close();
  server.close();
  process.exit(0);
}
 
process.on('uncaughtException', (err) => {
  console.error('[WS ERROR] Uncaught exception:', err);
});
 
