// const express = require('express');
// const path = require('path');
// const WebSocket = require('ws');
// const fs = require('fs');
// require('dotenv').config();

// const PORT = process.env.PORT || 8080;
// const app = express();

// const staticPaths = [
//   path.join(__dirname, 'public'),
//   path.join(__dirname, '../frontend')
// ];

// let staticPathFound = null;
// staticPaths.forEach(possiblePath => {
//   if (fs.existsSync(possiblePath)) {
//     app.use(express.static(possiblePath));
//     console.log(`[STATIC] Serving static files from ${possiblePath}`);
//     if (!staticPathFound) staticPathFound = possiblePath;
//   }
// });
// if (!staticPathFound) {
//   console.error('ERROR: No static files directory found! Tried:', staticPaths);
// }

// function injectTurnConfig(html) {
//   const turnConfigScript = `
//     <script>
//       window.TURN_CONFIG = {
//         urls: '${process.env.TURN_URL}',
//         username: '${process.env.TURN_USERNAME}',
//         credential: '${process.env.TURN_CREDENTIAL}'
//       };
//     </script>
//   `;
//   return html.replace('</body>', `${turnConfigScript}\n</body>`);
// }

// app.get('/health', (req, res) => {
//   res.status(200).json({
//     status: 'healthy',
//     timestamp: new Date().toISOString(),
//     websocketClients: wss?.clients?.size || 0
//   });
// });

// app.get('/', (req, res) => {
//   if (!staticPathFound) return res.status(404).send('Static files not found');
//   let html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
//   res.send(injectTurnConfig(html));
// });

// app.get('*', (req, res) => {
//   if (staticPathFound) {
//     let html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
//     res.send(injectTurnConfig(html));
//   } else {
//     res.status(404).send('Static files not found');
//   }
// });

// const server = app.listen(PORT, '0.0.0.0', () => {
//   console.log(`[HTTP+WS] Server running on http://0.0.0.0:${PORT}`);
// });

// const wss = new WebSocket.Server({ server });
// const clients = new Set();
// const messageHistory = [];

// const heartbeat = (ws) => { ws.isAlive = true; };

// wss.on('connection', (ws) => {
//   clients.add(ws);
//   ws.isAlive = true;

//   console.log('\n[WS] New client connected (pending identification)...');
//   logCurrentDevices();

//   ws.on('pong', () => heartbeat(ws));
//   ws.on('error', (error) => console.error('[WS ERROR]', error));

//   // Send recent message history to new client
//   if (messageHistory.length > 0) {
//     ws.send(JSON.stringify({
//       type: 'message_history',
//       messages: messageHistory.slice(-10),
//     }));
//   }

//   ws.on('message', (message) => {
//     console.log('[WS] Received:', message.toString());

//     let data;
//     try {
//       data = JSON.parse(message);
//     } catch {
//       console.warn('[WS WARNING] Invalid JSON:', message.toString());
//       return;
//     }

//     if (!data || typeof data !== 'object' || !data.type) {
//       console.warn('[WS WARNING] Malformed message object:', data);
//       return;
//     }

//     const { type, from, to, deviceName } = data;

//     switch (type) {
//       case 'identification':
//         ws.deviceName = deviceName || 'Unknown';
//         ws.xrId = data.xrId || null;
//         console.log(`[IDENTIFIED] ${ws.deviceName} (${ws.xrId || 'no-id'}) just connected.`);
//         broadcastDeviceList();
//         logCurrentDevices();
//         break;

//       case 'message':
//         const fullMessage = {
//           ...data,
//           id: Date.now(),
//           timestamp: new Date().toISOString()
//         };
//         messageHistory.push(fullMessage);
//         if (messageHistory.length > 100) messageHistory.shift();
//         broadcastExcept(ws, fullMessage);
//         break;

//       case 'clear-messages':
//         console.log(`[MESSAGE] Clear requested by ${data.by}`);
//         broadcastAll({
//           type: 'message-cleared',
//           by: data.by,
//           messageId: Date.now()
//         });
//         break;

//       case 'clear_confirmation':
//         broadcastToDesktop({
//           type: 'message_cleared',
//           by: data.device,
//           timestamp: new Date().toISOString()
//         });
//         break;

//       // ==== WEBRTC SIGNALING ====
//       case 'offer':
//       case 'webrtc-offer':
//         console.log(`[WEBRTC] Offer from ${from || 'unknown'} to ${to}`);
//         broadcastToTarget({
//           type: 'offer',
//           sdp: data.sdp,
//           from,
//           to
//         }, ws);
//         break;

