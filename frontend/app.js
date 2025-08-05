// // === DOM Elements ===
// const videoElement = document.getElementById('xrVideo');
// const statusElement = document.getElementById('status');
// const deviceListElement = document.getElementById('deviceList');
// const messageInput = document.getElementById('messageInput');
// const sendButton = document.getElementById('sendButton');
// const urgentCheckbox = document.getElementById('urgentCheckbox');
// const recentMessagesDiv = document.getElementById('recentMessages');
// const messageHistoryDiv = document.getElementById('messageHistory');
// const usernameInput = document.getElementById('usernameInput');
// const xrIdInput = document.getElementById('xrIdInput');
// const muteBadge = document.getElementById('muteBadge');
// const videoOverlay = document.getElementById('videoOverlay');
// const openEmulatorBtn = document.getElementById('openEmulator');
// const clearMessagesBtn = document.getElementById('clearMessagesBtn');

// let ws = null;
// let peerConnection = null;
// let remoteStream = null;
// let clearedMessages = new Set();
// let pendingIceCandidates = [];
// let isStreamActive = false;
// let allowAutoPlay = false;
// let reconnectTimeout = null;
// let heartbeatInterval = null;

// // CONFIG
// const SIGNALING_SERVER_URL = 'wss://7ee567fe28d8.ngrok-free.app';
// // const SIGNALING_SERVER_URL = 'wss://xr-messaging-geexbheshbghhab7.centralindia-01.azurewebsites.net';

// function setStatus(status) {
//   console.log('[STATUS] Updated:', status);
//   statusElement.textContent = status;
//   statusElement.classList.remove('bg-yellow-500', 'bg-green-500', 'bg-red-600');
//   switch (status.toLowerCase()) {
//     case 'connected': statusElement.classList.add('bg-green-500'); break;
//     case 'connecting': statusElement.classList.add('bg-yellow-500'); break;
//     case 'disconnected': statusElement.classList.add('bg-red-600'); break;
//     default: statusElement.classList.add('bg-yellow-500');
//   }
// }

// function connectWebSocket() {
//   console.log('[WS] Connecting to:', SIGNALING_SERVER_URL);
//   setStatus('Connecting');
//   ws = new WebSocket(SIGNALING_SERVER_URL);

//   ws.onopen = () => {
//     console.log('[WS] Connected');
//     setStatus('Connected');
//     ws.send(JSON.stringify({
//       type: "identification",
//       xrId: xrIdInput.value || "XR-1238",
//       deviceName: usernameInput.value || "Desktop"
//     }));
//     if (reconnectTimeout) {
//       clearTimeout(reconnectTimeout);
//       reconnectTimeout = null;
//     }
//     startHeartbeat();
//   };

//   ws.onclose = () => {
//     console.warn('[WS] Connection closed');
//     setStatus('Disconnected');
//     if (heartbeatInterval) clearInterval(heartbeatInterval);
//     if (!reconnectTimeout) {
//       reconnectTimeout = setTimeout(connectWebSocket, 1000);
//     }
//   };

//   ws.onerror = (err) => {
//     console.error('[WS] Error occurred:', err);
//     setStatus('Disconnected');
//     try { ws.close(); } catch {}
//   };

//   ws.onmessage = (event) => {
//     console.log('[WS] Message received:', event.data);
//     let data;
//     try { data = JSON.parse(event.data); } catch { data = {}; }
//     handleSocketMessage(data);
//   };
// }

// function startHeartbeat() {
//   if (heartbeatInterval) clearInterval(heartbeatInterval);
//   heartbeatInterval = setInterval(() => {
//     if (ws && ws.readyState === WebSocket.OPEN) {
//       ws.send(JSON.stringify({ type: "ping" }));
//     }
//   }, 25000);
// }

