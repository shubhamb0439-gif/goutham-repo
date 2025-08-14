// //------------------------------------------------------- app.js (refresh-safe + room concept + manual connect) ---------------------------------------------------
 
// console.log('[INIT] Initializing DOM elements');
 
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
 
// console.log('[INIT] DOM elements initialized:', {
//   videoElement,
//   statusElement,
//   deviceListElement,
//   messageInput,
//   sendButton,
//   urgentCheckbox,
//   recentMessagesDiv,
//   messageHistoryDiv,
// });
 
// let socket = null;
// let peerConnection = null;
// let remoteStream = null;
// let clearedMessages = new Set();
// let pendingIceCandidates = [];
// let isStreamActive = false;
// let reconnectTimeout = null;
// let heartbeatInterval = null;
// let lastDeviceList = []; // remember last list we got
// let duplicateNotified = false; // notify once per session about duplicate tabs
 
// // 🔷 ROOM: track the private room we’re paired into (if any)
// let currentRoom = null;
 
// // 🔒 Sticky autoconnect flag (persist across refresh)
// const AUTO_KEY = 'XR_AUTOCONNECT';
 
// /* =========================
//    ✅ ID-gating helpers (added)
//    ========================= */
// const ALLOWED_ID_NUM = '1238';
// const ALLOWED_ID     = `XR-${ALLOWED_ID_NUM}`;
 
// function sanitizeIdInput(v) {
//   // keep previous placeholder behavior + trimming
//   const s = (v || '').trim();
//   if (/^Dynamic_ID\(\)$/i.test(s)) return '';
//   return s;
// }
// function normalizeId(v) {
//   // accept "1238" or "XR-1238", normalize to "XR-1238"
//   const s = sanitizeIdInput(v);
//   if (!s) return '';
//   if (/^\d+$/.test(s)) return `XR-${s}`;
//   const up = s.toUpperCase();
//   return up.startsWith('XR-') ? up : s;
// }
// function isAllowedId(id) {
//   return normalizeId(id) === ALLOWED_ID;
// }
 
// // 🔄 Fresh-start control
// let manualDisconnect = false;     // true only when user clicks Disconnect
// let ignoreHistoryOnce = false;    // drop server history just for the next connect
// const CLEAR_KEY = 'XR_CLEAR_ON_NEXT_CONNECT'; // '1' => wipe on next connect
 
// // ---------------- CONFIG ----------------
// console.log('[CONFIG] Loading configuration');
// // Update to your server URL as needed:
// // const SERVER_URL = 'https://77ad8e5a313e.ngrok-free.app';  
// const SERVER_URL = 'https://xr-messaging-geexbheshbghhab7.centralindia-01.azurewebsites.net';
 
// /* ------------- XR_ID / NAME init (updated) ------------- */
// // XR ID is editable from the front-end before connecting
// let XR_ID = normalizeId(xrIdInput.value) || ALLOWED_ID;  // default to XR-1238
// // Make device name mutable so we can force "Desktop1238"
// let DEVICE_NAME = (usernameInput.value || '').trim() || 'Desktop';
// // If the initial value is already allowed, label as Desktop1238
// if (isAllowedId(XR_ID)) {
//   DEVICE_NAME = `Desktop${ALLOWED_ID_NUM}`;
// }
 
// console.log('[CONFIG] Server URL:', SERVER_URL);
// console.log('[CONFIG] XR ID (initial):', XR_ID);
// console.log('[CONFIG] Device Name:', DEVICE_NAME);
 
// // Peer-ID mapping: map Desktop XR_ID -> its Android peer ID.
// // Customize this logic if you have a different mapping scheme.
// function mapPeerId(desktopId) {
//   // Example mapping rule:
//   // - If you want a specific pair, return that here.
//   // - Currently we map all desktop IDs to XR-1234 (the Android).
//   return 'XR-1234';
// }
// function currentPeerId() {
//   return mapPeerId(XR_ID);
// }
 
// /* =========================
//    📣 Cross‑tab presence (duplicate guard)
//    ========================= */
// const TAB_ID = Math.random().toString(36).slice(2);
// let presenceChan = null;
// let duplicateActive = false;
// let presencePingInterval = null;
 
// function openPresenceChannel() {
//   if (presenceChan) try { presenceChan.close(); } catch {}
//   presenceChan = new BroadcastChannel('xr-presence');
 
//   presenceChan.onmessage = (e) => {
//     const msg = e.data || {};
//     // ignore self
//     if (msg.tabId === TAB_ID) return;
 
//     // only care about our target ID (XR-1238)
//     if (!isAllowedId(msg.xrId)) return;
 
//     if (msg.type === 'who') {
//       // another tab is probing: answer with our state
//       presenceChan.postMessage({
//         type: 'presence',
//         xrId: XR_ID,
//         tabId: TAB_ID,
//         state: socket?.connected ? 'connected' : 'idle',
//       });
//     } else if (msg.type === 'presence') {
//       // we received another tab's presence; if it's connected on the same allowed ID, flag duplicate
//       if (msg.state === 'connected') {
//         duplicateActive = true;
//       }
//     }
//   };
// }
 
// function announcePresence(state = (socket?.connected ? 'connected' : 'idle')) {
//   presenceChan?.postMessage({
//     type: 'presence',
//     xrId: XR_ID,
//     tabId: TAB_ID,
//     state,
//   });
// }
 
// function startPresencePings() {
//   if (presencePingInterval) clearInterval(presencePingInterval);
//   presencePingInterval = setInterval(() => {
//     announcePresence(socket?.connected ? 'connected' : 'idle');
//   }, 4000);
// }
 
// function stopPresencePings() {
//   if (presencePingInterval) {
//     clearInterval(presencePingInterval);
//     presencePingInterval = null;
//   }
// }
 
// /* ------------- XR ID change listener (updated) ------------- */
// xrIdInput.addEventListener('change', () => {
//   const newId = normalizeId(xrIdInput.value);
//   XR_ID = newId || ALLOWED_ID;
 
//   if (!isAllowedId(XR_ID)) {
//     // Reset label and hide device list if disallowed
//     DEVICE_NAME = 'Desktop';
//     deviceListElement.innerHTML = '';
//     addSystemMessage(`❌ Only ID ${ALLOWED_ID} can connect. You entered "${newId || '(empty)'}".`);
//     // If connected with a different ID somehow, drop it.
//     if (socket?.connected) {
//       try { localStorage.setItem(AUTO_KEY, '0'); } catch {}
//       socket.disconnect();
//     }
//     setStatus('Disconnected');
//     announcePresence('idle');
//     return;
//   }
 
//   // Allowed: set display name and optionally auto-connect once
//   DEVICE_NAME = `Desktop${ALLOWED_ID_NUM}`;
//   addSystemMessage(`✅ ID set to ${XR_ID}. Connecting…`);
//   if (!socket) initSocket();
//   if (!socket.connected) {
//     setStatus('Connecting');
//     if (socket?.io) socket.io.opts.reconnection = true;
//     try { localStorage.setItem(AUTO_KEY, '1'); } catch {}
//     socket.connect();
//   }
// });
 
// // ---------------- Status pill ----------------
// function setStatus(status) {
//   console.log('[STATUS] Updating status to:', status);
//   statusElement.textContent = status;
//   statusElement.classList.remove('bg-yellow-500', 'bg-green-500', 'bg-red-600');
//   switch ((status || '').toLowerCase()) {
//     case 'connected':
//       console.log('[STATUS] Setting connected state');
//       statusElement.classList.add('bg-green-500');
//       break;
//     case 'connecting':
//       console.log('[STATUS] Setting connecting state');
//       statusElement.classList.add('bg-yellow-500');
//       break;
//     case 'disconnected':
//       console.log('[STATUS] Setting disconnected state');
//       statusElement.classList.add('bg-red-600');
//       break;
//     default:
//       console.log('[STATUS] Setting default (connecting) state');
//       statusElement.classList.add('bg-yellow-500');
//   }
// }
 
