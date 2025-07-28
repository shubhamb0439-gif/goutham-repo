const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 8080;

// Configure static files
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));

// Health check endpoint (critical for Azure)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    websocketClients: wss?.clients?.size || 0
  });
});

// SPA fallback route
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Create HTTP server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Server running on port ${PORT}`);
  console.log(`[HTTP] Serving static files from ${publicPath}`);
});

// WebSocket Server Setup
const wss = new WebSocket.Server({ server, clientTracking: true });
const clients = new Set();
const messageHistory = [];

console.log(`[WS] WebSocket server running on ws://0.0.0.0:${PORT}`);

// Heartbeat function
const heartbeat = (ws) => { ws.isAlive = true; };

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;

  ws.on('pong', () => heartbeat(ws));
  ws.on('error', (error) => console.error('[WS ERROR]', error));

  // Send message history to new connections
  if (messageHistory.length > 0) {
    ws.send(JSON.stringify({
      type: 'message_history',
      messages: messageHistory.slice(-10),
    }));
  }

  ws.on('message', (message) => {
    console.log('[WS] Received:', message.toString());

    let data;
    try {
      data = JSON.parse(message);
    } catch {
      console.warn('[WS WARNING] Non-JSON message:', message.toString());
      return;
    }

    if (!data?.type) {
      console.warn('[WS WARNING] Invalid message:', data);
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
        const clearEvent = {
          type: 'message-cleared',
          by: data.by,
          messageId: Date.now()
        };
        broadcastAll(clearEvent);
        break;

      case 'offer':
      case 'answer':
      case 'ice-candidate':
        broadcastToTarget({
          type,
          sdp: data.sdp,
          candidate: data.candidate,
          from,
          to
        }, ws);
        break;

      case 'control-command':
        broadcastAll({
          type: 'control-command',
          command: data.command,
          from
        });
        break;

      default:
        console.warn('[WS WARNING] Unknown type:', type);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[DISCONNECTED] ${ws.deviceName || 'Unknown'}`);
    broadcastDeviceList();
  });
});

// Broadcast functions
function broadcastAll(data) {
  const msg = JSON.stringify(data);
  clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(msg));
}

function broadcastExcept(sender, data) {
  const msg = JSON.stringify(data);
  clients.forEach(c => c !== sender && c.readyState === WebSocket.OPEN && c.send(msg));
}

function broadcastToDesktop(data) {
  const msg = JSON.stringify(data);
  clients.forEach(c => {
    if ((c.deviceName?.includes('Desktop') || c.xrId === 'XR-1238') && c.readyState === WebSocket.OPEN) {
      c.send(msg);
    }
  });
}

function broadcastToTarget(data, sender) {
  if (!data.to) return broadcastExcept(sender, data);
  
  const msg = JSON.stringify(data);
  let sent = false;
  
  clients.forEach(c => {
    if ((c.xrId === data.to || c.deviceName === data.to) && c.readyState === WebSocket.OPEN && c !== sender) {
      c.send(msg);
      sent = true;
    }
  });
  
  if (!sent) console.warn(`[WS] Target not found: ${data.to}`);
}

function broadcastDeviceList() {
  const devices = Array.from(clients)
    .filter(c => c.deviceName)
    .map(c => ({ name: c.deviceName, xrId: c.xrId }));
    
  broadcastAll({ type: 'device_list', devices });
}

// Heartbeat interval
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Graceful shutdown
function shutdown() {
  console.log('[SHUTDOWN] Initiating graceful shutdown...');
  clearInterval(interval);
  wss.close();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL ERROR]', err);
  shutdown();
});