// function handleSocketMessage(data) {
//   if (!data || !data.type) return;
//   console.log('[MSG] Handling type:', data.type);
//   switch (data.type) {
//     case 'offer': handleOffer(data.sdp ? data : data.offer ? data.offer : data); break;
//     case 'ice-candidate': handleRemoteIceCandidate(data.candidate); break;
//     case 'answer': break; // desktop only answers
//     case 'message':
//       const msg = normalizeMessage(data);
//       addMessageToHistory(msg);
//       addToRecentMessages(msg);
//       break;
//     case 'clear-messages':
//       if (!clearedMessages.has(data.messageId)) {
//         clearedMessages.add(data.messageId);
//         addSystemMessage(`🧹 Messages cleared by ${data.by}`);
//         recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
//       }
//       break;
//     case 'device_list': // SERVER now sends snake_case!
//     case 'device-list': // Just in case
//       console.log('[DEVICES] List received:', data.devices);
//       updateDeviceList(data.devices || []);
//       break;
//     case 'control-command':
//       console.log('[CONTROL] Command received:', data.command);
//       handleControlCommand(data.command);
//       break;
//     default:
//       if (data.status) setStatus(data.status);
//   }
// }

// function createPeerConnection() {
//   console.log('[WebRTC] Creating peer connection');
//   stopStream();
//   const turnConfig = window.TURN_CONFIG || {};
//   const iceServers = [
//     { urls: 'stun:stun.l.google.com:19302' },
//     { urls: 'stun:stun1.l.google.com:19302' },
//     { urls: 'stun:stun2.l.google.com:19302' },
//     { urls: 'stun:stun3.l.google.com:19302' },
//     { urls: 'stun:stun4.l.google.com:19302' }
//   ];
//   if (turnConfig.urls && turnConfig.username && turnConfig.credential) {
//     iceServers.push({ urls: turnConfig.urls, username: turnConfig.username, credential: turnConfig.credential });
//     console.log('[WebRTC] Using TURN:', turnConfig);
//   }
//   const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });

//   pc.ontrack = (event) => {
//     console.log('[WebRTC] ontrack:', event.track.kind);
//     if (!remoteStream) {
//       remoteStream = new MediaStream();
//       videoElement.srcObject = remoteStream;
//       videoElement.muted = true;
//     }
//     if (!remoteStream.getTracks().some(t => t.id === event.track.id)) {
//       remoteStream.addTrack(event.track);
//     }
//     videoElement.play().catch(e => {
//       console.warn('[WebRTC] video play error', e);
//       showClickToPlayOverlay();
//     });
//   };

//   pc.onicecandidate = (event) => {
//     if (event.candidate) {
//       console.log('[WebRTC] Local ICE candidate:', event.candidate);
//       ws && ws.send(JSON.stringify({
//         type: 'ice-candidate',
//         to: "XR-1234",
//         from: xrIdInput.value?.trim() || "XR-1238",
//         candidate: event.candidate
//       }));
//     }
//   };

//   pc.oniceconnectionstatechange = () => {
//     console.log('[WebRTC] ICE state:', pc.iceConnectionState);
//     if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') stopStream();
//   };

//   pc.onconnectionstatechange = () => {
//     console.log('[WebRTC] Conn state:', pc.connectionState);
//     if (pc.connectionState === 'connected') setStatus('Connected');
//     else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
//       stopStream();
//       setStatus('Connecting');
//     }
//   };

//   isStreamActive = true;
//   return pc;
// }

// async function handleOffer(offer) {
//   stopStream();
//   peerConnection = createPeerConnection();
//   console.log('[WebRTC] Received offer:', offer);

//   if (pendingIceCandidates.length > 0) {
//     for (const cand of pendingIceCandidates) {
//       await handleRemoteIceCandidate(cand);
//     }
//     pendingIceCandidates = [];
//   }

//   try {
//     // Support both {type, sdp} or full RTCSessionDescription object
//     const remoteDesc = offer.sdp
//       ? { type: offer.type || 'offer', sdp: offer.sdp }
//       : offer;
//     await peerConnection.setRemoteDescription(new RTCSessionDescription(remoteDesc));
//     const answer = await peerConnection.createAnswer();
//     await peerConnection.setLocalDescription(answer);

//     ws && ws.send(JSON.stringify({
//       type: 'answer',
//       to: "XR-1234",
//       from: xrIdInput.value || "XR-1238",
//       sdp: peerConnection.localDescription.sdp
//     }));
//     console.log('[WebRTC] Sent answer');
//   } catch (err) {
//     console.error('[WebRTC] Error handling offer:', err);
//   }
// }