// // ---- Heartbeat helpers ----
// function startHeartbeat() {
//   console.log('[HEARTBEAT] Starting heartbeat interval');
//   if (heartbeatInterval) {
//     console.log('[HEARTBEAT] Clearing existing heartbeat interval');
//     clearInterval(heartbeatInterval);
//   }
//   heartbeatInterval = setInterval(() => {
//     if (socket?.connected) {
//       console.log('[HEARTBEAT] Sending ping to server');
//       socket.emit('ping');
//     } else {
//       console.log('[HEARTBEAT] Socket not connected - skipping ping');
//     }
//   }, 25000);
// }
 
// function stopHeartbeat() {
//   if (heartbeatInterval) {
//     clearInterval(heartbeatInterval);
//     heartbeatInterval = null;
//     console.log('[HEARTBEAT] Stopped heartbeat');
//   }
// }
 
// // ---------------- Helpers ----------------
// function wipeLocalMessages(reason = '') {
//   try {
//     console.log('[CHAT] Wiping local messages', reason ? `(${reason})` : '');
//     if (messageHistoryDiv) messageHistoryDiv.innerHTML = '';
//     if (recentMessagesDiv) recentMessagesDiv.innerHTML = '';
//     clearedMessages = new Set();
//   } catch (e) {
//     console.warn('[CHAT] wipeLocalMessages failed:', e);
//   }
// }
 
// // ---------------- Manual init (no auto-connect) ----------------
// function initSocket() {
//   if (socket) return; // init once
//   console.log('[SOCKET] Initializing Socket.IO client (manual connect mode)');
//   setStatus('Disconnected');
 
//   socket = io(SERVER_URL, {
//     path: '/socket.io',
//     transports: ['websocket'],
//     reconnection: true,
//     reconnectionAttempts: Infinity,
//     reconnectionDelay: 1000,
//     reconnectionDelayMax: 5000,
//     secure: true,
//     autoConnect: false, // 🔴 start DISCONNECTED; we control dial
//   });
 
//   // --- lifecycle events ---
//   socket.on('connect', () => {
//     // 🔐 Block accidental connects if ID isn't allowed OR a duplicate tab is active
//     duplicateActive = false;
//     presenceChan?.postMessage({ type: 'who', xrId: XR_ID, tabId: TAB_ID });
 
//     // Defer the rest of the connect flow until presence check returns
//     setTimeout(() => {
//       if (!isAllowedId(XR_ID) || duplicateActive) {
//         console.warn('[SOCKET] Disallowed or duplicate detected; disconnecting.');
//         addSystemMessage(!isAllowedId(XR_ID)
//           ? `❌ Only ${ALLOWED_ID} may connect. Disconnecting…`
//           : '⚠️ This XR ID is already active in another tab/window. Disconnecting…');
//         try { localStorage.setItem(AUTO_KEY, '0'); } catch {}
//         if (socket?.io) socket.io.opts.reconnection = false;
//         socket.disconnect();
//         setStatus('Disconnected');
//         announcePresence('idle');
//         return;
//       }
 
//       console.log('[SOCKET] ✅ Connected');
 
//       // If previous session requested a fresh start, wipe now and ignore server history once
//       try {
//         if (localStorage.getItem(CLEAR_KEY) === '1') {
//           wipeLocalMessages('fresh connect (CLEAR_KEY=1)');
//           ignoreHistoryOnce = true;                   // drop upcoming message_history once
//           localStorage.setItem(CLEAR_KEY, '0');       // consume the flag
//         }
//       } catch (e) {
//         console.warn('[CLEAR] Failed to read/clear CLEAR_KEY:', e);
//       }
 
//       setStatus('Connected');
 
//       // keep refresh-safe autoconnect behavior
//       try { localStorage.setItem(AUTO_KEY, '1'); } catch {}
 
//       const payload = { deviceName: DEVICE_NAME, xrId: XR_ID };
//       console.log('[SOCKET] Emitting identify + request_device_list', payload);
//       socket.emit('identify', payload);
//       socket.emit('request_device_list');
 
//       console.log('[PAIR] Attempt pairWith on connect');
//       pairWith(currentPeerId());
 
//       if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
//       startHeartbeat();
//       announcePresence('connected');
//     }, 250);
//   });
 
//   socket.io.on('reconnect', (attempt) => {
//     console.log('[SOCKET] 🔄 Reconnected. attempt=', attempt);
//     const payload = { deviceName: DEVICE_NAME, xrId: XR_ID };
//     socket.emit('identify', payload);
//     socket.emit('request_device_list');
 
//     // On reconnect, try to re-pair if room was lost
//     if (!currentRoom) {
//       console.log('[PAIR] No currentRoom on reconnect — re-pairing');
//       pairWith(currentPeerId());
//     }
 
//     startHeartbeat();
//     announcePresence('connected');
//   });
 
//   socket.on('connect_error', (err) => {
//     console.warn('[SOCKET] connect_error:', err?.message || err);
//     setStatus('Disconnected');
//     stopHeartbeat();
//     announcePresence('idle');
//   });
 
//   socket.on('disconnect', (reason) => {
//     console.warn('[SOCKET] disconnected:', reason);
//     setStatus('Disconnected');
//     stopHeartbeat();
 
//     if (manualDisconnect) {
//       // Already wiped in toggleConnection(); nothing extra here
//       console.log('[SOCKET] Manual disconnect completed');
//     } else {
//       console.log('[SOCKET] Non-manual disconnect (e.g., refresh or network) — preserving messages');
//     }
 
//     currentRoom = null; // we’ll re-pair on next connect if needed
//     manualDisconnect = false; // reset the latch
 
//     // do not clear AUTO_KEY; preserves refresh auto-connect if enabled
//     updateDeviceList(lastDeviceList);
//     announcePresence('idle');
//   });
 
//   socket.on('error', (data) => {
//     // If the server warns about duplicate desktops, surface that to the UI
//     if (data?.message?.includes('Duplicate desktop')) {
//       console.warn('[SOCKET] Duplicate desktop notice from server:', data.message);
//       addSystemMessage('⚠️ This XR ID is already active in another tab/window.');
//     }
//   });
 
//   // --- your existing handlers ---
//   socket.on('signal', handleSignalMessage);
//   socket.on('message', handleChatMessage);
//   socket.on('device_list', updateDeviceList);
//   socket.on('control', handleControlCommand);
//   socket.on('message-cleared', handleMessagesCleared);
//   socket.on('message_history', handleMessageHistory);
 
//   // --- 🔷 ROOM events ---
//   socket.on('pair_error', ({ message }) => {
//     console.warn('[PAIR] pair_error:', message);
//     addSystemMessage(`Pair error: ${message}`);
//   });
 
//   socket.on('room_joined', ({ roomId, members }) => {
//     console.log('[PAIR] room_joined:', roomId, members);
//     currentRoom = roomId;
//     addSystemMessage(`🎯 VR Room created: ${roomId}. Members: ${members.join(', ')}`);
//   });
 
//   socket.on('peer_left', ({ xrId, roomId }) => {
//     console.log('[PAIR] peer_left', xrId, roomId);
//     if (currentRoom === roomId) {
//       addSystemMessage(`${xrId} left the room.`);
//       currentRoom = null; // ensure we don’t keep signaling into an empty room
//       stopStream();
//     }
//   });
// }
 
// // ---------------- Clickable status pill: Connect/Disconnect ----------------
// function toggleConnection() {
//   if (!socket) initSocket();
 
//   // Always read the latest input
//   XR_ID = normalizeId(xrIdInput.value) || ALLOWED_ID;
 
//   if (socket.connected) {
//     console.log('[SOCKET] Manual disconnect requested');
//     manualDisconnect = true;                 // mark user-initiated
//     try {
//       localStorage.setItem(AUTO_KEY, '0');   // block future auto-connects
//     } catch {}
//     // Hard-disable reconnection until user explicitly connects
//     if (socket?.io) socket.io.opts.reconnection = false;
 
//     wipeLocalMessages('manual disconnect');
//     socket.disconnect();
//     setStatus('Disconnected');
//     announcePresence('idle');
//     return;
//   }
 