//       case 'answer':
//       case 'webrtc-answer':
//         console.log(`[WEBRTC] Answer from ${from || 'unknown'} to ${to}`);
//         broadcastToTarget({
//           type: 'answer',
//           sdp: data.sdp,
//           from,
//           to
//         }, ws);
//         break;

//       case 'ice-candidate':
//         console.log(`[WEBRTC] ICE candidate from ${from || 'unknown'} to ${to}`);
//         broadcastToTarget({
//           type: 'ice-candidate',
//           candidate: data.candidate,
//           from,
//           to
//         }, ws);
//         break;

//       // ===========================
//       case 'control-command':
//       case 'control_command':
//         console.log(`[CONTROL] Command "${data.command}" from ${from}`);
//         broadcastAll({
//           type: 'control-command',
//           command: data.command,
//           from
//         });
//         break;

//       case 'status_report':
//         console.log(`[STATUS] Report from ${from}:`, data.status);
//         broadcastToDesktop({
//           type: 'status_report',
//           from,
//           status: data.status,
//           timestamp: new Date().toISOString()
//         });
//         break;

//       default:
//         console.warn(`[WS WARNING] Unknown type received: ${type}`);
//     }
//   });

//   ws.on('close', () => {
//     clients.delete(ws);
//     console.log(`[DISCONNECTED] ${ws.deviceName || 'Unknown'} (${ws.xrId || 'no-id'})`);
//     broadcastDeviceList();
//     logCurrentDevices();
//   });
// });

// // ==== Broadcast helpers ====
// function broadcastAll(data) {
//   const msg = JSON.stringify(data);
//   clients.forEach(c => {
//     if (c.readyState === WebSocket.OPEN) c.send(msg);
//   });
// }

// function broadcastExcept(sender, data) {
//   const msg = JSON.stringify(data);
//   clients.forEach(c => {
//     if (c !== sender && c.readyState === WebSocket.OPEN) c.send(msg);
//   });
// }

// function broadcastToDesktop(data) {
//   const msg = JSON.stringify(data);
//   clients.forEach(c => {
//     if (
//       (c.deviceName === 'Desktop App' || c.deviceName === 'Desktop' || c.xrId === 'XR-1238')
//       && c.readyState === WebSocket.OPEN
//     ) {
//       c.send(msg);
//     }
//   });
// }

// function broadcastToTarget(data, sender) {
//   if (data.to) {
//     let sent = false;
//     clients.forEach(c => {
//       if (
//         (c.xrId === data.to || c.deviceName === data.to)
//         && c.readyState === WebSocket.OPEN
//         && c !== sender
//       ) {
//         c.send(JSON.stringify(data));
//         sent = true;
//       }
//     });
//     if (!sent) {
//       console.warn(`[WS WARNING] No client found for target: ${data.to}`);
//     }
//   } else {
//     broadcastExcept(sender, data);
//   }
// }

// function broadcastDeviceList() {
//   const deviceList = Array.from(clients)
//     .filter(c => c.deviceName)
//     .map(c => ({ name: c.deviceName, xrId: c.xrId }));

//   const msg = JSON.stringify({ type: 'device_list', devices: deviceList });

//   clients.forEach(c => {
//     if (c.readyState === WebSocket.OPEN) c.send(msg);
//   });
// }

// // ---- Extra: Log all connected clients with XR IDs and Names ----
// function logCurrentDevices() {
//   const deviceList = Array.from(clients)
//     .filter(c => c.deviceName)
//     .map(c => `${c.deviceName} (${c.xrId || 'no-id'})`);
//   console.log(`[DEVICES] Currently connected:`);
//   deviceList.length === 0
//     ? console.log('   (none)')
//     : deviceList.forEach(d => console.log(`   - ${d}`));
// }

// // --- Heartbeat ping every 30s ---
// const interval = setInterval(() => {
//   wss.clients.forEach(ws => {
//     if (ws.isAlive === false) {
//       console.log(`[HEARTBEAT] Terminating dead client: ${ws.deviceName || 'Unknown'} (${ws.xrId || 'no-id'})`);
//       return ws.terminate();
//     }
//     ws.isAlive = false;
//     ws.ping();
//   });
// }, 30000);

// // --- Graceful shutdown ---
// process.on('SIGINT', shutdown);
// process.on('SIGTERM', shutdown);

// function shutdown() {
//   console.log('[SERVER] Graceful shutdown initiated...');
//   clearInterval(interval);
//   wss.close(() => console.log('[SERVER] WebSocket server closed.'));
//   server.close(() => {
//     console.log('[SERVER] HTTP server closed.');
//     process.exit(0);
//   });
// }

// process.on('uncaughtException', (err) => {
//   console.error('[FATAL ERROR] Uncaught exception occurred:', err);
// });
// =======================================================================================================================================================================