// async function handleRemoteIceCandidate(candidate) {
//   if (peerConnection && candidate && candidate.candidate) {
//     try {
//       await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
//       console.log('[WebRTC] Added ICE candidate:', candidate);
//     } catch (err) {
//       console.error('[WebRTC] Error adding ICE candidate:', err);
//     }
//   } else if (candidate) {
//     pendingIceCandidates.push(candidate);
//     console.log('[WebRTC] ICE candidate buffered:', candidate);
//   }
// }

// function stopStream() {
//   isStreamActive = false;
//   if (videoElement) {
//     videoElement.pause();
//     videoElement.srcObject = null;
//     videoElement.removeAttribute('src');
//     videoElement.load();
//   }
//   if (muteBadge) muteBadge.style.display = 'none';
//   if (videoOverlay) videoOverlay.style.display = 'none';
//   if (peerConnection) {
//     try { peerConnection.close(); } catch {}
//     peerConnection = null;
//   }
//   if (remoteStream) {
//     remoteStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
//     remoteStream = null;
//   }
//   pendingIceCandidates = [];
// }

// // ========== Overlay UI for User Gesture to Play Video ==========
// function showClickToPlayOverlay() {
//   if (!videoOverlay) return;
//   videoOverlay.style.display = 'flex';
//   videoOverlay.innerHTML = `<button id="clickToPlayBtn" style="padding:1rem 2rem;font-size:1.25rem;">Click to Start Video</button>`;
//   document.getElementById('clickToPlayBtn').onclick = () => {
//     videoOverlay.style.display = 'none';
//     videoElement.play();
//   };
// }

// // ========== Device List ==========
// function updateDeviceList(devices) {
//   deviceListElement.innerHTML = '';
//   devices.forEach(device => {
//     // Log devices and XR IDs for clarity
//     console.log(`[DEVICE] DeviceName: ${device.name || device.deviceName || '(no name)'}  XR-ID: ${device.xrId || '(no xrId)'}`);
//     const li = document.createElement('li');
//     li.textContent = `${device.name || device.deviceName || device.xrId} (${device.xrId})`;
//     deviceListElement.appendChild(li);
//   });
// }

// // ========== Messaging/UI Logic ==========
// function sendMessage() {
//   const text = messageInput.value.trim();
//   const sender = usernameInput.value.trim() || 'Desktop';
//   const xrId = xrIdInput.value.trim() || 'XR-1238';
//   const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

//   if (text && ws && ws.readyState === WebSocket.OPEN) {
//     const message = {
//       type: "message",
//       text,
//       sender,
//       xrId,
//       priority: urgentCheckbox.checked ? 'urgent' : 'normal',
//       timestamp
//     };
//     ws.send(JSON.stringify(message));
//     addMessageToHistory(message);
//     // addToRecentMessages(message);
//     messageInput.value = '';
//   }
// }

// // === UPDATED normalizeMessage with stringified JSON support ===
// function normalizeMessage(message) {
//   if (!message || typeof message !== 'object') return {
//     text: String(message),
//     sender: 'unknown',
//     xrId: 'unknown',
//     timestamp: new Date().toLocaleTimeString(),
//     priority: 'normal'
//   };

//   // If message.text looks like a JSON object, parse it!
//   let parsed = {};
//   if (typeof message.text === 'string' && message.text.trim().startsWith('{') && message.text.trim().endsWith('}')) {
//     try {
//       parsed = JSON.parse(message.text);
//     } catch (e) {
//       // Not JSON, leave as is
//     }
//   }

//   // Merge parsed fields, prefer real message fields first
//   const sender = message.sender || parsed.sender || 'unknown';
//   const xrId = message.xrId || parsed.xrId || 'unknown';
//   const text = message.text && typeof message.text === 'string' && parsed.text ? parsed.text : message.text || '';
//   const timestamp = message.timestamp || parsed.timestamp || new Date().toLocaleTimeString();
//   const isUrgent = message.urgent === true ||
//     message.priority === 'urgent' ||
//     parsed.urgent === true ||
//     parsed.priority === 'urgent' ||
//     (message.data && typeof message.data === 'string' &&
//       message.data.includes('"urgent":true'));