//   // Not connected -> only allow connecting if ID is exactly XR-1238
//   if (!isAllowedId(XR_ID)) {
//     addSystemMessage(`❌ Connecting blocked. Enter "${ALLOWED_ID_NUM}" (or "${ALLOWED_ID}") first.`);
//     try { localStorage.setItem(AUTO_KEY, '0'); } catch {}
//     setStatus('Disconnected');
//     announcePresence('idle');
//     return;
//   }
 
//   // 🔎 Probe other tabs for duplicates before connecting
//   duplicateActive = false;
//   presenceChan?.postMessage({ type: 'who', xrId: XR_ID, tabId: TAB_ID });
 
//   setStatus('Checking…');
//   setTimeout(() => {
//     if (duplicateActive) {
//       addSystemMessage('⚠️ This XR ID is already active in another tab/window.');
//       try { localStorage.setItem(AUTO_KEY, '0'); } catch {}
//       setStatus('Disconnected');
//       announcePresence('idle');
//       return;
//     }
 
//     console.log('[SOCKET] Manual connect requested with allowed ID:', XR_ID);
//     // Re-enable reconnection for active sessions
//     if (socket?.io) socket.io.opts.reconnection = true;
 
//     setStatus('Connecting');
//     try { localStorage.setItem(AUTO_KEY, '1'); } catch {}
//     socket.connect();
//   }, 300); // small window to receive presence replies
// }
 
// // Make the status chip clickable
// statusElement.style.cursor = 'pointer';
// statusElement.title = 'Click to connect / disconnect';
// statusElement.addEventListener('click', toggleConnection);
 
// // Ensure refresh keeps autoconnect if currently connected
// window.addEventListener('beforeunload', () => {
//   try {
//     if (socket?.connected) {
//       localStorage.setItem(AUTO_KEY, '1');
//       console.log('[AUTO] beforeunload: XR_AUTOCONNECT kept as 1');
//     }
//   } catch (e) {
//     console.warn('[AUTO] beforeunload: failed to persist XR_AUTOCONNECT:', e);
//   }
// });
 
// // ---------------- WebRTC & Messaging ----------------
// function handleSignalMessage(data) {
//   console.log('[SIGNAL] Received signal message:', data?.type);
//   switch (data?.type) {
//     case 'offer':
//       console.log('[WEBRTC] 📞 Received offer from peer');
//       // Server relays payload as { type, from, data }
//       handleOffer(data.data);
//       break;
//     case 'ice-candidate':
//       console.log('[WEBRTC] ❄️ Received ICE candidate from peer');
//       handleRemoteIceCandidate(data.data);
//       break;
//     case 'answer':
//       // Desktop typically sends answers, but log for completeness
//       console.log('[WEBRTC] Received answer (unexpected for desktop) – ignoring');
//       break;
//     default:
//       console.log('[WEBRTC] Unhandled signal type:', data?.type);
//   }
// }
 
// function handleChatMessage(msg) {
//   console.log('[CHAT] Received chat message:', msg);
//   const normalized = normalizeMessage(msg);
//   console.log('[CHAT] Normalized message:', normalized);
//   addMessageToHistory(normalized);
//   addToRecentMessages(normalized);
// }
 
// function handleMessagesCleared(data) {
//   if (!clearedMessages.has(data.messageId)) {
//     console.log('[CHAT] Messages cleared by', data.by, 'messageId:', data.messageId);
//     clearedMessages.add(data.messageId);
//     addSystemMessage(`🧹 Messages cleared by ${data.by}`);
//     recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
//   } else {
//     console.log('[CHAT] Already processed clear message for messageId:', data.messageId);
//   }
// }
 
// function handleMessageHistory(data) {
//   if (ignoreHistoryOnce) {
//     console.log('[CHAT] Dropping server message_history once for fresh start');
//     ignoreHistoryOnce = false;  // consume the one-time ignore
//     return;
//   }
//   console.log('[CHAT] Received message history with', (data?.messages || []).length, 'messages');
//   (data?.messages || []).forEach((msg) => {
//     const normalized = normalizeMessage(msg);
//     addMessageToHistory(normalized);
//   });
// }
 
// function createPeerConnection() {
//   console.log('[WEBRTC] Creating new peer connection');
//   stopStream();
//   const turnConfig = window.TURN_CONFIG || {};
//   console.log('[WEBRTC] TURN config:', turnConfig);
 
//   const iceServers = [
//     { urls: 'stun:stun.l.google.com:19302' },
//     { urls: 'stun:stun1.l.google.com:19302' },
//     { urls: 'stun:stun2.l.google.com:19302' },
//     { urls: 'stun:stun3.l.google.com:19302' },
//     { urls: 'stun:stun4.l.google.com:19302' },
//   ];
 
//   if (turnConfig.urls && turnConfig.username && turnConfig.credential) {
//     iceServers.push({
//       urls: turnConfig.urls,
//       username: turnConfig.username,
//       credential: turnConfig.credential,
//     });
//     console.log('[WEBRTC] Added TURN server to ICE configuration');
//   }
 
//   const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });
//   console.log('[WEBRTC] Peer connection created with ICE servers:', iceServers);
 
//   pc.ontrack = (event) => {
//     console.log('[WEBRTC] Received track:', event.track.kind);
//     if (!remoteStream) {
//       console.log('[WEBRTC] Creating new remote stream');
//       remoteStream = new MediaStream();
//       videoElement.srcObject = remoteStream;
//       videoElement.muted = true;
//     }
//     if (!remoteStream.getTracks().some((t) => t.id === event.track.id)) {
//       console.log('[WEBRTC] Adding track to remote stream');
//       remoteStream.addTrack(event.track);
//     }
//     videoElement.play().catch((e) => {
//       console.warn('[WEBRTC] Video play error:', e);
//       showClickToPlayOverlay();
//     });
//   };
 
//   pc.onicecandidate = (event) => {
//     if (event.candidate) {
//       console.log('[WEBRTC] Generated ICE candidate:', event.candidate);
//       // 🔷 Prefer room forwarding (omit 'to' when joined)
//       const payload = {
//         type: 'ice-candidate',
//         from: XR_ID,
//         data: event.candidate,
//       };
//       if (!currentRoom) {
//         // Fallback to direct-to behavior for compatibility
//         payload.to = currentPeerId();
//       }
//       console.log('[WEBRTC] Emitting signal (ice-candidate):', payload);
//       socket?.emit('signal', payload);
//     } else {
//       console.log('[WEBRTC] ICE gathering complete');
//     }
//   };
 
//   pc.oniceconnectionstatechange = () => {
//     console.log('[WEBRTC] ICE connection state changed:', pc.iceConnectionState);
//     if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
//       console.log('[WEBRTC] ICE connection failed or disconnected - stopping stream');
//       stopStream();
//     }
//   };
 
//   pc.onconnectionstatechange = () => {
//     console.log('[WEBRTC] Connection state changed:', pc.connectionState);
//     if (pc.connectionState === 'connected') {
//       setStatus('Connected');
//     } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
//       console.log('[WEBRTC] Connection failed or disconnected - stopping stream');
//       stopStream();
//       setStatus('Connecting');
//     }
//   };
 
//   isStreamActive = true;
//   return pc;
// }
 
// async function handleOffer(offer) {
//   console.log('[WEBRTC] Handling offer:', offer);
//   stopStream();
//   peerConnection = createPeerConnection();
 
//   if (pendingIceCandidates.length > 0) {
//     console.log('[WEBRTC] Processing', pendingIceCandidates.length, 'pending ICE candidates');
//     for (const cand of pendingIceCandidates) {
//       // eslint-disable-next-line no-await-in-loop
//       await handleRemoteIceCandidate(cand);
//     }
//     pendingIceCandidates = [];
//   }
 
//   try {
//     console.log('[WEBRTC] Setting remote description');
//     await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
//     console.log('[WEBRTC] Creating answer');
//     const answer = await peerConnection.createAnswer();
//     console.log('[WEBRTC] Setting local description');
//     await peerConnection.setLocalDescription(answer);
 