// -------------------------------------------------one to one -----------------------------------------------------------------------------------------

// const express = require('express');
// const path = require('path');
// const WebSocket = require('ws');
// const fs = require('fs');
// require('dotenv').config();

// const PORT = process.env.PORT || 8080;
// const app = express();

// const staticPaths = [
//   path.join(__dirname, 'public'),
//   path.join(__dirname, '../frontend')
// ];

// let staticPathFound = null;
// staticPaths.forEach(possiblePath => {
//   if (fs.existsSync(possiblePath)) {
//     app.use(express.static(possiblePath));
//     console.log(`[STATIC] Serving static files from ${possiblePath}`);
//     if (!staticPathFound) staticPathFound = possiblePath;
//   }
// });
// if (!staticPathFound) {
//   console.error('ERROR: No static files directory found! Tried:', staticPaths);
// }

// function injectTurnConfig(html) {
//   const turnConfigScript = `
//     <script>
//       window.TURN_CONFIG = {
//         urls: '${process.env.TURN_URL}',
//         username: '${process.env.TURN_USERNAME}',
//         credential: '${process.env.TURN_CREDENTIAL}'
//       };
//     </script>
//   `;
//   return html.replace('</body>', `${turnConfigScript}\n</body>`);
// }

// app.get('/health', (req, res) => {
//   res.status(200).json({
//     status: 'healthy',
//     timestamp: new Date().toISOString(),
//     websocketClients: wss?.clients?.size || 0
//   });
// });

// app.get('/', (req, res) => {
//   if (!staticPathFound) return res.status(404).send('Static files not found');
//   let html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
//   res.send(injectTurnConfig(html));
// });

// app.get('*', (req, res) => {
//   if (staticPathFound) {
//     let html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
//     res.send(injectTurnConfig(html));
//   } else {
//     res.status(404).send('Static files not found');
//   }
// });

// const server = app.listen(PORT, '0.0.0.0', () => {
//   console.log(`[HTTP+WS] Server running on http://0.0.0.0:${PORT}`);
// });

// const wss = new WebSocket.Server({ server });
// const clients = new Set();
// const desktopClients = new Map(); // NEW: Track desktop clients by xrId
// const messageHistory = [];

// const heartbeat = (ws) => { ws.isAlive = true; };

// wss.on('connection', (ws) => {
//   clients.add(ws);
//   ws.isAlive = true;

//   console.log('\n[WS] New client connected (pending identification)...');
//   logCurrentDevices();

//   ws.on('pong', () => heartbeat(ws));
//   ws.on('error', (error) => console.error('[WS ERROR]', error));

//   if (messageHistory.length > 0) {
//     ws.send(JSON.stringify({
//       type: 'message_history',
//       messages: messageHistory.slice(-10),
//     }));
//   }

//   ws.on('message', (message) => {
//     console.log('[WS] Received:', message.toString());

//     let data;
//     try {
//       data = JSON.parse(message);
//     } catch {
//       console.warn('[WS WARNING] Invalid JSON:', message.toString());
//       return;
//     }

//     if (!data || typeof data !== 'object' || !data.type) {
//       console.warn('[WS WARNING] Malformed message object:', data);
//       return;
//     }

//     const { type, from, to, deviceName, xrId } = data;

//     switch (type) {
//       case 'identification':
//         ws.deviceName = deviceName || 'Unknown';
//         ws.xrId = xrId || null;

//         // === NEW: Enforce 1:1 Desktop Connection ===
//         if (ws.deviceName.startsWith('Desktop') || ws.xrId === 'XR-1238') {
//           if (desktopClients.has(ws.xrId)) {
//             console.log(`[BLOCKED] Duplicate desktop tab for ${ws.xrId}`);
//             ws.send(JSON.stringify({
//               type: 'error',
//               message: 'Duplicate desktop tab. Only one allowed.'
//             }));
//             ws.close();
//             return;
//           }
//           desktopClients.set(ws.xrId, ws);
//         }

//         console.log(`[IDENTIFIED] ${ws.deviceName} (${ws.xrId || 'no-id'}) just connected.`);
//         broadcastDeviceList();
//         logCurrentDevices();
//         break;

//       case 'message':
//         const fullMessage = {
//           ...data,
//           id: Date.now(),
//           timestamp: new Date().toISOString()
//         };
//         messageHistory.push(fullMessage);
//         if (messageHistory.length > 100) messageHistory.shift();
//         broadcastExcept(ws, fullMessage);
//         break;

//       case 'clear-messages':
//         console.log(`[MESSAGE] Clear requested by ${data.by}`);
//         broadcastAll({
//           type: 'message-cleared',
//           by: data.by,
//           messageId: Date.now()
//         });
//         break;