//   return {
//     text,
//     sender,
//     xrId,
//     timestamp,
//     priority: isUrgent ? 'urgent' : 'normal'
//   };
// }

// function addMessageToHistory(message) {
//   const msg = normalizeMessage(message);
//   const el = document.createElement('div');
//   el.className = `message ${msg.priority}`;
//   el.innerHTML = `
//     <div class="message-header">
//       <div class="sender-info">
//         <span class="sender-name">${msg.sender}</span>
//         <span class="xr-id">${msg.xrId}</span>
//       </div>
//       <div class="message-time">${msg.timestamp}</div>
//     </div>
//     <div class="message-content">${msg.text}</div>
//     ${msg.priority === 'urgent' ? '<div class="urgent-badge">URGENT</div>' : ''}
//   `;
//   messageHistoryDiv.appendChild(el);
//   messageHistoryDiv.scrollTop = messageHistoryDiv.scrollHeight;
// }

// function addToRecentMessages(message) {
//   const msg = normalizeMessage(message);
//   const el = document.createElement('div');
//   el.className = `recent-message ${msg.priority}`;
//   el.innerHTML = `
//     <div class="recent-message-header">
//       <span class="recent-sender">${msg.sender}</span>
//       <span class="recent-xr-id">${msg.xrId}</span>
//       <span class="recent-time">${msg.timestamp}</span>
//     </div>
//     <div class="recent-message-content">${msg.text}</div>
//   `;
//   recentMessagesDiv.prepend(el);
//   if (recentMessagesDiv.children.length > 5) {
//     recentMessagesDiv.removeChild(recentMessagesDiv.lastChild);
//   }
// }

// function addSystemMessage(text) {
//   const el = document.createElement('div');
//   el.className = 'system-message';
//   el.textContent = text;
//   messageHistoryDiv.appendChild(el);
//   messageHistoryDiv.scrollTop = messageHistoryDiv.scrollHeight;
// }

// function clearMessages() {
//   const by = usernameInput.value.trim() || 'Desktop';
//   if (ws && ws.readyState === WebSocket.OPEN) {
//     ws.send(JSON.stringify({
//       type: 'clear-messages',
//       by
//     }));
//     clearedMessages.clear();
//     recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
//     addSystemMessage(`🧹 Cleared messages locally by ${by}`);
//   }
// }

// // === FINALIZED: Audio Mute/Unmute from ANDROID ===
// function handleControlCommand(command) {
//   if (!isStreamActive && command !== 'stop_stream') return;
//   switch (command && command.toLowerCase && command.toLowerCase()) {
//     case 'mute':
//       if (muteBadge) muteBadge.style.display = 'block';
//       if (videoElement) videoElement.muted = true;
//       break;
//     case 'unmute':
//       if (muteBadge) muteBadge.style.display = 'none';
//       if (videoElement) videoElement.muted = false;
//       videoElement.play().catch(()=>{});
//       break;
//     case 'hide_video':
//       if (videoOverlay) videoOverlay.style.display = 'flex';
//       if (videoElement) videoElement.style.visibility = 'hidden';
//       break;
//     case 'show_video':
//       if (videoOverlay) videoOverlay.style.display = 'none';
//       if (videoElement) videoElement.style.visibility = 'visible';
//       break;
//     case 'stop_stream':
//       console.log('[CONTROL] Stopping stream via command');
//       stopStream();
//       break;
//     default:
//       console.warn('[CONTROL] Unknown command:', command);
//   }
// }

// // Don't change audio tracks, only Android controls mute/unmute
// function setAudioTracksMuted(mute) {
//   // No-op; muting is controlled by Android.
// }

// function checkStreamHealth() {
//   if (!peerConnection || !isStreamActive) return false;
//   const videoTracks = remoteStream?.getVideoTracks() || [];
//   const audioTracks = remoteStream?.getAudioTracks() || [];
//   return videoTracks.length > 0 && audioTracks.length > 0 &&
//     videoTracks.every(t => t.readyState === 'live') &&
//     audioTracks.every(t => t.readyState === 'live');
// }

