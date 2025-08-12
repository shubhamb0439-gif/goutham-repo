// app.js (updated)
// === DOM Elements ===
console.log('[INIT] Initializing DOM elements');
const videoElement = document.getElementById('xrVideo');
const statusElement = document.getElementById('status');
const deviceListElement = document.getElementById('deviceList');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const urgentCheckbox = document.getElementById('urgentCheckbox');
const recentMessagesDiv = document.getElementById('recentMessages');
const messageHistoryDiv = document.getElementById('messageHistory');
const usernameInput = document.getElementById('usernameInput');
const xrIdInput = document.getElementById('xrIdInput');
const muteBadge = document.getElementById('muteBadge');
const videoOverlay = document.getElementById('videoOverlay');
const openEmulatorBtn = document.getElementById('openEmulator');
const clearMessagesBtn = document.getElementById('clearMessagesBtn');

console.log('[INIT] DOM elements initialized:', {
  videoElement, statusElement, deviceListElement, messageInput,
  sendButton, urgentCheckbox, recentMessagesDiv, messageHistoryDiv
});

let socket = null;
let peerConnection = null;
let remoteStream = null;
let clearedMessages = new Set();
let pendingIceCandidates = [];
let isStreamActive = false;
let reconnectTimeout = null;
let heartbeatInterval = null;
let currentRoom = null; // <-- track the room we're joined to (if any)

// CONFIG
console.log('[CONFIG] Loading configuration');
const SERVER_URL = 'https://xr-messaging-geexbheshbghhab7.centralindia-01.azurewebsites.net';
const XR_ID = xrIdInput.value?.trim() || "XR-1238";
const DEVICE_NAME = usernameInput.value?.trim() || "Desktop";
const ANDROID_ID = "XR-1234"; // direct messages/control target (for now)
console.log('[CONFIG] Server URL:', SERVER_URL);
console.log('[CONFIG] XR ID:', XR_ID);
console.log('[CONFIG] Device Name:', DEVICE_NAME);

// --------------------------
// UTILS
// --------------------------
function logFnEntry(fnName, extra = '') {
  console.log(`[ENTER] ${fnName} ${extra}`);
}

// --------------------------
// UI / Status
// --------------------------
function setStatus(status) {
  logFnEntry('setStatus', status);
  try {
    statusElement.textContent = status;
    statusElement.classList.remove('bg-yellow-500', 'bg-green-500', 'bg-red-600');
    switch (status.toLowerCase()) {
      case 'connected':
        console.log('[STATUS] Setting connected state');
        statusElement.classList.add('bg-green-500');
        break;
      case 'connecting':
        console.log('[STATUS] Setting connecting state');
        statusElement.classList.add('bg-yellow-500');
        break;
      case 'disconnected':
        console.log('[STATUS] Setting disconnected state');
        statusElement.classList.add('bg-red-600');
        break;
      default:
        console.log('[STATUS] Setting default (connecting) state');
        statusElement.classList.add('bg-yellow-500');
    }
  } catch (e) {
    console.warn('[STATUS] setStatus error', e);
  }
}