//       case 'clear_confirmation':
//         broadcastToDesktop({
//           type: 'message_cleared',
//           by: data.device,
//           timestamp: new Date().toISOString()
//         });
//         break;

//       case 'offer':
//       case 'webrtc-offer':
//         console.log(`[WEBRTC] Offer from ${from || 'unknown'} to ${to}`);
//         broadcastToTarget({ type: 'offer', sdp: data.sdp, from, to }, ws);
//         break;

//       case 'answer':
//       case 'webrtc-answer':
//         console.log(`[WEBRTC] Answer from ${from || 'unknown'} to ${to}`);
//         broadcastToTarget({ type: 'answer', sdp: data.sdp, from, to }, ws);
//         break;

//       case 'ice-candidate':
//         console.log(`[WEBRTC] ICE candidate from ${from || 'unknown'} to ${to}`);
//         broadcastToTarget({ type: 'ice-candidate', candidate: data.candidate, from, to }, ws);
//         break;

//       case 'control-command':
//       case 'control_command':
//         console.log(`[CONTROL] Command "${data.command}" from ${from}`);
//         broadcastAll({ type: 'control-command', command: data.command, from });
//         break;

//       case 'status_report':
//         console.log(`[STATUS] Report from ${from}:`, data.status);
//         broadcastToDesktop({
//           type: 'status_report',
//           from,
//           status: data.status,
//           timestamp: new Date().toISOString()
//         });
//         break;

//       default:
//         console.warn(`[WS WARNING] Unknown type received: ${type}`);
//     }
//   });

//   ws.on('close', () => {
//     clients.delete(ws);
//     if (ws.xrId && desktopClients.get(ws.xrId) === ws) {
//       desktopClients.delete(ws.xrId); // Remove desktop mapping
//     }
//     console.log(`[DISCONNECTED] ${ws.deviceName || 'Unknown'} (${ws.xrId || 'no-id'})`);
//     broadcastDeviceList();
//     logCurrentDevices();
//   });
// });

// // ==== Broadcast helpers remain unchanged ====
// function broadcastAll(data) {
//   const msg = JSON.stringify(data);
//   clients.forEach(c => {
//     if (c.readyState === WebSocket.OPEN) c.send(msg);
//   });
// }

// function broadcastExcept(sender, data) {
//   const msg = JSON.stringify(data);
//   clients.forEach(c => {
//     if (c !== sender && c.readyState === WebSocket.OPEN) c.send(msg);
//   });
// }

// function broadcastToDesktop(data) {
//   const msg = JSON.stringify(data);
//   clients.forEach(c => {
//     if (
//       (c.deviceName === 'Desktop App' || c.deviceName === 'Desktop' || c.xrId === 'XR-1238')
//       && c.readyState === WebSocket.OPEN
//     ) {
//       c.send(msg);
//     }
//   });
// }

// function broadcastToTarget(data, sender) {
//   if (data.to) {
//     let sent = false;
//     clients.forEach(c => {
//       if (
//         (c.xrId === data.to || c.deviceName === data.to)
//         && c.readyState === WebSocket.OPEN
//         && c !== sender
//       ) {
//         c.send(JSON.stringify(data));
//         sent = true;
//       }
//     });
//     if (!sent) {
//       console.warn(`[WS WARNING] No client found for target: ${data.to}`);
//     }
//   } else {
//     broadcastExcept(sender, data);
//   }
// }

// function broadcastDeviceList() {
//   const deviceList = Array.from(clients)
//     .filter(c => c.deviceName)
//     .map(c => ({ name: c.deviceName, xrId: c.xrId }));

//   const msg = JSON.stringify({ type: 'device_list', devices: deviceList });

//   clients.forEach(c => {
//     if (c.readyState === WebSocket.OPEN) c.send(msg);
//   });
// }

// function logCurrentDevices() {
//   const deviceList = Array.from(clients)
//     .filter(c => c.deviceName)
//     .map(c => `${c.deviceName} (${c.xrId || 'no-id'})`);
//   console.log(`[DEVICES] Currently connected:`);
//   deviceList.length === 0
//     ? console.log('   (none)')
//     : deviceList.forEach(d => console.log(`   - ${d}`));
// }

// const interval = setInterval(() => {
//   wss.clients.forEach(ws => {
//     if (ws.isAlive === false) {
//       console.log(`[HEARTBEAT] Terminating dead client: ${ws.deviceName || 'Unknown'} (${ws.xrId || 'no-id'})`);
//       return ws.terminate();
//     }
//     ws.isAlive = false;
//     ws.ping();
//   });
// }, 30000);

// process.on('SIGINT', shutdown);
// process.on('SIGTERM', shutdown);