// // === UI Event Bindings ===
// sendButton.addEventListener('click', sendMessage);
// messageInput.addEventListener('keypress', (e) => {
//   if (e.key === 'Enter' && !e.shiftKey) {
//     e.preventDefault();
//     sendMessage();
//   }
// });
// clearMessagesBtn?.addEventListener('click', clearMessages);
// openEmulatorBtn?.addEventListener('click', () => {
//   window.open('http://localhost:3000/display.html', '_blank');
// });
// if (videoOverlay) {
//   videoOverlay.addEventListener('click', () => {
//     videoOverlay.style.display = 'none';
//     videoElement.play();
//   });
// }


// ===================================================================================================================================

// ---------------------------------------------------one to one------------------------------------------------------------------------------

// === DOM Elements ===
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

let ws = null;
let peerConnection = null;
let remoteStream = null;
let clearedMessages = new Set();
let pendingIceCandidates = [];
let isStreamActive = false;
let allowAutoPlay = false;
let reconnectTimeout = null;
let heartbeatInterval = null;

// CONFIG
const SIGNALING_SERVER_URL = 'wss://914a075c3b07.ngrok-free.app';
// const SIGNALING_SERVER_URL = 'wss://xr-messaging-geexbheshbghhab7.centralindia-01.azurewebsites.net';

function setStatus(status) {
  console.log('[STATUS] Updated:', status);
  statusElement.textContent = status;
  statusElement.classList.remove('bg-yellow-500', 'bg-green-500', 'bg-red-600');
  switch (status.toLowerCase()) {
    case 'connected': statusElement.classList.add('bg-green-500'); break;
    case 'connecting': statusElement.classList.add('bg-yellow-500'); break;
    case 'disconnected': statusElement.classList.add('bg-red-600'); break;
    default: statusElement.classList.add('bg-yellow-500');
  }
}

// function connectWebSocket() {
//   console.log('[WS] Connecting to:', SIGNALING_SERVER_URL);
//   setStatus('Connecting');
//   ws = new WebSocket(SIGNALING_SERVER_URL);

//   ws.onopen = () => {
//     console.log('[WS] Connected');
//     setStatus('Connected');
//     ws.send(JSON.stringify({
//       type: "identification",
//       xrId: xrIdInput.value || "XR-1238",
//       deviceName: usernameInput.value || "Desktop"
//     }));
//     if (reconnectTimeout) {
//       clearTimeout(reconnectTimeout);
//       reconnectTimeout = null;
//     }
//     startHeartbeat();
//   };

//   ws.onclose = () => {
//     console.warn('[WS] Connection closed');
//     setStatus('Disconnected');
//     if (heartbeatInterval) clearInterval(heartbeatInterval);
//     if (!reconnectTimeout) {
//       reconnectTimeout = setTimeout(connectWebSocket, 1000);
//     }
//   };

//   ws.onerror = (err) => {
//     console.error('[WS] Error occurred:', err);
//     setStatus('Disconnected');
//     try { ws.close(); } catch {}
//   };

//   ws.onmessage = (event) => {
//     console.log('[WS] Message received:', event.data);
//     let data;
//     try { data = JSON.parse(event.data); } catch { data = {}; }
//     handleSocketMessage(data);
//   };
// }

