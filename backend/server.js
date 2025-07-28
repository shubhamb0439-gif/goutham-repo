const WebSocket = require('ws');
// Bind to ALL interfaces so any device on LAN/WAN can connect:
const wss = new WebSocket.Server({ host: '0.0.0.0', port: 8080, clientTracking: true });

console.log('[WS] Server running on ws://0.0.0.0:8080');

const clients = new Set();
const messageHistory = [];

// --- Utility for heartbeat (keepalive) ---
const heartbeat = (ws) => {
  ws.isAlive = true;
};

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
        console.log('[WEBRTC] Offer from', from || 'unknown', 'to', to);
        broadcastToTarget({
          type: 'offer',
          sdp: data.sdp,
          from,
          to
        }, ws);
        break;

      case 'answer':
        console.log('[WEBRTC] Answer from', from || 'unknown', 'to', to);
        broadcastToTarget({
          type: 'answer',
          sdp: data.sdp,
          from,
          to
        }, ws);
        break;

      case 'ice-candidate':
        // NOTE: candidate should always include { candidate, sdpMid, sdpMLineIndex }
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

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[DISCONNECTED] ${ws.deviceName || 'Unknown'} (${ws.xrId || 'no-id'})`);
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

// Only sends to the desktop client(s)
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

// Targeted broadcast by xrId or deviceName (used for offer, answer, ICE, etc)
function broadcastToTarget(data, sender) {
  if (data.to) {
    let sent = false;
    clients.forEach(c => {
      if (
        (c.xrId === data.to || c.deviceName === data.to) &&
        c.readyState === WebSocket.OPEN &&
        c !== sender
      ) {
        c.send(JSON.stringify(data));
        sent = true;
      }
    });
    if (!sent) {
      console.warn(`[WS] No client found for target xrId/deviceName: ${data.to}`);
    }
  } else {
    // If 'to' not provided, send to everyone except sender (failsafe)
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

// Heartbeat ping every 30s to keep connections alive (avoid idle timeout)
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

wss.on('close', () => clearInterval(interval));

// Graceful shutdown (SIGINT, SIGTERM)
process.on('SIGINT', () => {
  console.log('[WS] Closing server...');
  wss.close();
  process.exit();
});
process.on('SIGTERM', () => {
  console.log('[WS] Closing server...');
  wss.close();
  process.exit();
});
process.on('uncaughtException', (err) => {
  console.error('[WS ERROR] Uncaught exception:', err);
});