// function shutdown() {
//   console.log('[SERVER] Graceful shutdown initiated...');
//   clearInterval(interval);
//   wss.close(() => console.log('[SERVER] WebSocket server closed.'));
//   server.close(() => {
//     console.log('[SERVER] HTTP server closed.');
//     process.exit(0);
//   });
// }

// process.on('uncaughtException', (err) => {
//   console.error('[FATAL ERROR] Uncaught exception occurred:', err);
// });


//--------------------------------------------------------------------deep seek------------------------------------------------------------------------

// const express = require('express');
// const path = require('path');
// const WebSocket = require('ws');
// const fs = require('fs');
// require('dotenv').config();

// const PORT = process.env.PORT || 8080;
// const app = express();

// const staticPaths = [
//   path.join(__dirname, 'public'),
//   path.join(__dirname, '../frontend')
// ];

// let staticPathFound = null;
// staticPaths.forEach(possiblePath => {
//   if (fs.existsSync(possiblePath)) {
//     app.use(express.static(possiblePath));
//     console.log(`[STATIC] Serving static files from ${possiblePath}`);
//     if (!staticPathFound) staticPathFound = possiblePath;
//   }
// });
// if (!staticPathFound) {
//   console.error('ERROR: No static files directory found! Tried:', staticPaths);
// }

// function injectTurnConfig(html) {
//   const turnConfigScript = `
//     <script>
//       window.TURN_CONFIG = {
//         urls: '${process.env.TURN_URL}',
//         username: '${process.env.TURN_USERNAME}',
//         credential: '${process.env.TURN_CREDENTIAL}'
//       };
//     </script>
//   `;
//   return html.replace('</body>', `${turnConfigScript}\n</body>`);
// }

// app.get('/health', (req, res) => {
//   res.status(200).json({
//     status: 'healthy',
//     timestamp: new Date().toISOString(),
//     websocketClients: wss?.clients?.size || 0
//   });
// });

// app.get('/', (req, res) => {
//   if (!staticPathFound) return res.status(404).send('Static files not found');
//   let html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
//   res.send(injectTurnConfig(html));
// });

// app.get('*', (req, res) => {
//   if (staticPathFound) {
//     let html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
//     res.send(injectTurnConfig(html));
//   } else {
//     res.status(404).send('Static files not found');
//   }
// });

// const server = app.listen(PORT, '0.0.0.0', () => {
//   console.log(`[HTTP+WS] Server running on http://0.0.0.0:${PORT}`);
// });

// const wss = new WebSocket.Server({ server });
// const clients = new Set();
// const desktopClients = new Map();
// const messageHistory = [];

// const heartbeat = (ws) => { ws.isAlive = true; };

// wss.on('connection', (ws) => {
//   clients.add(ws);
//   ws.isAlive = true;

//   console.log('\n[WS] New client connected (pending identification)...');
//   logCurrentDevices();

//   ws.on('pong', () => heartbeat(ws));
//   ws.on('error', (error) => console.error('[WS ERROR]', error));

//   if (messageHistory.length > 0) {
//     ws.send(JSON.stringify({
//       type: 'message_history',
//       messages: messageHistory.slice(-10),
//     }));
//   }

//   ws.on('message', (message) => {
//     console.log('[WS] Received:', message.toString());

//     let data;
//     try {
//       data = JSON.parse(message);
//     } catch {
//       console.warn('[WS WARNING] Invalid JSON:', message.toString());
//       return;
//     }

//     if (!data || typeof data !== 'object' || !data.type) {
//       console.warn('[WS WARNING] Malformed message object:', data);
//       return;
//     }

//     const { type, from, to, deviceName, xrId } = data;

//     switch (type) {
//       case 'identification':
//         ws.deviceName = deviceName || 'Unknown';
//         ws.xrId = xrId || null;

//         // Enhanced desktop client tracking
//         if (ws.deviceName.toLowerCase().includes('desktop') || ws.xrId === 'XR-1238') {
//           console.log(`[DESKTOP] Registering desktop client: ${ws.xrId}`);
//           if (desktopClients.has(ws.xrId)) {
//             console.log(`[BLOCKED] Duplicate desktop tab for ${ws.xrId}`);
//             ws.send(JSON.stringify({
//               type: 'error',
//               message: 'Duplicate desktop tab. Only one allowed.'
//             }));
//             ws.close();
//             return;
//           }
//           desktopClients.set(ws.xrId, ws);
//         }

//         console.log(`[IDENTIFIED] ${ws.deviceName} (${ws.xrId || 'no-id'}) just connected.`);
//         broadcastDeviceList();
//         logCurrentDevices();
//         break;

