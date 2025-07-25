const { app, BrowserWindow, ipcMain } = require('electron');
const WebSocket = require('ws');
const path = require('path');

let mainWindow;
let socket = null;
const SIGNALING_SERVER_URL = 'ws://172.16.101.62:8080'; // <-- Update to your signaling server URL

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  setConnectionStatus('Connecting'); // Initial UI status on startup
  connectToWebSocket();
}

/**
 * Safely send messages to renderer if window and contents exist
 */
function safeSendToRenderer(channel, data) {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.webContents &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send(channel, data);
  }
}

/**
 * Update connection status and send to renderer
 * @param {string} status
 */
function setConnectionStatus(status) {
  console.log(`[STATUS] Connection status: ${status}`);
  safeSendToRenderer('connection-status', status);
}

/**
 * Send JSON message payload over WebSocket if open
 * @param {Object} payload
 * @returns {boolean} success
 */
function sendMessage(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (e) {
      console.error('[WS SEND ERROR]', e);
      return false;
    }
  } else {
    console.warn('[WS SEND] WebSocket not open. Dropping message:', payload);
    return false;
  }
}

/**
 * Remove all socket event listeners
 */
function clearSocketListeners() {
  if (!socket) return;
  socket.removeAllListeners('open');
  socket.removeAllListeners('close');
  socket.removeAllListeners('message');
  socket.removeAllListeners('error');
}

/**
 * Connect to signaling WebSocket with reconnect logic
 */
function connectToWebSocket() {
  if (socket) {
    clearSocketListeners();
    try {
      socket.close();
    } catch {}
    socket = null;
  }

  setConnectionStatus('Connecting');

  socket = new WebSocket(SIGNALING_SERVER_URL);

  socket.on('open', () => {
    console.log('[WS] Connected to signaling server');
    setConnectionStatus('Connected');

    // Identify this client to server
    sendMessage({
      type: 'identification',
      deviceName: 'Desktop App',
      xrId: 'XR-1238',
      platform: 'desktop',
    });
  });

  socket.on('close', () => {
    console.log('[WS] Disconnected. Reconnecting in 3s...');
    setConnectionStatus('Disconnected');
    setTimeout(connectToWebSocket, 3000);
  });

  socket.on('error', (err) => {
    console.error('[WS ERROR]', err);
    setConnectionStatus('Connection Error');
  });

  socket.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      // ---- FULL STRUCTURE LOG ----
      console.log('[WS] Received message:', msg);

      switch (msg.type) {
        case 'device_list':
          safeSendToRenderer('update-devices', msg.devices);

          // Check if Android XR Emulator is connected
          const androidConnected = msg.devices.some(d => d.xrId === 'XR-1234');
          if (androidConnected) {
            setConnectionStatus('Connected');
          } else {
            setConnectionStatus('Disconnected');
          }
          break;

        case 'message': {
          const normalizedMsg = {
            ...msg,
            text: msg.text || msg.data || '',
            priority: msg.priority || (msg.urgent ? 'urgent' : 'normal'),
            timestamp: msg.timestamp || new Date().toLocaleTimeString(),
            isoTimestamp: msg.isoTimestamp || new Date().toISOString(),
          };
          safeSendToRenderer('new-message', normalizedMsg);

          const text = (msg.text || '').toLowerCase();
          if (text.includes('start stream')) {
            console.log('[MAIN] Detected "start stream" text. Sending trigger-start-stream to renderer');
            safeSendToRenderer('trigger-start-stream');
          } else if (text.includes('stop stream')) {
            console.log('[MAIN] Detected "stop stream" text. Sending trigger-stop-stream to renderer');
            safeSendToRenderer('trigger-stop-stream');
          }
          break;
        }

        // === SOLUTION A: SUPPORT BOTH control_command AND control-command ===
        case 'control_command':
        case 'control-command': {
          // Robustly extract the command field
          let command = msg.command;
          // Fallbacks if somehow command is inside data as object
          if (command === undefined && typeof msg.data === 'object' && msg.data !== null) {
            command = msg.data.command;
          } else if (command === undefined && typeof msg.data === 'string') {
            // Try parse if string
            try {
              const dataObj = JSON.parse(msg.data);
              command = dataObj.command;
            } catch {}
          }
          console.log('[MAIN] Received control_command:', command);
          safeSendToRenderer('control-command', {
            command: command,
            from: msg.from || 'unknown',
          });
          if (command === 'start_stream') {
            console.log('[MAIN] Sending trigger-start-stream to renderer');
            safeSendToRenderer('trigger-start-stream');
          } else if (command === 'stop_stream') {
            console.log('[MAIN] Sending trigger-stop-stream to renderer');
            safeSendToRenderer('trigger-stop-stream');
          }
          break;
        }

        case 'offer':
        case 'webrtc-offer':
          console.log('[SIGNAL] Received WebRTC offer');
          safeSendToRenderer('webrtc-offer', {
            type: 'offer',
            sdp: msg.sdp || (msg.offer && msg.offer.sdp),
          });
          break;

        case 'answer':
        case 'webrtc-answer':
          console.log('[SIGNAL] Received WebRTC answer');
          safeSendToRenderer('webrtc-answer', {
            type: 'answer',
            sdp: msg.sdp || (msg.answer && msg.answer.sdp),
          });
          break;

        case 'ice-candidate':
          console.log('[SIGNAL] Received ICE candidate');
          safeSendToRenderer('ice-candidate', {
            candidate: msg.candidate || msg,
            from: msg.from || 'unknown',
          });
          break;

        case 'message_cleared':
          safeSendToRenderer('message-cleared', msg);
          break;

        case 'status_report':
          safeSendToRenderer('status_report', msg);
          break;

        default:
          console.warn('[WS] Unrecognized message type:', msg.type);
          safeSendToRenderer('unknown-message', msg);
      }
    } catch (e) {
      console.error('[WS PARSE ERROR]', e, 'Raw data:', data);
    }
  });
}

// IPC handlers

ipcMain.handle('send-message', (_, message) => {
  const payload = {
    type: 'message',
    text: message.text || '',
    sender: message.sender || 'Desktop',
    xrId: message.xrId || 'XR-1238',
    priority: message.priority || 'normal',
    timestamp: new Date().toLocaleTimeString(),
    isoTimestamp: new Date().toISOString(),
    urgent: message.priority === 'urgent',
    messageId: Date.now(),
  };

  if (sendMessage(payload)) {
    console.log('[IPC] Sent message:', payload);
    return { success: true, messageId: payload.messageId };
  } else {
    return { success: false, error: 'WebSocket not connected or failed to send' };
  }
});

ipcMain.on('webrtc-answer', (_, answer) => {
  if (socket?.readyState === WebSocket.OPEN && answer?.sdp) {
    console.log('[SIGNAL] Sending WebRTC answer');
    sendMessage({
      type: 'answer',
      sdp: answer.sdp,
      from: 'XR-1238',
      to: answer.to || 'XR-1234',
    });
  }
});

ipcMain.on('ice-candidate', (_, candidate) => {
  if (socket?.readyState === WebSocket.OPEN && candidate) {
    console.log('[SIGNAL] Sending ICE candidate');
    sendMessage({
      type: 'ice-candidate',
      candidate: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      },
      from: 'XR-1238',
      to: candidate.to || 'XR-1234',
    });
  }
});

ipcMain.on('open-emulator', () => {
  console.log('[IPC] Open emulator requested');
  // Launch emulator or external URL if needed
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (socket) {
    socket.close();
    socket = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (socket) {
    socket.close();
    socket = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
