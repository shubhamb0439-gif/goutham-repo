const { ipcRenderer, shell } = require('electron');

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

let peerConnection = null;
let remoteStream = null;
let clearedMessages = new Set();
let pendingIceCandidates = [];
let isStreamActive = false;
let pendingOperations = [];

// === Helper: Update status badge text and class consistently using Tailwind ===
function setStatus(status) {
  statusElement.textContent = status;

  // Remove all possible bg colors first
  statusElement.classList.remove('bg-yellow-500', 'bg-green-500', 'bg-red-600');

  switch (status.toLowerCase()) {
    case 'connected':
      statusElement.classList.add('bg-green-500');
      break;
    case 'connecting':
      statusElement.classList.add('bg-yellow-500');
      break;
    case 'disconnected':
      statusElement.classList.add('bg-red-600');
      break;
    default:
      statusElement.classList.add('bg-yellow-500');
  }
}

// Initialize with "Connecting" status
setStatus('Connecting');

// === IPC Handlers ===

ipcRenderer.on('webrtc-offer', async (_, msg) => {
  console.log('[WebRTC] Received offer', msg);
  let offer = null;
  if (msg && msg.type === 'offer' && msg.sdp) {
    offer = msg;
  } else if (msg && msg.offer && msg.offer.type === 'offer' && msg.offer.sdp) {
    offer = msg.offer;
  } else if (msg && msg.sdp && typeof msg.sdp === 'string') {
    offer = { type: 'offer', sdp: msg.sdp };
  } else if (msg && msg.sdp && msg.sdp.type === 'offer' && msg.sdp.sdp) {
    offer = msg.sdp;
  }
  if (offer && offer.type === 'offer' && offer.sdp) {
    await handleOffer(offer);
  } else {
    console.warn('[WebRTC] Invalid offer received', msg);
  }
});

ipcRenderer.on('ice-candidate', (_, candidateMsg) => {
  console.log('[WebRTC] Received ICE candidate', candidateMsg);
  let candidate = candidateMsg && candidateMsg.candidate ? candidateMsg.candidate : candidateMsg;
  if (candidate && candidate.candidate) {
    if (peerConnection) {
      handleRemoteIceCandidate(candidate);
    } else {
      pendingIceCandidates.push(candidate);
    }
  } else {
    console.warn('[WebRTC] Invalid ICE candidate received', candidateMsg);
  }
});