//     // 🔷 Prefer room forwarding: omit 'to' if currentRoom exists
//     const payload = {
//       type: 'answer',
//       from: XR_ID,
//       data: peerConnection.localDescription,
//     };
//     if (!currentRoom) {
//       payload.to = currentPeerId();
//     }
//     console.log('[WEBRTC] Emitting signal (answer):', payload);
//     socket?.emit('signal', payload);
//     console.log('[WEBRTC] Answer sent to peer');
//   } catch (err) {
//     console.error('[WEBRTC] Error handling offer:', err);
//   }
// }
 
// async function handleRemoteIceCandidate(candidate) {
//   console.log('[WEBRTC] Handling remote ICE candidate:', candidate);
//   if (peerConnection && candidate && candidate.candidate) {
//     try {
//       console.log('[WEBRTC] Adding ICE candidate to peer connection');
//       await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
//     } catch (err) {
//       console.error('[WEBRTC] Error adding ICE candidate:', err);
//     }
//   } else if (candidate) {
//     console.log('[WEBRTC] Buffering ICE candidate for later');
//     pendingIceCandidates.push(candidate);
//   }
// }
 
// function stopStream() {
//   console.log('[STREAM] Stopping stream');
//   isStreamActive = false;
 
//   if (videoElement) {
//     console.log('[STREAM] Pausing and clearing video element');
//     try {
//       videoElement.pause();
//     } catch (e) {}
//     videoElement.srcObject = null;
//     videoElement.removeAttribute('src');
//     try {
//       videoElement.load();
//     } catch (e) {}
//   }
 
//   if (muteBadge) {
//     console.log('[STREAM] Hiding mute badge');
//     muteBadge.style.display = 'none';
//   }
 
//   if (videoOverlay) {
//     console.log('[STREAM] Hiding video overlay');
//     videoOverlay.style.display = 'none';
//   }
 
//   if (peerConnection) {
//     console.log('[STREAM] Closing peer connection');
//     try {
//       peerConnection.close();
//     } catch (e) {
//       console.warn('[STREAM] Error closing peer connection:', e);
//     }
//     peerConnection = null;
//   }
 
//   if (remoteStream) {
//     console.log('[STREAM] Stopping remote stream tracks');
//     remoteStream.getTracks().forEach((track) => {
//       try {
//         track.stop();
//       } catch (e) {
//         console.warn('[STREAM] Error stopping track:', e);
//       }
//     });
//     remoteStream = null;
//   }
 
//   pendingIceCandidates = [];
//   console.log('[STREAM] Stream stopped completely');
// }
 
// function showClickToPlayOverlay() {
//   console.log('[UI] Showing click-to-play overlay');
//   if (!videoOverlay) return;
//   videoOverlay.style.display = 'flex';
//   videoOverlay.innerHTML = `<button id="clickToPlayBtn" style="padding:1rem 2rem;font-size:1.25rem;">Click to Start Video</button>`;
//   const btn = document.getElementById('clickToPlayBtn');
//   if (btn) {
//     btn.onclick = () => {
//       console.log('[UI] Click-to-play button clicked');
//       videoOverlay.style.display = 'none';
//       videoElement.play().catch((e) => {
//         console.warn('[UI] Error playing video after click:', e);
//       });
//     };
//   }
// }
 
// // ---------------- Devices list UI ----------------
// function updateDeviceList(devices) {
//   if (!Array.isArray(devices)) {
//     console.error('Device list is not an array:', devices);
//     return;
//   }
//   lastDeviceList = devices;
 
//   // ✅ Keep the list EMPTY unless the current ID is allowed
//   if (!isAllowedId(XR_ID)) {
//     deviceListElement.innerHTML = '';
//     return;
//   }
 
//   console.log('[DEVICES] Updating device list with', devices.length, 'devices');
//   deviceListElement.innerHTML = '';
 
//   const myId = XR_ID;
//   const peerId = currentPeerId();
 
//   let peerOnline = false;
//   let sameIdCount = 0;
 
//   devices.forEach((device) => {
//     const isSelfId = device.xrId === myId;
//     if (isSelfId) sameIdCount += 1;
 
//     // If we're disconnected, hide our own Desktop entry
//     if (isSelfId && !(socket && socket.connected)) return;
 
//     // Force our own label to Desktop1238 when allowed
//     const name = isSelfId
//       ? (DEVICE_NAME || `Desktop${ALLOWED_ID_NUM}`)
//       : (device.deviceName || device.name || 'Unknown');
 
//     console.log(`[DEVICE] Adding device: ${name} (${device.xrId})`);
//     const li = document.createElement('li');
//     li.textContent = `${name} (${device.xrId})`;
//     deviceListElement.appendChild(li);
 
//     if (device.xrId === peerId) {
//       peerOnline = true;
//     }
//   });
 
//   // Duplicate-tab notice if same XR ID is observed more than once
//   if (sameIdCount > 1 && !duplicateNotified) {
//     addSystemMessage('⚠️ This XR ID is active in another tab/window. Only one desktop should use the same XR ID.');
//     duplicateNotified = true;
//   }
 
//   // 🔷 ROOM: Auto pair when both this tab's XR_ID and its mapped peer are online
//   if (peerOnline && !currentRoom && socket?.connected) {
//     console.log(`[PAIR] Peer (${peerId}) is online — attempting pair`);
//     pairWith(peerId);
//   } else if (!peerOnline) {
//     console.log(`[PAIR] Peer (${peerId}) is not online yet — waiting`);
//   }
// }
 
// // ---------------- Chat send ----------------
// function sendMessage() {
//   const text = (messageInput.value || '').trim();
//   console.log('[CHAT] Sending message:', text);
//   if (!text) {
//     console.log('[CHAT] Empty message - not sending');
//     return;
//   }
 
//   // 🔷 If we have a room, omit 'to' so the server forwards to room members
//   const message = {
//     from: XR_ID,
//     text,
//     urgent: !!urgentCheckbox.checked,
//   };
 
//   if (!currentRoom) {
//     // Fallback to direct-to peer for compatibility
//     message.to = currentPeerId();
//   }
 
//   console.log('[CHAT] Emitting message to server:', message);
//   socket?.emit('message', message);
 
//   addMessageToHistory({
//     ...message,
//     sender: DEVICE_NAME,
//     xrId: XR_ID,
//     timestamp: new Date().toLocaleTimeString(),
//   });
//   messageInput.value = '';
// }
 
// function normalizeMessage(message) {
//   return {
//     text: message?.text || '',
//     sender: message?.sender || message?.from || 'unknown',
//     xrId: message?.xrId || message?.from || 'unknown',
//     timestamp: message?.timestamp || new Date().toLocaleTimeString(),
//     priority:
//       message?.urgent || message?.priority === 'urgent' ? 'urgent' : 'normal',
//   };
// }
 
// function addMessageToHistory(message) {
//   console.log('[CHAT] Adding message to history:', message);
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
//   console.log('[CHAT] Adding to recent messages:', message);
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
//     console.log('[CHAT] Trimming recent messages to 5');
//     recentMessagesDiv.removeChild(recentMessagesDiv.lastChild);
//   }
// }
 
// function addSystemMessage(text) {
//   console.log('[CHAT] Adding system message:', text);
//   const el = document.createElement('div');
//   el.className = 'system-message';
//   el.textContent = text;
//   messageHistoryDiv.appendChild(el);
//   messageHistoryDiv.scrollTop = messageHistoryDiv.scrollHeight;
// }
 
// function clearMessages() {
//   console.log('[CHAT] Clearing messages');
//   socket?.emit('clear-messages', { by: DEVICE_NAME });
//   clearedMessages.clear();
//   recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
//   addSystemMessage(`🧹 Cleared messages locally by ${DEVICE_NAME}`);
// }
 
// // ---------------- Remote control / commands ----------------
// function handleControlCommand(data) {
//   console.log('[CONTROL] Received control command:', data?.command);
//   const command = (data?.command || '').toLowerCase();
 
//   if (!isStreamActive && command !== 'stop_stream') {
//     console.log('[CONTROL] Stream not active - ignoring command');
//     return;
//   }
 