function connectWebSocket() {
  console.log('[WS] Connecting to:', SIGNALING_SERVER_URL);
  setStatus('Connecting');
  ws = new WebSocket(SIGNALING_SERVER_URL);

  ws.onopen = () => {
    console.log('[WS] ✅ WebSocket connected.');
    setStatus('Connected');
    ws.send(JSON.stringify({
      type: "identification",
      xrId: xrIdInput.value || "XR-1238",
      deviceName: usernameInput.value || "Desktop"
    }));
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    startHeartbeat();
  };

  ws.onclose = () => {
    console.warn('[WS] ❌ WebSocket closed.');
    setStatus('Disconnected');
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (!reconnectTimeout) {
      reconnectTimeout = setTimeout(() => {
        console.log('[WS] 🔁 Attempting reconnect...');
        connectWebSocket();
      }, 1000);
    }
  };

  ws.onerror = (err) => {
    console.error('[WS] 🛑 WebSocket error occurred:', err);
    setStatus('Disconnected');
    try { ws.close(); } catch {}
  };

  ws.onmessage = (event) => {
    console.log('[WS] 📩 Message received:', event.data);
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      console.warn('[WS] ⚠️ Failed to parse message as JSON:', event.data);
      data = {};
    }

    // === 🔴 Block duplicate desktop tabs ===
    if (data.type === 'error' && data.message?.includes('Duplicate desktop')) {
      console.warn('[WS] 🚫 Duplicate desktop tab detected. Blocking UI...');
      alert('This desktop session is inactive. Please close other tabs.');
      document.body.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; margin-top: 20%;">
          <h1 style="color: red; text-align: center;">Another tab is already connected.</h1>
          <p style="margin-top: 1rem;">Only one desktop tab can be active at a time.</p>
        </div>`;
      try { ws.close(); } catch {}
      return;
    }

    handleSocketMessage(data);
  };
}

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 25000);
}

// function handleSocketMessage(data) {
//   if (!data || !data.type) return;
//   console.log('[MSG] Handling type:', data.type);
//   switch (data.type) {
//     case 'offer': handleOffer(data.sdp ? data : data.offer ? data.offer : data); break;
//     case 'ice-candidate': handleRemoteIceCandidate(data.candidate); break;
//     case 'answer': break; // desktop only answers
//     case 'message':
//       const msg = normalizeMessage(data);
//       addMessageToHistory(msg);
//       addToRecentMessages(msg);
//       break;
//     case 'clear-messages':
//       if (!clearedMessages.has(data.messageId)) {
//         clearedMessages.add(data.messageId);
//         addSystemMessage(`🧹 Messages cleared by ${data.by}`);
//         recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
//       }
//       break;
//     case 'device_list': // SERVER now sends snake_case!
//     case 'device-list': // Just in case
//       console.log('[DEVICES] List received:', data.devices);
//       updateDeviceList(data.devices || []);
//       break;
//     case 'control-command':
//       console.log('[CONTROL] Command received:', data.command);
//       handleControlCommand(data.command);
//       break;
//     default:
//       if (data.status) setStatus(data.status);
//   }
// }
function handleSocketMessage(data) {
  if (!data || !data.type) return;
  console.log('[MSG] 🔍 Handling message of type:', data.type);
  switch (data.type) {
    case 'offer':
      console.log('[WebRTC] 📞 Received offer');
      handleOffer(data.sdp ? data : data.offer ? data.offer : data);
      break;

    case 'ice-candidate':
      console.log('[WebRTC] ❄️ Received ICE candidate');
      handleRemoteIceCandidate(data.candidate);
      break;

    case 'answer':
      console.log('[WebRTC] 🎤 Ignored answer (desktop does not need to handle)');
      break;

    case 'message':
      const msg = normalizeMessage(data);
      console.log('[MSG] 📨 Chat message:', msg);
      addMessageToHistory(msg);
      addToRecentMessages(msg);
      break;

    case 'clear-messages':
      if (!clearedMessages.has(data.messageId)) {
        console.log('[MSG] 🧹 Message clear triggered by', data.by);
        clearedMessages.add(data.messageId);
        addSystemMessage(`🧹 Messages cleared by ${data.by}`);
        recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
      }
      break;

    case 'device_list':
    case 'device-list':
      console.log('[DEVICES] 🧭 Device list received:', data.devices);
      updateDeviceList(data.devices || []);
      break;

    case 'control-command':
      console.log('[CONTROL] 🎮 Command received:', data.command);
      handleControlCommand(data.command);
      break;

    default:
      console.log('[WS] ℹ️ Unhandled message type:', data.type);
      if (data.status) setStatus(data.status);
  }
}

function createPeerConnection() {
  console.log('[WebRTC] Creating peer connection');
  stopStream();
  const turnConfig = window.TURN_CONFIG || {};
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ];
  if (turnConfig.urls && turnConfig.username && turnConfig.credential) {
    iceServers.push({ urls: turnConfig.urls, username: turnConfig.username, credential: turnConfig.credential });
    console.log('[WebRTC] Using TURN:', turnConfig);
  }
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });

  pc.ontrack = (event) => {
    console.log('[WebRTC] ontrack:', event.track.kind);
    if (!remoteStream) {
      remoteStream = new MediaStream();
      videoElement.srcObject = remoteStream;
      videoElement.muted = true;
    }
    if (!remoteStream.getTracks().some(t => t.id === event.track.id)) {
      remoteStream.addTrack(event.track);
    }
    videoElement.play().catch(e => {
      console.warn('[WebRTC] video play error', e);
      showClickToPlayOverlay();
    });
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('[WebRTC] Local ICE candidate:', event.candidate);
      ws && ws.send(JSON.stringify({
        type: 'ice-candidate',
        to: "XR-1234",
        from: xrIdInput.value?.trim() || "XR-1238",
        candidate: event.candidate
      }));
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[WebRTC] ICE state:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') stopStream();
  };

  pc.onconnectionstatechange = () => {
    console.log('[WebRTC] Conn state:', pc.connectionState);
    if (pc.connectionState === 'connected') setStatus('Connected');
    else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      stopStream();
      setStatus('Connecting');
    }
  };

  isStreamActive = true;
  return pc;
}

async function handleOffer(offer) {
  stopStream();
  peerConnection = createPeerConnection();
  console.log('[WebRTC] Received offer:', offer);

  if (pendingIceCandidates.length > 0) {
    for (const cand of pendingIceCandidates) {
      await handleRemoteIceCandidate(cand);
    }
    pendingIceCandidates = [];
  }

  try {
    // Support both {type, sdp} or full RTCSessionDescription object
    const remoteDesc = offer.sdp
      ? { type: offer.type || 'offer', sdp: offer.sdp }
      : offer;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(remoteDesc));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    ws && ws.send(JSON.stringify({
      type: 'answer',
      to: "XR-1234",
      from: xrIdInput.value || "XR-1238",
      sdp: peerConnection.localDescription.sdp
    }));
    console.log('[WebRTC] Sent answer');
  } catch (err) {
    console.error('[WebRTC] Error handling offer:', err);
  }
}

async function handleRemoteIceCandidate(candidate) {
  if (peerConnection && candidate && candidate.candidate) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('[WebRTC] Added ICE candidate:', candidate);
    } catch (err) {
      console.error('[WebRTC] Error adding ICE candidate:', err);
    }
  } else if (candidate) {
    pendingIceCandidates.push(candidate);
    console.log('[WebRTC] ICE candidate buffered:', candidate);
  }
}

function stopStream() {
  isStreamActive = false;
  if (videoElement) {
    videoElement.pause();
    videoElement.srcObject = null;
    videoElement.removeAttribute('src');
    videoElement.load();
  }
  if (muteBadge) muteBadge.style.display = 'none';
  if (videoOverlay) videoOverlay.style.display = 'none';
  if (peerConnection) {
    try { peerConnection.close(); } catch {}
    peerConnection = null;
  }
  if (remoteStream) {
    remoteStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
    remoteStream = null;
  }
  pendingIceCandidates = [];
}

// ========== Overlay UI for User Gesture to Play Video ==========
function showClickToPlayOverlay() {
  if (!videoOverlay) return;
  videoOverlay.style.display = 'flex';
  videoOverlay.innerHTML = `<button id="clickToPlayBtn" style="padding:1rem 2rem;font-size:1.25rem;">Click to Start Video</button>`;
  document.getElementById('clickToPlayBtn').onclick = () => {
    videoOverlay.style.display = 'none';
    videoElement.play();
  };
}

// ========== Device List ==========
function updateDeviceList(devices) {
  deviceListElement.innerHTML = '';
  devices.forEach(device => {
    // Log devices and XR IDs for clarity
    console.log(`[DEVICE] DeviceName: ${device.name || device.deviceName || '(no name)'}  XR-ID: ${device.xrId || '(no xrId)'}`);
    const li = document.createElement('li');
    li.textContent = `${device.name || device.deviceName || device.xrId} (${device.xrId})`;
    deviceListElement.appendChild(li);
  });
}

// ========== Messaging/UI Logic ==========
function sendMessage() {
  const text = messageInput.value.trim();
  const sender = usernameInput.value.trim() || 'Desktop';
  const xrId = xrIdInput.value.trim() || 'XR-1238';
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (text && ws && ws.readyState === WebSocket.OPEN) {
    const message = {
      type: "message",
      text,
      sender,
      xrId,
      priority: urgentCheckbox.checked ? 'urgent' : 'normal',
      timestamp
    };
    ws.send(JSON.stringify(message));
    addMessageToHistory(message);
    // addToRecentMessages(message);
    messageInput.value = '';
  }
}

// === UPDATED normalizeMessage with stringified JSON support ===
function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return {
    text: String(message),
    sender: 'unknown',
    xrId: 'unknown',
    timestamp: new Date().toLocaleTimeString(),
    priority: 'normal'
  };

  // If message.text looks like a JSON object, parse it!
  let parsed = {};
  if (typeof message.text === 'string' && message.text.trim().startsWith('{') && message.text.trim().endsWith('}')) {
    try {
      parsed = JSON.parse(message.text);
    } catch (e) {
      // Not JSON, leave as is
    }
  }

  // Merge parsed fields, prefer real message fields first
  const sender = message.sender || parsed.sender || 'unknown';
  const xrId = message.xrId || parsed.xrId || 'unknown';
  const text = message.text && typeof message.text === 'string' && parsed.text ? parsed.text : message.text || '';
  const timestamp = message.timestamp || parsed.timestamp || new Date().toLocaleTimeString();
  const isUrgent = message.urgent === true ||
    message.priority === 'urgent' ||
    parsed.urgent === true ||
    parsed.priority === 'urgent' ||
    (message.data && typeof message.data === 'string' &&
      message.data.includes('"urgent":true'));

  return {
    text,
    sender,
    xrId,
    timestamp,
    priority: isUrgent ? 'urgent' : 'normal'
  };
}

function addMessageToHistory(message) {
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
    recentMessagesDiv.removeChild(recentMessagesDiv.lastChild);
  }
}

function addSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'system-message';
  el.textContent = text;
  messageHistoryDiv.appendChild(el);
  messageHistoryDiv.scrollTop = messageHistoryDiv.scrollHeight;
}

function clearMessages() {
  const by = usernameInput.value.trim() || 'Desktop';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'clear-messages',
      by
    }));
    clearedMessages.clear();
    recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
    addSystemMessage(`🧹 Cleared messages locally by ${by}`);
  }
}

// === FINALIZED: Audio Mute/Unmute from ANDROID ===
function handleControlCommand(command) {
  if (!isStreamActive && command !== 'stop_stream') return;
  switch (command && command.toLowerCase && command.toLowerCase()) {
    case 'mute':
      if (muteBadge) muteBadge.style.display = 'block';
      if (videoElement) videoElement.muted = true;
      break;
    case 'unmute':
      if (muteBadge) muteBadge.style.display = 'none';
      if (videoElement) videoElement.muted = false;
      videoElement.play().catch(()=>{});
      break;
    case 'hide_video':
      if (videoOverlay) videoOverlay.style.display = 'flex';
      if (videoElement) videoElement.style.visibility = 'hidden';
      break;
    case 'show_video':
      if (videoOverlay) videoOverlay.style.display = 'none';
      if (videoElement) videoElement.style.visibility = 'visible';
      break;
    case 'stop_stream':
      console.log('[CONTROL] Stopping stream via command');
      stopStream();
      break;
    default:
      console.warn('[CONTROL] Unknown command:', command);
  }
}

// Don't change audio tracks, only Android controls mute/unmute
function setAudioTracksMuted(mute) {
  // No-op; muting is controlled by Android.
}

function checkStreamHealth() {
  if (!peerConnection || !isStreamActive) return false;
  const videoTracks = remoteStream?.getVideoTracks() || [];
  const audioTracks = remoteStream?.getAudioTracks() || [];
  return videoTracks.length > 0 && audioTracks.length > 0 &&
    videoTracks.every(t => t.readyState === 'live') &&
    audioTracks.every(t => t.readyState === 'live');
}

// === UI Event Bindings ===
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
clearMessagesBtn?.addEventListener('click', clearMessages);
openEmulatorBtn?.addEventListener('click', () => {
  window.open('http://localhost:3000/display.html', '_blank');
});
if (videoOverlay) {
  videoOverlay.addEventListener('click', () => {
    videoOverlay.style.display = 'none';
    videoElement.play();
  });
}

window.addEventListener('load', () => {
  console.log('[APP] Window loaded. Connecting WebSocket...');
  connectWebSocket();
});