//       case 'setXrId':
//         ws.xrId = data.xrId;
//         console.log(`[XR-ID] Client registered as XR ID: ${data.xrId}`);
//         if (ws.deviceName && ws.deviceName.toLowerCase().includes('desktop')) {
//           desktopClients.set(data.xrId, ws);
//         }
//         broadcastDeviceList();
//         break;

//       case 'message':
//         const fullMessage = {
//           ...data,
//           id: Date.now(),
//           timestamp: new Date().toISOString()
//         };
//         messageHistory.push(fullMessage);
//         if (messageHistory.length > 100) messageHistory.shift();
//         broadcastExcept(ws, fullMessage);
//         break;

//       case 'clear-messages':
//         console.log(`[MESSAGE] Clear requested by ${data.by}`);
//         broadcastAll({
//           type: 'message-cleared',
//           by: data.by,
//           messageId: Date.now()
//         });
//         break;

//       case 'clear_confirmation':
//         broadcastToDesktop({
//           type: 'message_cleared',
//           by: data.device,
//           timestamp: new Date().toISOString()
//         });
//         break;

//       case 'offer':
//       case 'webrtc-offer':
//         console.log(`[WEBRTC] Offer from ${from || 'unknown'} to ${to}`);
//         broadcastToTarget({ type: 'offer', sdp: data.sdp, from, to }, ws);
//         break;

//       case 'answer':
//       case 'webrtc-answer':
//         console.log(`[WEBRTC] Answer from ${from || 'unknown'} to ${to}`);
//         broadcastToTarget({ type: 'answer', sdp: data.sdp, from, to }, ws);
//         break;

//       case 'ice-candidate':
//         console.log(`[WEBRTC] ICE candidate from ${from || 'unknown'} to ${to}`);
//         broadcastToTarget({ type: 'ice-candidate', candidate: data.candidate, from, to }, ws);
//         break;

//       case 'control-command':
//       case 'control_command':
//         console.log(`[CONTROL] Command "${data.command}" from ${from}`);
//         broadcastAll({ type: 'control-command', command: data.command, from });
//         break;

//       case 'status_report':
//         console.log(`[STATUS] Report from ${from}:`, data.status);
//         broadcastToDesktop({
//           type: 'status_report',
//           from,
//           status: data.status,
//           timestamp: new Date().toISOString()
//         });
//         break;

//       case 'ping':
//         // Respond to ping for connection health checks
//         ws.send(JSON.stringify({ type: 'pong' }));
//         break;

//       default:
//         console.warn(`[WS WARNING] Unknown type received: ${type}`);
//     }
//   });

//   ws.on('close', () => {
//     clients.delete(ws);
//     if (ws.xrId && desktopClients.get(ws.xrId) === ws) {
//       console.log(`[DESKTOP] Removing desktop client: ${ws.xrId}`);
//       desktopClients.delete(ws.xrId);
//     }
//     console.log(`[DISCONNECTED] ${ws.deviceName || 'Unknown'} (${ws.xrId || 'no-id'})`);
//     broadcastDeviceList();
//     logCurrentDevices();
//   });
// });

// // Broadcast helpers
// function broadcastAll(data) {
//   const msg = JSON.stringify(data);
//   clients.forEach(c => {
//     if (c.readyState === WebSocket.OPEN) c.send(msg);
//   });
// }

// function broadcastExcept(sender, data) {
//   const msg = JSON.stringify(data);
//   clients.forEach(c => {
//     if (c !== sender && c.readyState === WebSocket.OPEN) c.send(msg);
//   });
// }

// function broadcastToDesktop(data) {
//   const msg = JSON.stringify(data);
//   clients.forEach(c => {
//     if (
//       (c.deviceName && c.deviceName.toLowerCase().includes('desktop')) ||
//       c.xrId === 'XR-1238'
//     ) {
//       if (c.readyState === WebSocket.OPEN) {
//         c.send(msg);
//       }
//     }
//   });
// }

// function broadcastToTarget(data, sender) {
//   if (data.to) {
//     let sent = false;
//     clients.forEach(c => {
//       if (
//         (c.xrId === data.to || c.deviceName === data.to) &&
//         c.readyState === WebSocket.OPEN &&
//         c !== sender
//       ) {
//         c.send(JSON.stringify(data));
//         sent = true;
//       }
//     });
//     if (!sent) {
//       console.warn(`[WS WARNING] No client found for target: ${data.to}`);
//     }
//   } else {
//     broadcastExcept(sender, data);
//   }
// }

// function broadcastDeviceList() {
//   const deviceList = Array.from(clients)
//     .filter(c => c.deviceName)
//     .map(c => ({ name: c.deviceName, xrId: c.xrId }));

//   const msg = JSON.stringify({ type: 'device_list', devices: deviceList });