//   switch (command) {
//     case 'mute':
//       console.log('[CONTROL] Executing mute command');
//       if (muteBadge) muteBadge.style.display = 'block';
//       if (videoElement) videoElement.muted = true;
//       break;
//     case 'unmute':
//       console.log('[CONTROL] Executing unmute command');
//       if (muteBadge) muteBadge.style.display = 'none';
//       if (videoElement) {
//         videoElement.muted = false;
//         videoElement.play().catch(() => {});
//       }
//       break;
//     case 'hide_video':
//       console.log('[CONTROL] Executing hide_video command');
//       if (videoOverlay) videoOverlay.style.display = 'flex';
//       if (videoElement) videoElement.style.visibility = 'hidden';
//       break;
//     case 'show_video':
//       console.log('[CONTROL] Executing show_video command');
//       if (videoOverlay) videoOverlay.style.display = 'none';
//       if (videoElement) videoElement.style.visibility = 'visible';
//       break;
//     case 'stop_stream':
//       console.log('[CONTROL] Executing stop_stream command');
//       stopStream();
//       break;
//     default:
//       console.warn('[CONTROL] Unknown command received:', command);
//   }
// }
 
// // ---------------- 🔷 Pairing helper ----------------
// function pairWith(peerId) {
//   console.log('[PAIR] pairWith called for:', peerId);
//   if (!socket || !socket.connected) {
//     console.warn('[PAIR] socket not connected, delaying pairWith call');
//     setTimeout(() => pairWith(peerId), 500);
//     return;
//   }
//   if (!peerId) {
//     console.warn('[PAIR] Missing peerId');
//     return;
//   }
//   console.log('[PAIR] Emitting pair_with for peer:', peerId);
//   socket.emit('pair_with', { peerId });
// }
 
// // ---------------- Event listeners ----------------
// console.log('[INIT] Setting up event listeners');
// sendButton.addEventListener('click', sendMessage);
// messageInput.addEventListener('keypress', (e) => {
//   if (e.key === 'Enter' && !e.shiftKey) {
//     e.preventDefault();
//     sendMessage();
//   }
// });
 
// if (clearMessagesBtn) {
//   clearMessagesBtn.addEventListener('click', clearMessages);
// }
 
// if (openEmulatorBtn) {
//   openEmulatorBtn.addEventListener('click', () => {
//     console.log('[UI] Opening emulator in new window');
//     window.open('http://localhost:3000/display.html', '_blank');
//   });
// }
 
// if (videoOverlay) {
//   videoOverlay.addEventListener('click', () => {
//     console.log('[UI] Video overlay clicked - attempting to play video');
//     videoOverlay.style.display = 'none';
//     videoElement.play().catch((e) => {
//       console.warn('[UI] Error playing video after overlay click:', e);
//     });
//   });
// }
 
// // Manual mode on load: init handlers, then decide whether to auto-connect
// window.addEventListener('load', () => {
//   console.log('[APP] Window loaded - initializing (manual connect + refresh-safe)');
 
//   // Cross-tab presence
//   openPresenceChannel();
//   startPresencePings();
//   announcePresence('idle');
 
//   // Detect if this navigation is a reload (vs brand‑new open)
//   const navEntry = performance.getEntriesByType('navigation')[0];
//   const isReload = navEntry
//     ? navEntry.type === 'reload'
//     // fallback for older browsers
//     : (performance.navigation && performance.navigation.type === 1);
 
//   console.log('[APP] Navigation type -> isReload =', isReload);
 
//   // Initialize socket (handlers only; do not dial yet)
//   initSocket();
 
//   /* (5) Prevent auto-reconnect unless the ID is allowed (updated) */
//   let shouldAuto = false;
//   try {
//     const flag = localStorage.getItem(AUTO_KEY);
//     const inputId = normalizeId(xrIdInput.value) || ALLOWED_ID;
//     // Only auto-connect on reload AND allowed ID (XR-1238)
//     shouldAuto = (flag === '1') && isReload && isAllowedId(inputId);
//     console.log('[AUTO] XR_AUTOCONNECT:', flag, 'inputId:', inputId, ' => shouldAuto:', shouldAuto);
//   } catch (e) {
//     console.warn('[AUTO] Failed to read XR_AUTOCONNECT:', e);
//   }
 
//   if (shouldAuto) {
//     console.log('[APP] Auto-connect enabled for reload — dialing now');
//     // Ensure name matches allowed label
//     DEVICE_NAME = `Desktop${ALLOWED_ID_NUM}`;
//     setStatus('Connecting');
//     if (socket?.io) socket.io.opts.reconnection = true;
//     socket.connect();
//   } else {
//     console.log('[APP] Starting disconnected (cold open or flag off / disallowed ID)');
//     // Normalize flag on cold opens so future loads don't surprise-connect
//     try {
//       if (!isReload) localStorage.setItem(AUTO_KEY, '0');
//     } catch (e) {
//       console.warn('[AUTO] Could not normalize XR_AUTOCONNECT on cold open:', e);
//     }
//     setStatus('Disconnected'); // show red pill initially
//   }
// });
 
// console.log('[INIT] Application initialization complete');

// ====================================================================updated version=======================================================================

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
  videoElement,
  statusElement,
  deviceListElement,
  messageInput,
  sendButton,
  urgentCheckbox,
  recentMessagesDiv,
  messageHistoryDiv,
});

let socket = null;
let peerConnection = null;
let remoteStream = null;
let clearedMessages = new Set();
let pendingIceCandidates = [];
let isStreamActive = false;
let reconnectTimeout = null;
let heartbeatInterval = null;
let lastDeviceList = []; // remember last list we got
let duplicateNotified = false; // notify once per session about duplicate tabs

// 🔷 ROOM: track the private room we’re paired into (if any)
let currentRoom = null;

// 🔒 Sticky autoconnect flag (persist across refresh)
const AUTO_KEY = 'XR_AUTOCONNECT';

/* =========================
   ✅ ID-gating helpers (added)
   ========================= */
const ALLOWED_ID_NUM = '1238';
const ALLOWED_ID     = `XR-${ALLOWED_ID_NUM}`;

function sanitizeIdInput(v) {
  // keep previous placeholder behavior + trimming
  const s = (v || '').trim();
  if (/^Dynamic_ID\(\)$/i.test(s)) return '';
  return s;
}
function normalizeId(v) {
  // accept "1238" or "XR-1238", normalize to "XR-1238"
  const s = sanitizeIdInput(v);
  if (!s) return '';
  if (/^\d+$/.test(s)) return `XR-${s}`;
  const up = s.toUpperCase();
  return up.startsWith('XR-') ? up : s;
}
function isAllowedId(id) {
  return normalizeId(id) === ALLOWED_ID;
}

// 🔄 Fresh-start control
let manualDisconnect = false;     // true only when user clicks Disconnect
let ignoreHistoryOnce = false;    // drop server history just for the next connect
const CLEAR_KEY = 'XR_CLEAR_ON_NEXT_CONNECT'; // '1' => wipe on next connect

// ---------------- CONFIG ----------------
console.log('[CONFIG] Loading configuration');
// Update to your server URL as needed:
// const SERVER_URL = 'https://de4a9df8c9ab.ngrok-free.app';
const SERVER_URL = 'https://xr-messaging-geexbheshbghhab7.centralindia-01.azurewebsites.net';

/* ------------- XR_ID / NAME init (updated) ------------- */
// XR ID is editable from the front-end before connecting
let XR_ID = normalizeId(xrIdInput.value) || ALLOWED_ID;  // default to XR-1238
// Make device name mutable so we can force "Desktop1238"
let DEVICE_NAME = (usernameInput.value || '').trim() || 'Desktop';
// If the initial value is already allowed, label as Desktop1238
if (isAllowedId(XR_ID)) {
  DEVICE_NAME = `Desktop${ALLOWED_ID_NUM}`;
}

console.log('[CONFIG] Server URL:', SERVER_URL);
console.log('[CONFIG] XR ID (initial):', XR_ID);
console.log('[CONFIG] Device Name:', DEVICE_NAME);

// Peer-ID mapping: map Desktop XR_ID -> its Android peer ID.
// Customize this logic if you have a different mapping scheme.
function mapPeerId(desktopId) {
  // Example mapping rule:
  // - If you want a specific pair, return that here.
  // - Currently we map all desktop IDs to XR-1234 (the Android).
  return 'XR-1234';
}
function currentPeerId() {
  return mapPeerId(XR_ID);
}