ipcRenderer.on('webrtc-answer', (_, msg) => {
  let answer = null;
  if (msg && msg.type === 'answer' && msg.sdp) {
    answer = msg;
  } else if (msg && msg.sdp && typeof msg.sdp === 'string') {
    answer = { type: 'answer', sdp: msg.sdp };
  } else if (msg && msg.answer && msg.answer.type === 'answer' && msg.answer.sdp) {
    answer = msg.answer;
  }
  if (peerConnection && answer && answer.sdp) {
    peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

ipcRenderer.on('trigger-start-stream', () => {
  console.log('[IPC] Start stream triggered');
  // You might want to trigger UI changes here if needed
});

ipcRenderer.on('trigger-stop-stream', () => {
  console.log('[IPC] Stop stream triggered');
  stopStream();
});

ipcRenderer.on('connection-status', (_, status) => {
  setStatus(status);
});

// === Messaging Logic ===
ipcRenderer.on('new-message', (_, data) => {
  let parsedMessage = data;
  if (data && typeof data.data === 'string') {
    try {
      parsedMessage = JSON.parse(data.data);
    } catch (e) {
      console.warn('[renderer.js] Failed to parse nested message JSON:', e);
      parsedMessage = {
        text: data.data,
        sender: 'unknown',
        xrId: 'unknown',
        timestamp: new Date().toLocaleTimeString(),
        priority: 'normal'
      };
    }
  }
  const msg = normalizeMessage(parsedMessage);
  addMessageToHistory(msg);
  addToRecentMessages(msg);
});

ipcRenderer.on('message-cleared', (_, data) => {
  if (!clearedMessages.has(data.messageId)) {
    clearedMessages.add(data.messageId);
    addSystemMessage(`🧹 Messages cleared by ${data.by}`);
    recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
  }
});

ipcRenderer.on('status_report', (_, data) => {
  addSystemMessage(`📋 Status Report from ${data.from}: ${data.status}`);
});

ipcRenderer.on('control-command', (_, data) => {
  if (!data || typeof data.command !== 'string') {
    console.warn('[CONTROL] Invalid control-command received:', data);
    return;
  }
  handleControlCommand(data.command);
});

// === Button Actions ===
openEmulatorBtn.addEventListener('click', () => {
  ipcRenderer.send('open-emulator');
  shell.openExternal('http://localhost:3000/display.html');
});

sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
clearMessagesBtn?.addEventListener('click', clearMessages);

// === Send Message ===
function sendMessage() {
  const text = messageInput.value.trim();
  const sender = usernameInput.value.trim() || 'Desktop';
  const xrId = xrIdInput.value.trim() || 'XR-1238';
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (text) {
    const message = {
      type: "message",
      text,
      sender,
      xrId,
      priority: urgentCheckbox.checked ? 'urgent' : 'normal',
      timestamp
    };
    console.log('[RENDERER] Sending message:', message);
    ipcRenderer.invoke('send-message', message);
    addMessageToHistory(message);
    addToRecentMessages(message);
    messageInput.value = '';
  }
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return {
    text: String(message),
    sender: 'unknown',
    xrId: 'unknown',
    timestamp: new Date().toLocaleTimeString(),
    priority: 'normal'
  };

  const isUrgent = message.urgent === true ||
                 message.priority === 'urgent' ||
                 (message.data && typeof message.data === 'string' &&
                  message.data.includes('"urgent":true'));

  return {
    text: message.text || (message.data || ''),
    sender: message.sender || 'unknown',
    xrId: message.xrId || 'unknown',
    timestamp: message.timestamp || new Date().toLocaleTimeString(),
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
  ipcRenderer.invoke('send-message', {
    type: 'clear-messages',
    by
  });
  clearedMessages.clear();
  recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
  addSystemMessage(`🧹 Cleared messages locally by ${by}`);
}

// === WebRTC Logic ===
function createPeerConnection() {
  stopStream(); // Ensure clean state before creating new connection

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ],
    iceTransportPolicy: 'all'
  });

  pc.ontrack = (event) => {
    if (!isStreamActive) return;

    console.log('[WebRTC] ontrack event:', event.track.kind);
    if (!remoteStream) {
      remoteStream = new MediaStream();
      videoElement.srcObject = remoteStream;
    }

    // Prevent duplicate tracks
    const existingTracks = remoteStream.getTracks().filter(t =>
      t.kind === event.track.kind
    );

    existingTracks.forEach(t => remoteStream.removeTrack(t));
    remoteStream.addTrack(event.track);

    videoElement.play().catch(e => {
      console.error('Video play error:', e);
    });
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('[ICE] Candidate:', event.candidate.candidate);
      ipcRenderer.send('ice-candidate', {
        type: 'ice-candidate',
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex
        }
      });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[WebRTC] ICE state:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      stopStream();
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('Connection state:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      setStatus('Connected');
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
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

  // Add buffered ICE candidates
  if (pendingIceCandidates.length > 0) {
    for (const cand of pendingIceCandidates) {
      await handleRemoteIceCandidate(cand);
    }
    pendingIceCandidates = [];
  }

  let realOffer = offer;
  if (offer && typeof offer.sdp !== 'string' && offer.sdp && typeof offer.sdp === 'object' && offer.sdp.sdp) {
    realOffer = { type: offer.sdp.type, sdp: offer.sdp.sdp };
  }

  if (realOffer && realOffer.type === 'offer' && typeof realOffer.sdp === 'string') {
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(realOffer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      ipcRenderer.send('webrtc-answer', { type: 'answer', sdp: peerConnection.localDescription.sdp });
      console.log('[WebRTC] Sent SDP answer');
    } catch (err) {
      console.error('[WebRTC] Error handling offer:', err);
    }
  } else {
    console.error('[WebRTC] Offer is invalid format:', offer);
  }
}

async function handleRemoteIceCandidate(candidate) {
  if (peerConnection && candidate && candidate.candidate) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('[WebRTC] Error adding ICE candidate:', err);
    }
  } else {
    console.warn('[WebRTC] Ignored invalid ICE candidate', candidate);
  }
}

