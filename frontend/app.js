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

// CONFIG
console.log('[CONFIG] Loading configuration');
const SERVER_URL = 'https://xr-messaging-geexbheshbghhab7.centralindia-01.azurewebsites.net';
const XR_ID = xrIdInput.value?.trim() || "XR-1238";
const DEVICE_NAME = usernameInput.value?.trim() || "Desktop";
const ANDROID_ID = "XR-1234"; // direct messages/control target
console.log('[CONFIG] Server URL:', SERVER_URL);
console.log('[CONFIG] XR ID:', XR_ID);
console.log('[CONFIG] Device Name:', DEVICE_NAME);

function setStatus(status) {
  console.log('[STATUS] Updating status to:', status);
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
}

function connectSocketIO() {
  console.log('[SOCKET] Connecting to Socket.IO server:', SERVER_URL);
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


  

  socket.on('connect', () => {
    console.log('[SOCKET] ✅ Successfully connected to server');
    setStatus('Connected');
    console.log('[SOCKET] Emitting identify with:', { deviceName: DEVICE_NAME, xrId: XR_ID });
    socket.emit('identify', {
      deviceName: DEVICE_NAME,
      xrId: XR_ID
    });
    if (reconnectTimeout) {
      console.log('[SOCKET] Clearing reconnect timeout');
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    startHeartbeat();
  });

  socket.on('disconnect', (reason) => {
    console.warn('[SOCKET] ❌ Disconnected from server. Reason:', reason);
    setStatus('Disconnected');
    if (reason === 'io server disconnect') {
      console.log('[SOCKET] Server forced disconnect - attempting reconnect');
      setTimeout(() => {
        console.log('[SOCKET] Attempting manual reconnect');
        socket.connect();
      }, 1000);
    }
  });

  socket.on('connect_error', (err) => {
    console.error('[SOCKET] 🛑 Connection error:', err.message);
    setStatus('Disconnected');
  });

  socket.on('error', (data) => {
    if (data.message?.includes('Duplicate desktop')) {
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

  socket.on('signal', handleSignalMessage);
  socket.on('message', handleChatMessage);
  socket.on('device_list', updateDeviceList);
  socket.on('control', handleControlCommand);
  socket.on('message-cleared', handleMessagesCleared);
  socket.on('message_history', handleMessageHistory);
}

function startHeartbeat() {
  console.log('[HEARTBEAT] Starting heartbeat interval');
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

function handleSignalMessage(data) {
  console.log('[SIGNAL] Received signal message:', data.type);
  switch (data.type) {
    case 'offer':
      console.log('[WEBRTC] 📞 Received offer from peer');
      // Server relays payload as { type, from, data }, pass the SDP object only
      handleOffer(data.data);
      break;
    case 'ice-candidate':
      console.log('[WEBRTC] ❄️ Received ICE candidate from peer');
      handleRemoteIceCandidate(data.data);
      break;
    default:
      console.log('[WEBRTC] Unhandled signal type:', data.type);
  }
}

function handleChatMessage(msg) {
  console.log('[CHAT] Received chat message:', msg);
  const normalized = normalizeMessage(msg);
  console.log('[CHAT] Normalized message:', normalized);
  addMessageToHistory(normalized);
  addToRecentMessages(normalized);
}

function handleMessagesCleared(data) {
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
  console.log('[CHAT] Received message history with', data.messages.length, 'messages');
  data.messages.forEach(msg => {
    const normalized = normalizeMessage(msg);
    addMessageToHistory(normalized);
  });
}

function createPeerConnection() {
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
    if (event.candidate) {
      console.log('[WEBRTC] Generated ICE candidate:', event.candidate);
      socket?.emit('signal', {
        type: 'ice-candidate',
        to: ANDROID_ID,
        from: XR_ID,
        data: event.candidate
      });
    } else {
      console.log('[WEBRTC] ICE gathering complete');
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[WEBRTC] ICE connection state changed:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      console.log('[WEBRTC] ICE connection failed or disconnected - stopping stream');
      stopStream();
    }
  };

  pc.onconnectionstatechange = () => {
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

    socket?.emit('signal', {
      type: 'answer',
      to: ANDROID_ID,
      from: XR_ID,
      data: peerConnection.localDescription
    });
    console.log('[WEBRTC] Answer sent to peer');
  } catch (err) {
    console.error('[WEBRTC] Error handling offer:', err);
  }
}

async function handleRemoteIceCandidate(candidate) {
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

function stopStream() {
  console.log('[STREAM] Stopping stream');
  isStreamActive = false;
  
  if (videoElement) {
    console.log('[STREAM] Pausing and clearing video element');
    videoElement.pause();
    videoElement.srcObject = null;
    videoElement.removeAttribute('src');
    videoElement.load();
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
    remoteStream.getTracks().forEach(track => { 
      try { track.stop(); } catch (e) {
        console.warn('[STREAM] Error stopping track:', e);
      }
    });
    remoteStream = null;
  }

  pendingIceCandidates = [];
  console.log('[STREAM] Stream stopped completely');
}

function showClickToPlayOverlay() {
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

// function updateDeviceList(devices) {
//   if (!Array.isArray(devices)) {
//     console.error("Device list is not an array:", devices);
//     return;
//   }

//   console.log('[DEVICES] Updating device list with', devices.length, 'devices');
//   deviceListElement.innerHTML = '';
//   devices.forEach(device => {
//     // server emits { deviceName, xrId }
//     const name = device.deviceName || device.name || 'Unknown';
//     console.log(`[DEVICE] Adding device: ${name} (${device.xrId})`);
//     const li = document.createElement('li');
//     li.textContent = `${name} (${device.xrId})`;
//     deviceListElement.appendChild(li);
//   });
// }
function updateDeviceList(devices) {
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


function sendMessage() {
  const text = messageInput.value.trim();
  console.log('[CHAT] Sending message:', text);
  if (!text) {
    console.log('[CHAT] Empty message - not sending');
    return;
  }

  const message = {
    from: XR_ID,
    to: ANDROID_ID, // direct to Android
    text,
    urgent: urgentCheckbox.checked
  };

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

function normalizeMessage(message) {
  return {
    text: message.text || '',
    sender: message.sender || message.from || 'unknown',
    xrId: message.xrId || message.from || 'unknown',
    timestamp: message.timestamp || new Date().toLocaleTimeString(),
    priority: message.urgent || message.priority === 'urgent' ? 'urgent' : 'normal'
  };
}

function addMessageToHistory(message) {
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
  console.log('[CHAT] Adding system message:', text);
  const el = document.createElement('div');
  el.className = 'system-message';
  el.textContent = text;
  messageHistoryDiv.appendChild(el);
  messageHistoryDiv.scrollTop = messageHistoryDiv.scrollHeight;
}

function clearMessages() {
  console.log('[CHAT] Clearing messages');
  socket?.emit('clear-messages', { by: DEVICE_NAME });
  clearedMessages.clear();
  recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
  addSystemMessage(`🧹 Cleared messages locally by ${DEVICE_NAME}`);
}

function handleControlCommand(data) {
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

// Event listeners
console.log('[INIT] Setting up event listeners');
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

if (clearMessagesBtn) {
  clearMessagesBtn.addEventListener('click', clearMessages);
}

if (openEmulatorBtn) {
  openEmulatorBtn.addEventListener('click', () => {
    console.log('[UI] Opening emulator in new window');
    window.open('http://localhost:3000/display.html', '_blank');
  });
}

if (videoOverlay) {
  videoOverlay.addEventListener('click', () => {
    console.log('[UI] Video overlay clicked - attempting to play video');
    videoOverlay.style.display = 'none';
    videoElement.play().catch(e => {
      console.warn('[UI] Error playing video after overlay click:', e);
    });
  });
}

window.addEventListener('load', () => {
  console.log('[APP] Window loaded - initializing application');
  connectSocketIO();
});

console.log('[INIT] Application initialization complete');