/* =========================
   📣 Cross‑tab presence (duplicate guard)
   ========================= */
const TAB_ID = Math.random().toString(36).slice(2);
let presenceChan = null;
let duplicateActive = false;
let presencePingInterval = null;

function openPresenceChannel() {
  if (presenceChan) try { presenceChan.close(); } catch {}
  presenceChan = new BroadcastChannel('xr-presence');

  presenceChan.onmessage = (e) => {
    const msg = e.data || {};
    // ignore self
    if (msg.tabId === TAB_ID) return;

    // only care about our target ID (XR-1238)
    if (!isAllowedId(msg.xrId)) return;

    if (msg.type === 'who') {
      // another tab is probing: answer with our state
      presenceChan.postMessage({
        type: 'presence',
        xrId: XR_ID,
        tabId: TAB_ID,
        state: socket?.connected ? 'connected' : 'idle',
      });
    } else if (msg.type === 'presence') {
      // we received another tab's presence; if it's connected on the same allowed ID, flag duplicate
      if (msg.state === 'connected') {
        duplicateActive = true;
      }
    }
  };
}

function announcePresence(state = (socket?.connected ? 'connected' : 'idle')) {
  presenceChan?.postMessage({
    type: 'presence',
    xrId: XR_ID,
    tabId: TAB_ID,
    state,
  });
}

function startPresencePings() {
  if (presencePingInterval) clearInterval(presencePingInterval);
  presencePingInterval = setInterval(() => {
    announcePresence(socket?.connected ? 'connected' : 'idle');
  }, 4000);
}

function stopPresencePings() {
  if (presencePingInterval) {
    clearInterval(presencePingInterval);
    presencePingInterval = null;
  }
}

/* ------------- XR ID change listener (updated) ------------- */
xrIdInput.addEventListener('change', () => {
  const newId = normalizeId(xrIdInput.value);
  XR_ID = newId || ALLOWED_ID;

  if (!isAllowedId(XR_ID)) {
    // Reset label and hide device list if disallowed
    DEVICE_NAME = 'Desktop';
    deviceListElement.innerHTML = '';
    addSystemMessage(`❌ Only ID ${ALLOWED_ID} can connect. You entered "${newId || '(empty)'}".`);
    // If connected with a different ID somehow, drop it.
    if (socket?.connected) {
      try { localStorage.setItem(AUTO_KEY, '0'); } catch {}
      socket.disconnect();
    }
    setStatus('Disconnected');
    announcePresence('idle');
    return;
  }

  // Allowed: set display name and optionally auto-connect once
  DEVICE_NAME = `Desktop${ALLOWED_ID_NUM}`;
  addSystemMessage(`✅ ID set to ${XR_ID}. Connecting…`);
  if (!socket) initSocket();
  if (!socket.connected) {
    setStatus('Connecting');
    if (socket?.io) socket.io.opts.reconnection = true;
    try { localStorage.setItem(AUTO_KEY, '1'); } catch {}
    socket.connect();
  }
});

// ---------------- Status pill ----------------
function setStatus(status) {
  console.log('[STATUS] Updating status to:', status);
  statusElement.textContent = status;
  statusElement.classList.remove('bg-yellow-500', 'bg-green-500', 'bg-red-600');
  switch ((status || '').toLowerCase()) {
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

// ---- Heartbeat helpers ----
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

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log('[HEARTBEAT] Stopped heartbeat');
  }
}

// ---------------- Helpers ----------------
function wipeLocalMessages(reason = '') {
  try {
    console.log('[CHAT] Wiping local messages', reason ? `(${reason})` : '');
    if (messageHistoryDiv) messageHistoryDiv.innerHTML = '';
    if (recentMessagesDiv) recentMessagesDiv.innerHTML = '';
    clearedMessages = new Set();
  } catch (e) {
    console.warn('[CHAT] wipeLocalMessages failed:', e);
  }
}

// ---------------- Manual init (no auto-connect) ----------------
function initSocket() {
  if (socket) return; // init once
  console.log('[SOCKET] Initializing Socket.IO client (manual connect mode)');
  setStatus('Disconnected');

  socket = io(SERVER_URL, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    secure: true,
    autoConnect: false, // 🔴 start DISCONNECTED; we control dial
  });

  // --- lifecycle events ---
  socket.on('connect', () => {
    // 🔐 Block accidental connects if ID isn't allowed OR a duplicate tab is active
    duplicateActive = false;
    presenceChan?.postMessage({ type: 'who', xrId: XR_ID, tabId: TAB_ID });

    // Defer the rest of the connect flow until presence check returns
    setTimeout(() => {
      if (!isAllowedId(XR_ID) || duplicateActive) {
        console.warn('[SOCKET] Disallowed or duplicate detected; disconnecting.');
        addSystemMessage(!isAllowedId(XR_ID)
          ? `❌ Only ${ALLOWED_ID} may connect. Disconnecting…`
          : '⚠️ This XR ID is already active in another tab/window. Disconnecting…');
        try { localStorage.setItem(AUTO_KEY, '0'); } catch {}
        if (socket?.io) socket.io.opts.reconnection = false;
        socket.disconnect();
        setStatus('Disconnected');
        announcePresence('idle');
        return;
      }

      console.log('[SOCKET] ✅ Connected');

      // If previous session requested a fresh start, wipe now and ignore server history once
      try {
        if (localStorage.getItem(CLEAR_KEY) === '1') {
          wipeLocalMessages('fresh connect (CLEAR_KEY=1)');
          ignoreHistoryOnce = true;                   // drop upcoming message_history once
          localStorage.setItem(CLEAR_KEY, '0');       // consume the flag
        }
      } catch (e) {
        console.warn('[CLEAR] Failed to read/clear CLEAR_KEY:', e);
      }

      setStatus('Connected');

      // keep refresh-safe autoconnect behavior
      try { localStorage.setItem(AUTO_KEY, '1'); } catch {}

      const payload = { deviceName: DEVICE_NAME, xrId: XR_ID };
      console.log('[SOCKET] Emitting identify + request_device_list', payload);
      socket.emit('identify', payload);
      socket.emit('request_device_list');

      console.log('[PAIR] Attempt pairWith on connect');
      pairWith(currentPeerId());

      if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
      startHeartbeat();
      announcePresence('connected');
    }, 250);
  });

  socket.io.on('reconnect', (attempt) => {
    console.log('[SOCKET] 🔄 Reconnected. attempt=', attempt);
    const payload = { deviceName: DEVICE_NAME, xrId: XR_ID };
    socket.emit('identify', payload);
    socket.emit('request_device_list');

    // On reconnect, try to re-pair if room was lost
    if (!currentRoom) {
      console.log('[PAIR] No currentRoom on reconnect — re-pairing');
      pairWith(currentPeerId());
    }

    startHeartbeat();
    announcePresence('connected');
  });

  socket.on('connect_error', (err) => {
    console.warn('[SOCKET] connect_error:', err?.message || err);
    setStatus('Disconnected');
    stopHeartbeat();
    announcePresence('idle');
  });

  socket.on('disconnect', (reason) => {
    console.warn('[SOCKET] disconnected:', reason);
    setStatus('Disconnected');
    stopHeartbeat();

    if (manualDisconnect) {
      // Already wiped in toggleConnection(); nothing extra here
      console.log('[SOCKET] Manual disconnect completed');
    } else {
      console.log('[SOCKET] Non-manual disconnect (e.g., refresh or network) — preserving messages');
    }

    currentRoom = null; // we’ll re-pair on next connect if needed
    manualDisconnect = false; // reset the latch

    // do not clear AUTO_KEY; preserves refresh auto-connect if enabled
    updateDeviceList(lastDeviceList);
    announcePresence('idle');
  });

  socket.on('error', (data) => {
    // If the server warns about duplicate desktops, surface that to the UI
    if (data?.message?.includes('Duplicate desktop')) {
      console.warn('[SOCKET] Duplicate desktop notice from server:', data.message);
      addSystemMessage('⚠️ This XR ID is already active in another tab/window.');
    }
  });

  // --- your existing handlers ---
  socket.on('signal', handleSignalMessage);
  socket.on('message', handleChatMessage);
  socket.on('device_list', updateDeviceList);
  socket.on('control', handleControlCommand);
  socket.on('message-cleared', handleMessagesCleared);
  socket.on('message_history', handleMessageHistory);

  // --- 🔷 ROOM events ---
  socket.on('pair_error', ({ message }) => {
    console.warn('[PAIR] pair_error:', message);
    addSystemMessage(`Pair error: ${message}`);
  });

  socket.on('room_joined', ({ roomId, members }) => {
    console.log('[PAIR] room_joined:', roomId, members);
    currentRoom = roomId;
    addSystemMessage(`🎯 VR Room created: ${roomId}. Members: ${members.join(', ')}`);
  });

  socket.on('peer_left', ({ xrId, roomId }) => {
    console.log('[PAIR] peer_left', xrId, roomId);
    if (currentRoom === roomId) {
      addSystemMessage(`${xrId} left the room.`);
      currentRoom = null; // ensure we don’t keep signaling into an empty room
      stopStream();
    }
  });
}