// --------------------------
// Socket.IO connection & handlers
// --------------------------
function connectSocketIO() {
  logFnEntry('connectSocketIO');
  setStatus('Connecting');

  socket = io(SERVER_URL, {
    path: "/socket.io",
    transports: ["websocket"],
    secure: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    autoConnect: true
  });

  // connection established
  socket.on('connect', () => {
    logFnEntry('socket.on(connect)');
    setStatus('Connected');
    console.log('[SOCKET] Emitting identify with:', { deviceName: DEVICE_NAME, xrId: XR_ID });
    socket.emit('identify', { deviceName: DEVICE_NAME, xrId: XR_ID });

    // ask the server to immediately send the current list
    socket.emit('request_device_list');

    // try to pair with the known peer (your one-to-one room)
    // This will trigger server-side validation (allowedPairs or DB)
    pairWith(ANDROID_ID);

    if (reconnectTimeout) {
      console.log('[SOCKET] Clearing reconnect timeout');
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    startHeartbeat();
  });

  socket.on('disconnect', (reason) => {
    logFnEntry('socket.on(disconnect)', reason);
    console.warn('[SOCKET] ❌ Disconnected from server. Reason:', reason);
    setStatus('Disconnected');

    // mark room left locally
    if (currentRoom) {
      console.log('[SOCKET] Marking currentRoom as null due to disconnect', currentRoom);
      currentRoom = null;
    }

    if (reason === 'io server disconnect') {
      console.log('[SOCKET] Server forced disconnect - attempting reconnect');
      setTimeout(() => {
        console.log('[SOCKET] Attempting manual reconnect');
        socket.connect();
      }, 1000);
    }
  });

  socket.on('connect_error', (err) => {
    logFnEntry('socket.on(connect_error)');
    console.error('[SOCKET] 🛑 Connection error:', err?.message || err);
    setStatus('Disconnected');
  });

  socket.on('error', (data) => {
    logFnEntry('socket.on(error)');
    console.log('[SOCKET] error payload:', data);
    if (data?.message?.includes('Duplicate desktop')) {
      console.warn('[SOCKET] 🚫 Duplicate desktop tab detected');
      alert('This desktop session is inactive. Please close other tabs.');
      document.body.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; margin-top: 20%;">
          <h1 style="color: red; text-align: center;">Another tab is already connected.</h1>
          <p style="margin-top: 1rem;">Only one desktop tab can be active at a time.</p>
        </div>`;
      socket.disconnect();
    }
  });

  // custom events
  socket.on('signal', handleSignalMessage);
  socket.on('message', handleChatMessage);
  socket.on('device_list', updateDeviceList);
  socket.on('control', handleControlCommand);
  socket.on('message-cleared', handleMessagesCleared);
  socket.on('message_history', handleMessageHistory);

  // room / pairing events
  socket.on('pair_error', ({ message }) => {
    logFnEntry('socket.on(pair_error)');
    console.warn('[PAIR] pair_error:', message);
    addSystemMessage(`Pair error: ${message}`);
  });

  socket.on('room_joined', ({ roomId, members }) => {
    logFnEntry('socket.on(room_joined)');
    console.log('[PAIR] joined room:', roomId, members);
    currentRoom = roomId;
    addSystemMessage(`Joined room ${roomId} with: ${members.join(', ')}`);
  });

  socket.on('peer_left', ({ xrId, roomId }) => {
    logFnEntry('socket.on(peer_left)');
    console.log('[PAIR] peer_left', xrId, roomId);
    if (currentRoom === roomId) {
      addSystemMessage(`${xrId} left the room.`);
      // keep currentRoom null so we don't try to send signals to a room with one member
      currentRoom = null;
      stopStream();
    }
  });
}

// heartbeat to keep connection alive in some environments
function startHeartbeat() {
  logFnEntry('startHeartbeat');
  if (heartbeatInterval) {
    console.log('[HEARTBEAT] Clearing existing heartbeat interval');
    clearInterval(heartbeatInterval);
  }
  heartbeatInterval = setInterval(() => {
    if (socket?.connected) {
      console.log('[HEARTBEAT] Sending ping to server');
      socket.emit('ping');
    } else {
      console.log('[HEARTBEAT] Socket not connected - skipping ping');
    }
  }, 25000);
}

// --------------------------
// Pairing / Room management (client-side)
// --------------------------
function pairWith(peerId) {
  logFnEntry('pairWith', peerId);
  if (!socket || !socket.connected) {
    console.warn('[PAIR] socket not connected, delaying pairWith call');
    // try again shortly
    setTimeout(() => pairWith(peerId), 500);
    return;
  }
  if (!peerId) {
    console.warn('[PAIR] Missing peerId');
    return;
  }
  console.log('[PAIR] Emitting pair_with for peer:', peerId);
  socket.emit('pair_with', { peerId });
}

// --------------------------
// Signal handlers (client)
// --------------------------
function handleSignalMessage(data) {
  logFnEntry('handleSignalMessage', data?.type || '');
  console.log('[SIGNAL] Received signal message:', data);
  switch (data.type) {
    case 'offer':
      console.log('[WEBRTC] 📞 Received offer from peer');
      // server relays payload as { type, from, data }, pass the SDP object only
      handleOffer(data.data);
      break;
    case 'ice-candidate':
      console.log('[WEBRTC] ❄️ Received ICE candidate from peer');
      handleRemoteIceCandidate(data.data);
      break;
    case 'answer':
      console.log('[WEBRTC]  Received answer from peer');
      handleAnswer(data.data);
      break;
    default:
      console.log('[WEBRTC] Unhandled signal type:', data.type);
  }
}

// --------------------------
// Chat / Messages
// --------------------------
function handleChatMessage(msg) {
  logFnEntry('handleChatMessage');
  console.log('[CHAT] Received chat message:', msg);
  const normalized = normalizeMessage(msg);
  console.log('[CHAT] Normalized message:', normalized);
  addMessageToHistory(normalized);
  addToRecentMessages(normalized);
}

function handleMessagesCleared(data) {
  logFnEntry('handleMessagesCleared');
  if (!clearedMessages.has(data.messageId)) {
    console.log('[CHAT] Messages cleared by', data.by, 'messageId:', data.messageId);
    clearedMessages.add(data.messageId);
    addSystemMessage(`🧹 Messages cleared by ${data.by}`);
    recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
  } else {
    console.log('[CHAT] Already processed clear message for messageId:', data.messageId);
  }
}

function handleMessageHistory(data) {
  logFnEntry('handleMessageHistory');
  console.log('[CHAT] Received message history with', data.messages.length, 'messages');
  data.messages.forEach(msg => {
    const normalized = normalizeMessage(msg);
    addMessageToHistory(normalized);
  });
}

// --------------------------
// WebRTC: PeerConnection creation + handlers
// --------------------------
function createPeerConnection() {
  logFnEntry('createPeerConnection');
  console.log('[WEBRTC] Creating new peer connection');
  stopStream();
  const turnConfig = window.TURN_CONFIG || {};
  console.log('[WEBRTC] TURN config:', turnConfig);

  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ];

  if (turnConfig.urls && turnConfig.username && turnConfig.credential) {
    iceServers.push({ urls: turnConfig.urls, username: turnConfig.username, credential: turnConfig.credential });
    console.log('[WEBRTC] Added TURN server to ICE configuration');
  }

  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });
  console.log('[WEBRTC] Peer connection created with ICE servers:', iceServers);

  pc.ontrack = (event) => {
    logFnEntry('pc.ontrack');
    console.log('[WEBRTC] Received track:', event.track.kind);
    if (!remoteStream) {
      console.log('[WEBRTC] Creating new remote stream');
      remoteStream = new MediaStream();
      videoElement.srcObject = remoteStream;
      videoElement.muted = true;
    }
    if (!remoteStream.getTracks().some(t => t.id === event.track.id)) {
      console.log('[WEBRTC] Adding track to remote stream');
      remoteStream.addTrack(event.track);
    }
    videoElement.play().catch(e => {
      console.warn('[WEBRTC] Video play error:', e);
      showClickToPlayOverlay();
    });
  };

  pc.onicecandidate = (event) => {
    logFnEntry('pc.onicecandidate');
    if (event.candidate) {
      console.log('[WEBRTC] Generated ICE candidate:', event.candidate);
      // prefer room forwarding (omit 'to' when joined)
      const payload = {
        type: 'ice-candidate',
        from: XR_ID,
        data: event.candidate
      };
      if (!currentRoom) {
        // if no room we fall back to direct-to-id behavior for compatibility
        payload.to = ANDROID_ID;
      }
      console.log('[WEBRTC] Emitting signal (ice-candidate) payload:', payload);
      socket?.emit('signal', payload);
    } else {
      console.log('[WEBRTC] ICE gathering complete');
    }
  };

  pc.oniceconnectionstatechange = () => {
    logFnEntry('pc.oniceconnectionstatechange');
    console.log('[WEBRTC] ICE connection state changed:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      console.log('[WEBRTC] ICE connection failed or disconnected - stopping stream');
      stopStream();
    }
  };

  pc.onconnectionstatechange = () => {
    logFnEntry('pc.onconnectionstatechange');
    console.log('[WEBRTC] Connection state changed:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      setStatus('Connected');
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      console.log('[WEBRTC] Connection failed or disconnected - stopping stream');
      stopStream();
      setStatus('Connecting');
    }
  };

  isStreamActive = true;
  return pc;
}

async function handleOffer(offer) {
  logFnEntry('handleOffer');
  console.log('[WEBRTC] Handling offer:', offer);
  stopStream();
  peerConnection = createPeerConnection();

  if (pendingIceCandidates.length > 0) {
    console.log('[WEBRTC] Processing', pendingIceCandidates.length, 'pending ICE candidates');
    for (const cand of pendingIceCandidates) {
      await handleRemoteIceCandidate(cand);
    }
    pendingIceCandidates = [];
  }

  try {
    console.log('[WEBRTC] Setting remote description');
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    console.log('[WEBRTC] Creating answer');
    const answer = await peerConnection.createAnswer();
    console.log('[WEBRTC] Setting local description');
    await peerConnection.setLocalDescription(answer);

    // prefer room forwarding: omit 'to' if currentRoom exists
    const payload = {
      type: 'answer',
      from: XR_ID,
      data: peerConnection.localDescription
    };
    if (!currentRoom) {
      payload.to = ANDROID_ID;
    }
    console.log('[WEBRTC] Emitting signal (answer) payload:', payload);
    socket?.emit('signal', payload);
    console.log('[WEBRTC] Answer sent to peer');
  } catch (err) {
    console.error('[WEBRTC] Error handling offer:', err);
  }
}

async function handleAnswer(answer) {
  logFnEntry('handleAnswer');
  console.log('[WEBRTC] Handling answer:', answer);
  if (!peerConnection) {
    console.warn('[WEBRTC] Received answer but no peerConnection exists');
    return;
  }
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    console.log('[WEBRTC] Remote description (answer) set successfully');
  } catch (err) {
    console.error('[WEBRTC] Error setting remote description (answer):', err);
  }
}

async function handleRemoteIceCandidate(candidate) {
  logFnEntry('handleRemoteIceCandidate');
  console.log('[WEBRTC] Handling remote ICE candidate:', candidate);
  if (peerConnection && candidate && candidate.candidate) {
    try {
      console.log('[WEBRTC] Adding ICE candidate to peer connection');
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('[WEBRTC] Error adding ICE candidate:', err);
    }
  } else if (candidate) {
    console.log('[WEBRTC] Buffering ICE candidate for later');
    pendingIceCandidates.push(candidate);
  }
}

// --------------------------
// Stop / cleanup stream
// --------------------------
function stopStream() {
  logFnEntry('stopStream');
  console.log('[STREAM] Stopping stream');
  isStreamActive = false;
  
  if (videoElement) {
    console.log('[STREAM] Pausing and clearing video element');
    try {
      videoElement.pause();
      videoElement.srcObject = null;
      videoElement.removeAttribute('src');
      videoElement.load();
    } catch (e) {
      console.warn('[STREAM] Video element cleanup error', e);
    }
  }

  if (muteBadge) {
    console.log('[STREAM] Hiding mute badge');
    muteBadge.style.display = 'none';
  }

  if (videoOverlay) {
    console.log('[STREAM] Hiding video overlay');
    videoOverlay.style.display = 'none';
  }

  if (peerConnection) {
    console.log('[STREAM] Closing peer connection');
    try { peerConnection.close(); } catch (e) {
      console.warn('[STREAM] Error closing peer connection:', e);
    }
    peerConnection = null;
  }

  if (remoteStream) {
    console.log('[STREAM] Stopping remote stream tracks');
    try {
      remoteStream.getTracks().forEach(track => { 
        try { track.stop(); } catch (e) {
          console.warn('[STREAM] Error stopping track:', e);
        }
      });
    } catch (e) {
      console.warn('[STREAM] remoteStream cleanup error', e);
    }
    remoteStream = null;
  }

  pendingIceCandidates = [];
  console.log('[STREAM] Stream stopped completely');
}

// --------------------------
// UI helpers
// --------------------------
function showClickToPlayOverlay() {
  logFnEntry('showClickToPlayOverlay');
  console.log('[UI] Showing click-to-play overlay');
  if (!videoOverlay) return;
  videoOverlay.style.display = 'flex';
  videoOverlay.innerHTML = `<button id="clickToPlayBtn" style="padding:1rem 2rem;font-size:1.25rem;">Click to Start Video</button>`;
  document.getElementById('clickToPlayBtn').onclick = () => {
    console.log('[UI] Click-to-play button clicked');
    videoOverlay.style.display = 'none';
    videoElement.play().catch(e => {
      console.warn('[UI] Error playing video after click:', e);
    });
  };
}

// --------------------------
// Devices list UI
// --------------------------
function updateDeviceList(devices) {
  logFnEntry('updateDeviceList');
  if (!Array.isArray(devices)) {
    console.error("Device list is not an array:", devices);
    return;
  }

  console.log('[DEVICES] Updating device list with', devices.length, 'devices');
  deviceListElement.innerHTML = '';
  devices.forEach(device => {
    const name = device.deviceName || device.name || 'Unknown';
    console.log(`[DEVICE] Adding device: ${name} (${device.xrId})`);
    const li = document.createElement('li');
    li.textContent = `${name} (${device.xrId})`;
    deviceListElement.appendChild(li);
  });
}

// --------------------------
// Chat send
// --------------------------
function sendMessage() {
  logFnEntry('sendMessage');
  const text = messageInput.value.trim();
  console.log('[CHAT] Sending message:', text);
  if (!text) {
    console.log('[CHAT] Empty message - not sending');
    return;
  }

  // If we have a room, don't put 'to' because server will forward into the room.
  const message = {
    from: XR_ID,
    text,
    urgent: urgentCheckbox.checked
  };

  if (!currentRoom) {
    // fallback to direct target for backward compat
    message.to = ANDROID_ID;
  }

  console.log('[CHAT] Emitting message to server:', message);
  socket?.emit('message', message);

  addMessageToHistory({
    ...message,
    sender: DEVICE_NAME,
    xrId: XR_ID,
    timestamp: new Date().toLocaleTimeString()
  });
  messageInput.value = '';
}

// --------------------------
// Normalization + rendering helpers
// --------------------------
function normalizeMessage(message) {
  logFnEntry('normalizeMessage');
  return {
    text: message.text || '',
    sender: message.sender || message.from || 'unknown',
    xrId: message.xrId || message.from || 'unknown',
    timestamp: message.timestamp || new Date().toLocaleTimeString(),
    priority: message.urgent || message.priority === 'urgent' ? 'urgent' : 'normal'
  };
}

function addMessageToHistory(message) {
  logFnEntry('addMessageToHistory');
  console.log('[CHAT] Adding message to history:', message);
  const msg = normalizeMessage(message);
  const el = document.createElement('div');
  el.className = `message ${msg.priority}`;
  el.innerHTML = `
    <div class="message-header">
      <div class="sender-info">
        <span class="sender-name">${msg.sender}</span>
        <span class="xr-id">${msg.xrId}</span>
      </div>
      <div class="message-time">${msg.timestamp}</div>
    </div>
    <div class="message-content">${msg.text}</div>
    ${msg.priority === 'urgent' ? '<div class="urgent-badge">URGENT</div>' : ''}
  `;
  messageHistoryDiv.appendChild(el);
  messageHistoryDiv.scrollTop = messageHistoryDiv.scrollHeight;
}

function addToRecentMessages(message) {
  logFnEntry('addToRecentMessages');
  console.log('[CHAT] Adding to recent messages:', message);
  const msg = normalizeMessage(message);
  const el = document.createElement('div');
  el.className = `recent-message ${msg.priority}`;
  el.innerHTML = `
    <div class="recent-message-header">
      <span class="recent-sender">${msg.sender}</span>
      <span class="recent-xr-id">${msg.xrId}</span>
      <span class="recent-time">${msg.timestamp}</span>
    </div>
    <div class="recent-message-content">${msg.text}</div>
  `;
  recentMessagesDiv.prepend(el);
  if (recentMessagesDiv.children.length > 5) {
    console.log('[CHAT] Trimming recent messages to 5');
    recentMessagesDiv.removeChild(recentMessagesDiv.lastChild);
  }
}

function addSystemMessage(text) {
  logFnEntry('addSystemMessage');
  console.log('[CHAT] Adding system message:', text);
  const el = document.createElement('div');
  el.className = 'system-message';
  el.textContent = text;
  messageHistoryDiv.appendChild(el);
  messageHistoryDiv.scrollTop = messageHistoryDiv.scrollHeight;
}

function clearMessages() {
  logFnEntry('clearMessages');
  console.log('[CHAT] Clearing messages');
  socket?.emit('clear-messages', { by: DEVICE_NAME });
  clearedMessages.clear();
  recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
  addSystemMessage(`🧹 Cleared messages locally by ${DEVICE_NAME}`);
}

// --------------------------
// Remote control / commands
// --------------------------
function handleControlCommand(data) {
  logFnEntry('handleControlCommand');
  console.log('[CONTROL] Received control command:', data.command);
  const command = data.command;
  if (!isStreamActive && command !== 'stop_stream') {
    console.log('[CONTROL] Stream not active - ignoring command');
    return;
  }

  switch (command.toLowerCase()) {
    case 'mute':
      console.log('[CONTROL] Executing mute command');
      if (muteBadge) muteBadge.style.display = 'block';
      if (videoElement) videoElement.muted = true;
      break;
    case 'unmute':
      console.log('[CONTROL] Executing unmute command');
      if (muteBadge) muteBadge.style.display = 'none';
      if (videoElement) videoElement.muted = false;
      videoElement.play().catch(()=>{});
      break;
    case 'hide_video':
      console.log('[CONTROL] Executing hide_video command');
      if (videoOverlay) videoOverlay.style.display = 'flex';
      if (videoElement) videoElement.style.visibility = 'hidden';
      break;
    case 'show_video':
      console.log('[CONTROL] Executing show_video command');
      if (videoOverlay) videoOverlay.style.display = 'none';
      if (videoElement) videoElement.style.visibility = 'visible';
      break;
    case 'stop_stream':
      console.log('[CONTROL] Executing stop_stream command');
      stopStream();
      break;
    default:
      console.warn('[CONTROL] Unknown command received:', command);
  }
}

// --------------------------
// Event listeners
// --------------------------
console.log('[INIT] Setting up event listeners');
if (sendButton) sendButton.addEventListener('click', sendMessage);
if (messageInput) {
  messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

if (clearMessagesBtn) {
  clearMessagesBtn.addEventListener('click', clearMessages);
}

if (openEmulatorBtn) {
  openEmulatorBtn.addEventListener('click', () => {
    logFnEntry('openEmulatorBtn.click');
    console.log('[UI] Opening emulator in new window');
    window.open('http://localhost:3000/display.html', '_blank');
  });
}

if (videoOverlay) {
  videoOverlay.addEventListener('click', () => {
    logFnEntry('videoOverlay.click');
    console.log('[UI] Video overlay clicked - attempting to play video');
    videoOverlay.style.display = 'none';
    videoElement.play().catch(e => {
      console.warn('[UI] Error playing video after overlay click:', e);
    });
  });
}

window.addEventListener('load', () => {
  logFnEntry('window.load');
  console.log('[APP] Window loaded - initializing application');
  connectSocketIO();
});

console.log('[INIT] Application initialization complete');