//   clients.forEach(c => {
//     if (c.readyState === WebSocket.OPEN) c.send(msg);
//   });
// }

// function logCurrentDevices() {
//   const deviceList = Array.from(clients)
//     .filter(c => c.deviceName)
//     .map(c => `${c.deviceName} (${c.xrId || 'no-id'})`);
//   console.log(`[DEVICES] Currently connected:`);
//   deviceList.length === 0
//     ? console.log('   (none)')
//     : deviceList.forEach(d => console.log(`   - ${d}`));
// }

// const interval = setInterval(() => {
//   wss.clients.forEach(ws => {
//     if (ws.isAlive === false) {
//       console.log(`[HEARTBEAT] Terminating dead client: ${ws.deviceName || 'Unknown'} (${ws.xrId || 'no-id'})`);
//       return ws.terminate();
//     }
//     ws.isAlive = false;
//     ws.ping();
//   });
// }, 30000);

// process.on('SIGINT', shutdown);
// process.on('SIGTERM', shutdown);

// function shutdown() {
//   console.log('[SERVER] Graceful shutdown initiated...');
//   clearInterval(interval);
//   wss.close(() => console.log('[SERVER] WebSocket server closed.'));
//   server.close(() => {
//     console.log('[SERVER] HTTP server closed.');
//     process.exit(0);
//   });
// }

// process.on('uncaughtException', (err) => {
//   console.error('[FATAL ERROR] Uncaught exception occurred:', err);
// }); 

//------------------------------------------------------------deep seeek version 2----------------------------------------------------------------------------

const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');
require('dotenv').config();

const PORT = process.env.PORT || 8080;
const app = express();

const staticPaths = [
  path.join(__dirname, 'public'),
  path.join(__dirname, '../frontend')
];

let staticPathFound = null;
staticPaths.forEach(possiblePath => {
  if (fs.existsSync(possiblePath)) {
    app.use(express.static(possiblePath));
    console.log(`[STATIC] Serving static files from ${possiblePath}`);
    if (!staticPathFound) staticPathFound = possiblePath;
  }
});
if (!staticPathFound) {
  console.error('ERROR: No static files directory found! Tried:', staticPaths);
}

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

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    websocketClients: wss?.clients?.size || 0
  });
});

app.get('/', (req, res) => {
  if (!staticPathFound) return res.status(404).send('Static files not found');
  let html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
  res.send(injectTurnConfig(html));
});

app.get('*', (req, res) => {
  if (staticPathFound) {
    let html = fs.readFileSync(path.join(staticPathFound, 'index.html'), 'utf8');
    res.send(injectTurnConfig(html));
  } else {
    res.status(404).send('Static files not found');
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP+WS] Server running on http://0.0.0.0:${PORT}`);
});

const wss = new WebSocket.Server({ server });
const clients = new Map(); // Changed from Set to Map for better client management
const desktopClients = new Map();
const messageHistory = [];

const heartbeat = (ws) => { ws.isAlive = true; };