// ---------------- Clickable status pill: Connect/Disconnect ----------------
function toggleConnection() {
  if (!socket) initSocket();

  // Always read the latest input
  XR_ID = normalizeId(xrIdInput.value) || ALLOWED_ID;

  if (socket.connected) {
    console.log('[SOCKET] Manual disconnect requested');
    manualDisconnect = true;                 // mark user-initiated
    try {
      localStorage.setItem(AUTO_KEY, '0');   // block future auto-connects
    } catch {}
    // Hard-disable reconnection until user explicitly connects
    if (socket?.io) socket.io.opts.reconnection = false;

    wipeLocalMessages('manual disconnect');
    socket.disconnect();
    setStatus('Disconnected');
    announcePresence('idle');
    return;
  }

  // Not connected -> only allow connecting if ID is exactly XR-1238
  if (!isAllowedId(XR_ID)) {
    addSystemMessage(`❌ Connecting blocked. Enter "${ALLOWED_ID_NUM}" (or "${ALLOWED_ID}") first.`);
    try { localStorage.setItem(AUTO_KEY, '0'); } catch {}
    setStatus('Disconnected');
    announcePresence('idle');
    return;
  }

  // 🔎 Probe other tabs for duplicates before connecting
  duplicateActive = false;
  presenceChan?.postMessage({ type: 'who', xrId: XR_ID, tabId: TAB_ID });

  setStatus('Checking…');
  setTimeout(() => {
    if (duplicateActive) {
      addSystemMessage('⚠️ This XR ID is already active in another tab/window.');
      try { localStorage.setItem(AUTO_KEY, '0'); } catch {}
      setStatus('Disconnected');
      announcePresence('idle');
      return;
    }

    console.log('[SOCKET] Manual connect requested with allowed ID:', XR_ID);
    // Re-enable reconnection for active sessions
    if (socket?.io) socket.io.opts.reconnection = true;

    setStatus('Connecting');
    try { localStorage.setItem(AUTO_KEY, '1'); } catch {}
    socket.connect();
  }, 300); // small window to receive presence replies
}

// Make the status chip clickable
statusElement.style.cursor = 'pointer';
statusElement.title = 'Click to connect / disconnect';
statusElement.addEventListener('click', toggleConnection);

// Ensure refresh keeps autoconnect if currently connected
window.addEventListener('beforeunload', () => {
  try {
    if (socket?.connected) {
      localStorage.setItem(AUTO_KEY, '1');
      console.log('[AUTO] beforeunload: XR_AUTOCONNECT kept as 1');
    }
  } catch (e) {
    console.warn('[AUTO] beforeunload: failed to persist XR_AUTOCONNECT:', e);
  }
});