function stopStream() {
  console.log('[XR] stopStream() called!');
  isStreamActive = false;
  pendingOperations = [];

  // 1. Immediately blank the video
  if (videoElement) {
    videoElement.pause();
    videoElement.srcObject = null;
    videoElement.removeAttribute('src');
    videoElement.load();
  }

  // 2. Hide overlays and show video
  if (muteBadge) muteBadge.style.display = 'none';
  if (videoOverlay) videoOverlay.style.display = 'none';

  // 3. Close peer connection more thoroughly
  if (peerConnection) {
    // Close all data channels first
    if (peerConnection.getDataChannels) {
      peerConnection.getDataChannels().forEach(channel => {
        channel.close();
      });
    }

    // Close all transceivers
    peerConnection.getTransceivers().forEach(transceiver => {
      try {
        if (transceiver.stop) transceiver.stop();
        if (transceiver.sender && transceiver.sender.track) {
          transceiver.sender.track.stop();
        }
        if (transceiver.receiver && transceiver.receiver.track) {
          transceiver.receiver.track.stop();
        }
      } catch (e) {
        console.error('Error stopping transceiver:', e);
      }
    });

    // Close the connection
    try { 
      peerConnection.close(); 
    } catch (e) {
      console.error('Error closing peer connection:', e);
    }
    peerConnection = null;
  }

  // 4. Stop and remove all tracks more thoroughly
  if (remoteStream) {
    remoteStream.getTracks().forEach(track => {
      try { 
        track.stop(); 
      } catch (e) {
        console.error('Error stopping track:', e);
      }
    });
    remoteStream = null;
  }

  // 5. Final cleanups
  pendingIceCandidates = [];
}

function handleControlCommand(command) {
  if (!isStreamActive) {
    console.warn('[CONTROL] Ignoring command - stream not active:', command);
    return;
  }

  switch (command.toLowerCase()) {
    case 'mute':
      setAudioTracksMuted(true);
      if (muteBadge) muteBadge.style.display = 'block';
      break;
    case 'unmute':
      setAudioTracksMuted(false);
      if (muteBadge) muteBadge.style.display = 'none';
      break;
    case 'hide_video':
      if (videoOverlay) videoOverlay.style.display = 'flex';
      if (videoElement) videoElement.style.visibility = 'hidden';
      break;
    case 'show_video':
      if (videoOverlay) videoOverlay.style.display = 'none';
      if (videoElement) videoElement.style.visibility = 'visible';
      break;
    default:
      console.warn('[CONTROL] Unknown command:', command);
  }
}

function setAudioTracksMuted(mute) {
  if (remoteStream) {
    remoteStream.getAudioTracks().forEach(track => {
      track.enabled = !mute;
    });
  }
}

function checkStreamHealth() {
  if (!peerConnection || !isStreamActive) return false;
  
  const videoTracks = remoteStream?.getVideoTracks() || [];
  const audioTracks = remoteStream?.getAudioTracks() || [];
  
  return videoTracks.length > 0 && audioTracks.length > 0 &&
         videoTracks.every(t => t.readyState === 'live') &&
         audioTracks.every(t => t.readyState === 'live');
}