wss.on('connection', (ws) => {
  ws.isAlive = true;
  console.log('\n[WS] New client connected (pending identification)...');
  logCurrentDevices();

  ws.on('pong', () => heartbeat(ws));
  ws.on('error', (error) => console.error('[WS ERROR]', error));

  // Send recent message history
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
      console.warn('[WS WARNING] Invalid JSON:', message.toString());
      return;
    }

    if (!data || typeof data !== 'object' || !data.type) {
      console.warn('[WS WARNING] Malformed message object:', data);
      return;
    }

    const { type, from, to, deviceName, xrId } = data;

    switch (type) {
      case 'identification':
        ws.deviceName = deviceName || 'Unknown';
        ws.xrId = xrId || null;

        // Replace existing client if needed
        if (xrId) {
          const existingClient = clients.get(xrId);
          if (existingClient && existingClient !== ws) {
            console.log(`[REPLACE] Closing existing client for ${xrId}`);
            try {
              existingClient.close();
            } catch (e) {
              console.warn(`[REPLACE] Error closing old client: ${e.message}`);
            }
          }
          clients.set(xrId, ws);
        }

        // Handle desktop registration
        if (ws.deviceName.toLowerCase().includes('desktop') || xrId === 'XR-1238') {
          if (desktopClients.has(xrId)) {
            console.log(`[BLOCKED] Duplicate desktop tab for ${xrId}`);
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Duplicate desktop tab. Only one allowed.'
            }));
            ws.close();
            return;
          }
          console.log(`[DESKTOP] Registering desktop client: ${xrId}`);
          desktopClients.set(xrId, ws);
        }

        console.log(`[IDENTIFIED] ${ws.deviceName} (${xrId || 'no-id'}) just connected.`);
        broadcastDeviceList();
        logCurrentDevices();
        break;

      case 'setXrId':
        ws.xrId = data.xrId;
        console.log(`[XR-ID] Client registered as XR ID: ${data.xrId}`);

        if (ws.deviceName && ws.deviceName.toLowerCase().includes('desktop')) {
          desktopClients.set(data.xrId, ws);
        }

        clients.set(data.xrId, ws);
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
        console.log(`[MESSAGE] Clear requested by ${data.by}`);
        broadcastAll({
          type: 'message-cleared',
          by: data.by,
          messageId: Date.now()
        });
        break;

      case 'clear_confirmation':
        broadcastToDesktop({
          type: 'message_cleared',
          by: data.device,
          timestamp: new Date().toISOString()
        });
        break;

      case 'offer':
      case 'webrtc-offer':
        console.log(`[WEBRTC] Offer from ${from || 'unknown'} to ${to}`);
        broadcastToTarget({ type: 'offer', sdp: data.sdp, from, to }, ws);
        break;

      case 'answer':
      case 'webrtc-answer':
        console.log(`[WEBRTC] Answer from ${from || 'unknown'} to ${to}`);
        broadcastToTarget({ type: 'answer', sdp: data.sdp, from, to }, ws);
        break;

      case 'ice-candidate':
        console.log(`[WEBRTC] ICE candidate from ${from || 'unknown'} to ${to}`);
        broadcastToTarget({ type: 'ice-candidate', candidate: data.candidate, from, to }, ws);
        break;

      case 'control-command':
      case 'control_command':
        console.log(`[CONTROL] Command "${data.command}" from ${from}`);
        broadcastAll({ type: 'control-command', command: data.command, from });
        break;

      case 'status_report':
        console.log(`[STATUS] Report from ${from}:`, data.status);
        broadcastToDesktop({
          type: 'status_report',
          from,
          status: data.status,
          timestamp: new Date().toISOString()
        });
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      default:
        console.warn(`[WS WARNING] Unknown type received: ${type}`);
    }
  });

  ws.on('close', () => {
    console.log(`\n[WS CLOSED] ${ws.deviceName || 'Unknown'} (${ws.xrId || 'no-id'}) disconnected.`);

    if (ws.xrId && clients.get(ws.xrId) === ws) {
      console.log(`[CLIENT] Removing client for ${ws.xrId}`);
      clients.delete(ws.xrId);
    }

    if (ws.xrId && desktopClients.get(ws.xrId) === ws) {
      console.log(`[DESKTOP] Removing desktop client for ${ws.xrId}`);
      desktopClients.delete(ws.xrId);
    }

    broadcastDeviceList();
    logCurrentDevices();
  });
});

// Broadcast helpers
function broadcastAll(data) {
  const msg = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function broadcastExcept(sender, data) {
  const msg = JSON.stringify(data);
  clients.forEach(client => {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function broadcastToDesktop(data) {
  const msg = JSON.stringify(data);
  desktopClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function broadcastToTarget(data, sender) {
  if (data.to) {
    let sent = false;
    clients.forEach(client => {
      if (
        (client.xrId === data.to || client.deviceName === data.to) &&
        client.readyState === WebSocket.OPEN &&
        client !== sender
      ) {
        client.send(JSON.stringify(data));
        sent = true;
      }
    });
    if (!sent) {
      console.warn(`[WS WARNING] No client found for target: ${data.to}`);
    }
  } else {
    broadcastExcept(sender, data);
  }
}

function broadcastDeviceList() {
  const deviceList = Array.from(clients.values())
    .filter(c => c.deviceName)
    .map(c => ({ name: c.deviceName, xrId: c.xrId }));

  const msg = JSON.stringify({ type: 'device_list', devices: deviceList });

  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function logCurrentDevices() {
  const deviceList = Array.from(clients.values())
    .filter(c => c.deviceName)
    .map(c => `${c.deviceName} (${c.xrId || 'no-id'})`);
  console.log(`[DEVICES] Currently connected:`);
  deviceList.length === 0
    ? console.log('   (none)')
    : deviceList.forEach(d => console.log(`   - ${d}`));
}

// Heartbeat monitoring
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      console.log(`[HEARTBEAT] Terminating dead client: ${ws.deviceName || 'Unknown'} (${ws.xrId || 'no-id'})`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Graceful shutdown
function shutdown() {
  console.log('[SERVER] Graceful shutdown initiated...');
  clearInterval(interval);
  wss.close(() => console.log('[SERVER] WebSocket server closed.'));
  server.close(() => {
    console.log('[SERVER] HTTP server closed.');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[FATAL ERROR] Uncaught exception occurred:', err);
});