// ---------------- WebRTC & Messaging ----------------
function handleSignalMessage(data) {
  console.log('[SIGNAL] Received signal message:', data?.type);
  switch (data?.type) {
    case 'offer':
      console.log('[WEBRTC] 📞 Received offer from peer');
      // Server relays payload as { type, from, data }
      handleOffer(data.data);
      break;
    case 'ice-candidate':
      console.log('[WEBRTC] ❄️ Received ICE candidate from peer');
      handleRemoteIceCandidate(data.data);
      break;
    case 'answer':
      // Desktop typically sends answers, but log for completeness
      console.log('[WEBRTC] Received answer (unexpected for desktop) – ignoring');
      break;
    default:
      console.log('[WEBRTC] Unhandled signal type:', data?.type);
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
  if (ignoreHistoryOnce) {
    console.log('[CHAT] Dropping server message_history once for fresh start');
    ignoreHistoryOnce = false;  // consume the one-time ignore
    return;
  }
  console.log('[CHAT] Received message history with', (data?.messages || []).length, 'messages');
  (data?.messages || []).forEach((msg) => {
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
    { urls: 'stun:stun4.l.google.com:19302' },
  ];

  if (turnConfig.urls && turnConfig.username && turnConfig.credential) {
    iceServers.push({
      urls: turnConfig.urls,
      username: turnConfig.username,
      credential: turnConfig.credential,
    });
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
    if (!remoteStream.getTracks().some((t) => t.id === event.track.id)) {
      console.log('[WEBRTC] Adding track to remote stream');
      remoteStream.addTrack(event.track);
    }
    videoElement.play().catch((e) => {
      if (e && e.name === 'AbortError') {
        console.debug('[WEBRTC] play() aborted (teardown race) — safe to ignore');
      } else {
        console.warn('[WEBRTC] Video play error:', e);
        showClickToPlayOverlay();
      }
    });
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('[WEBRTC] Generated ICE candidate:', event.candidate);
      // 🔷 Prefer room forwarding (omit 'to' when joined)
      const payload = {
        type: 'ice-candidate',
        from: XR_ID,
        data: event.candidate,
      };
      if (!currentRoom) {
        // Fallback to direct-to behavior for compatibility
        payload.to = currentPeerId();
      }
      console.log('[WEBRTC] Emitting signal (ice-candidate):', payload);
      socket?.emit('signal', payload);
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
      // eslint-disable-next-line no-await-in-loop
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

    // 🔷 Prefer room forwarding: omit 'to' if currentRoom exists
    const payload = {
      type: 'answer',
      from: XR_ID,
      data: peerConnection.localDescription,
    };
    if (!currentRoom) {
      payload.to = currentPeerId();
    }
    console.log('[WEBRTC] Emitting signal (answer):', payload);
    socket?.emit('signal', payload);
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
    try {
      videoElement.pause();
    } catch (e) {}
    videoElement.srcObject = null;
    videoElement.removeAttribute('src');
    try {
      videoElement.load();
    } catch (e) {}
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
    try {
      peerConnection.close();
    } catch (e) {
      console.warn('[STREAM] Error closing peer connection:', e);
    }
    peerConnection = null;
  }

  if (remoteStream) {
    console.log('[STREAM] Stopping remote stream tracks');
    remoteStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (e) {
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
  const btn = document.getElementById('clickToPlayBtn');
  if (btn) {
    btn.onclick = () => {
      console.log('[UI] Click-to-play button clicked');
      videoOverlay.style.display = 'none';
      videoElement.play().catch((e) => {
        console.warn('[UI] Error playing video after click:', e);
      });
    };
  }
}

// ---------------- Devices list UI ----------------
function updateDeviceList(devices) {
  if (!Array.isArray(devices)) {
    console.error('Device list is not an array:', devices);
    return;
  }
  lastDeviceList = devices;

  // ✅ Keep the list EMPTY unless the current ID is allowed
  if (!isAllowedId(XR_ID)) {
    deviceListElement.innerHTML = '';
    return;
  }

  console.log('[DEVICES] Updating device list with', devices.length, 'devices');
  deviceListElement.innerHTML = '';

  const myId = XR_ID;
  const peerId = currentPeerId();

  let peerOnline = false;
  let sameIdCount = 0;

  devices.forEach((device) => {
    const isSelfId = device.xrId === myId;
    if (isSelfId) sameIdCount += 1;

    // If we're disconnected, hide our own Desktop entry
    if (isSelfId && !(socket && socket.connected)) return;

    // Force our own label to Desktop1238 when allowed
    const name = isSelfId
      ? (DEVICE_NAME || `Desktop${ALLOWED_ID_NUM}`)
      : (device.deviceName || device.name || 'Unknown');

    console.log(`[DEVICE] Adding device: ${name} (${device.xrId})`);
    const li = document.createElement('li');
    li.textContent = `${name} (${device.xrId})`;
    deviceListElement.appendChild(li);

    if (device.xrId === peerId) {
      peerOnline = true;
    }
  });

  // Duplicate-tab notice if same XR ID is observed more than once
  if (sameIdCount > 1 && !duplicateNotified) {
    addSystemMessage('⚠️ This XR ID is active in another tab/window. Only one desktop should use the same XR ID.');
    duplicateNotified = true;
  }

  // 🔷 ROOM: Auto pair when both this tab's XR_ID and its mapped peer are online
  if (peerOnline && !currentRoom && socket?.connected) {
    console.log(`[PAIR] Peer (${peerId}) is online — attempting pair`);
    pairWith(peerId);
  } else if (!peerOnline) {
    console.log(`[PAIR] Peer (${peerId}) is not online yet — waiting`);
  }
}

// ---------------- Chat send ----------------
function sendMessage() {
  const text = (messageInput.value || '').trim();
  console.log('[CHAT] Sending message:', text);
  if (!text) {
    console.log('[CHAT] Empty message - not sending');
    return;
  }

  // 🔷 If we have a room, omit 'to' so the server forwards to room members
  const message = {
    from: XR_ID,
    text,
    urgent: !!urgentCheckbox.checked,
  };

  if (!currentRoom) {
    // Fallback to direct-to peer for compatibility
    message.to = currentPeerId();
  }

  console.log('[CHAT] Emitting message to server:', message);
  socket?.emit('message', message);

  addMessageToHistory({
    ...message,
    sender: DEVICE_NAME,
    xrId: XR_ID,
    timestamp: new Date().toLocaleTimeString(),
  });
  messageInput.value = '';
}

function normalizeMessage(message) {
  return {
    text: message?.text || '',
    sender: message?.sender || message?.from || 'unknown',
    xrId: message?.xrId || message?.from || 'unknown',
    timestamp: message?.timestamp || new Date().toLocaleTimeString(),
    priority:
      message?.urgent || message?.priority === 'urgent' ? 'urgent' : 'normal',
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

/* =========================
   🔔 WebRTC offer helpers (NEW)
   ========================= */
function requestOfferFromPeer() {
  const to = currentPeerId();
  if (!socket?.connected || !to) {
    console.warn('[CONTROL] Cannot request_offer: socket connected?', !!socket?.connected, 'peer=', to);
    return;
  }
  console.log('[CONTROL] Requesting SDP offer from peer:', to);
  socket.emit('control', { to, command: 'request_offer' });
}

function ensurePeerReadyThenRequestOffer() {
  if (!peerConnection) {
    console.log('[CONTROL] No RTCPeerConnection; creating before request_offer');
    peerConnection = createPeerConnection();
  }
  requestOfferFromPeer();
}

// ---------------- Remote control / commands ----------------
function handleControlCommand(data) {
  console.log('[CONTROL] Received control command:', data?.command);
  const command = (data?.command || '').toLowerCase();

  // allow start_stream (and request_offer) even if stream is not yet active
  if (!isStreamActive && !['start_stream', 'request_offer', 'stop_stream'].includes(command)) {
    console.log('[CONTROL] Stream not active - ignoring command:', command);
    return;
  }

  switch (command) {
    case 'start_stream':
      console.log('[CONTROL] Executing start_stream command');
      addSystemMessage('🎥 Start stream requested');
      ensurePeerReadyThenRequestOffer();  // prepare PC and ask peer to send an SDP offer
      break;

    case 'request_offer': // optional round‑trip support if peer asks us to prompt again
      console.log('[CONTROL] Executing request_offer');
      ensurePeerReadyThenRequestOffer();
      break;

    case 'mute':
      console.log('[CONTROL] Executing mute command');
      if (muteBadge) muteBadge.style.display = 'block';
      if (videoElement) videoElement.muted = true;
      break;
    case 'unmute':
      console.log('[CONTROL] Executing unmute command');
      if (muteBadge) muteBadge.style.display = 'none';
      if (videoElement) {
        videoElement.muted = false;
        videoElement.play().catch(() => {});
      }
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

// ---------------- 🔷 Pairing helper ----------------
// function pairWith(peerId) {
//   console.log('[PAIR] pairWith called for:', peerId);
//   if (!socket || !socket.connected) {
//     console.warn('[PAIR] socket not connected, delaying pairWith call');
//     setTimeout(() => pairWith(peerId), 500);
//     return;
//   }
//   if (!peerId) {
//     console.warn('[PAIR] Missing peerId');
//     return;
//   }
//   console.log('[PAIR] Emitting pair_with for peer:', peerId);
//   socket.emit('pair_with', { peerId });
// }


// replace your current pairWith with this
function pairWith(peerId) {
  console.log('[PAIR] pairWith called for:', peerId);
  if (!peerId) {
    console.warn('[PAIR] Missing peerId');
    return;
  }
  const doEmit = () => {
    console.log('[PAIR] Emitting pair_with for peer:', peerId);
    socket.emit('pair_with', { peerId });
  };
  if (socket?.connected) {
    doEmit();
  } else if (socket) {
    console.warn('[PAIR] socket not connected, waiting for connect to pair');
    socket.once('connect', doEmit); // one-shot; no recursive timers
  } else {
    console.warn('[PAIR] socket is null; init then call pairWith again after connect');
  }
}

// ---------------- Event listeners ----------------
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
    videoElement.play().catch((e) => {
      console.warn('[UI] Error playing video after overlay click:', e);
    });
  });
}

// Manual mode on load: init handlers, then decide whether to auto-connect
window.addEventListener('load', () => {
  console.log('[APP] Window loaded - initializing (manual connect + refresh-safe)');

  // Cross-tab presence
  openPresenceChannel();
  startPresencePings();
  announcePresence('idle');

  // Detect if this navigation is a reload (vs brand‑new open)
  const navEntry = performance.getEntriesByType('navigation')[0];
  const isReload = navEntry
    ? navEntry.type === 'reload'
    // fallback for older browsers
    : (performance.navigation && performance.navigation.type === 1);

  console.log('[APP] Navigation type -> isReload =', isReload);

  // Initialize socket (handlers only; do not dial yet)
  initSocket();

  /* (5) Prevent auto-reconnect unless the ID is allowed (updated) */
  let shouldAuto = false;
  try {
    const flag = localStorage.getItem(AUTO_KEY);
    const inputId = normalizeId(xrIdInput.value) || ALLOWED_ID;
    // Only auto-connect on reload AND allowed ID (XR-1238)
    shouldAuto = (flag === '1') && isReload && isAllowedId(inputId);
    console.log('[AUTO] XR_AUTOCONNECT:', flag, 'inputId:', inputId, ' => shouldAuto:', shouldAuto);
  } catch (e) {
    console.warn('[AUTO] Failed to read XR_AUTOCONNECT:', e);
  }

  if (shouldAuto) {
    console.log('[APP] Auto-connect enabled for reload — dialing now');
    // Ensure name matches allowed label
    DEVICE_NAME = `Desktop${ALLOWED_ID_NUM}`;
    setStatus('Connecting');
    if (socket?.io) socket.io.opts.reconnection = true;
    socket.connect();
  } else {
    console.log('[APP] Starting disconnected (cold open or flag off / disallowed ID)');
    // Normalize flag on cold opens so future loads don't surprise-connect
    try {
      if (!isReload) localStorage.setItem(AUTO_KEY, '0');
    } catch (e) {
      console.warn('[AUTO] Could not normalize XR_AUTOCONNECT on cold open:', e);
    }
    setStatus('Disconnected'); // show red pill initially
  }
});

console.log('[INIT] Application initialization complete');

