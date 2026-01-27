// -------------------------------------------------- scribe-cockpit.js --------------------------------------------------
// Scribe cockpit with precise, persistent per-textbox edit tracking vs AI baseline,
// and device-based status pill logic.
//
// INCREMENTAL, PERSISTENT EDIT LOGIC
// - On every input, we diff PREV -> NOW (insert/delete only via LCS).
// - Insertions: +N (new chars tagged 'U' = user).
// - Deletions of 'B' (baseline/AI chars): +N.
// - Deletions of 'U' (user-added chars): -N (refund).
// - Substitutions = delete + insert at the caret (counts both).
// - Edits accumulate and are saved in localStorage per section.
// - Provenance (char tags) is stored as RLE of 'B'/'U' and restored after refresh.
//
// DEVICE STATUS PILL LOGIC
// - 2 or more devices online: "Connected" (green)
// - Exactly 1 device online: "Connecting" (yellow)
// - 0 devices: "Disconnected" (red)
//
// Medication availability UX (UPDATED):
// - Uses animated emojis: ✅ available, ❌ unavailable, ⏳ pending.
// - Persists results in localStorage and restores on refresh without re-calling the API.
// - Calls API ONLY when Medication textarea content changes (vs last validated text).
//
// Workflow/UI preserved:
// - Global "Total Edits" badge on first SOAP heading.
// - "Add To EHR" always disabled (red).
// - Clear / Save / Add EHR zero visible counters and REBASE provenance to current text (all 'B').

console.log('[SCRIBE] Booting Scribe Cockpit (incremental + persistent edit tracking + device-aware status + emoji meds)');

// ==========================
// DOM elements
// ==========================
const statusPill = document.getElementById('statusPill');
const deviceListEl = document.getElementById('deviceList');
const transcriptEl = document.getElementById('liveTranscript');
let soapHost = document.getElementById('soapNotePanel');

// Action buttons live in HTML (per your structure)
const clearBtnEl = document.getElementById('_scribe_clear');
const saveBtnEl = document.getElementById('_scribe_save');
const addEhrBtnEl = document.getElementById('_scribe_add_ehr');
const XR_DOCK_SCREEN_ID = 2;

// ==========================
// XR Dock / Scribe Cockpit permissions (READ vs WRITE)
// ==========================
let xrDockPermissions = null;  // { read, write, edit, delete } or null (fail-open)

/**
 * Load the logged-in user's rights for this screen from /api/platform/my-screens.
 * We try to match by route_path first ("/scribe-cockpit"), then by screen_name
 * containing "xr dock" or "scribe cockpit".
 */
async function loadDockPermissions() {
  try {
    const res = await fetch('/api/platform/my-screens', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    const data = await res.json();
    const screens = data?.screens || [];

    const match = screens.find(s => s.id === XR_DOCK_SCREEN_ID);

    if (!match) {
      console.warn("[SCRIBE] XR Dock screen ID not found, defaulting to unrestricted");
      xrDockPermissions = null;
      return;
    }

    xrDockPermissions = {
      read: !!match.read,
      write: !!match.write,
      edit: !!match.edit,
      delete: !!match.delete
    };

    console.log("[SCRIBE] XR Dock permissions:", xrDockPermissions);

  } catch (e) {
    console.warn("[SCRIBE] loadDockPermissions failed:", e);
    xrDockPermissions = null;
  }
}


/** True if user is allowed to write on this screen. If permissions missing, don't block. */
function hasScribeWritePermission() {
  if (!xrDockPermissions) return true;   // keep existing behaviour if we couldn't load
  return !!xrDockPermissions.write;
}

/** Show same style of message as Create User when user is READ-only. */
function notifyReadOnlyScribe() {
  const msg = 'You only have READ permission for XR Dock. Editing is not allowed.';
  if (typeof showToast === 'function') {
    showToast(msg, 'error');
  } else {
    try { alert(msg); } catch { console.warn(msg); }
  }
}

/** Lock UI for READ-only users: make SOAP boxes read-only and disable buttons. */
function applyScribeReadOnlyUI() {
  if (!xrDockPermissions || xrDockPermissions.write) return; // nothing to lock

  console.log('[SCRIBE] Applying read-only UI for XR Dock / Scribe Cockpit');

  const scroller = soapContainerEnsure();
  const editors = scroller.querySelectorAll('textarea[data-section]');
  editors.forEach(t => {
    t.readOnly = true;
    t.classList.add('scribe-readonly');
  });

  if (clearBtnEl) clearBtnEl.disabled = true;
  if (saveBtnEl) saveBtnEl.disabled = true;
  if (addEhrBtnEl) addEhrBtnEl.disabled = true;
}


if (!soapHost) {
  console.warn('[SCRIBE] soapNotePanel not found, creating dynamically');
  soapHost = document.createElement('div');
  soapHost.id = 'soapNotePanel';
  soapHost.className = 'flex-1 min-h-0';
  document.body.appendChild(soapHost);
}

// ==========================
// Constants & State
// ==========================
const PLACEHOLDER_ID = 'scribe-transcript-placeholder';
const MAX_TRANSCRIPT_LINES = 300;
function roomLS(base) {
  // room-scoped keys; fallback keeps behavior before pairing
  const r = currentRoom || '__noroom__';
  return `scribe:${r}:${base}`;
}

const LS_KEYS = {
  HISTORY: () => roomLS('history'),
  LATEST_SOAP: () => roomLS('latestSoap'),
  ACTIVE_ITEM_ID: () => roomLS('activeItem'),
  MED_AVAIL: () => roomLS('medAvailability'),
};


const NGROK_URL = 'http://localhost:8080';
const AZURE_URL = 'https://xr-messaging-geexbheshbghhab7.centralindia-01.azurewebsites.net';
const OVERRIDES = Array.isArray(window.SCRIBE_PUBLIC_ENDPOINTS) ? window.SCRIBE_PUBLIC_ENDPOINTS : null;

const NGROK = (OVERRIDES?.[0] || NGROK_URL).replace(/\/$/, '');
const AZURE = (OVERRIDES?.[1] || AZURE_URL).replace(/\/$/, '');
const host = location.hostname;
const isLocal = location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local') ||
  /^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
const preferred = isLocal ? NGROK : AZURE;
const fallback = isLocal ? AZURE : NGROK;

let SERVER_URL = null;
let socket = null;



// In-memory UI state
let latestSoapNote = {};                   // last received/edited SOAP payload
const transcriptState = { byKey: {} };     // merges partial transcript chunks per (from->to)
let soapNoteTimer = null;
let soapNoteStartTime = null;
let currentActiveItemId = null;
let soapGenerating = false;

// Global "Total Edits" badge node
let totalEditsBadgeEl = null

// Per-textarea incremental state (provenance + counters), kept at runtime;
// persisted into latestSoapNote._editMeta on every change.
const editStateMap = new WeakMap();
/*
  For each <textarea>:
  {
    ann: Array<{ch: string, tag: 'B'|'U'}>,
    ins: number,
    del: number
  }
*/

// ==========================
// BroadcastChannels (optional multi-tab sync)
// ==========================
const transcriptBC = new BroadcastChannel('scribe-transcript');
const soapBC = new BroadcastChannel('scribe-soap-note');

// ==========================
// localStorage helpers
// ==========================
function lsSafeParse(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function saveHistory(arr) { localStorage.setItem(LS_KEYS.HISTORY(), JSON.stringify(arr || [])); }
function loadHistory() { return lsSafeParse(LS_KEYS.HISTORY(), []); }

function saveLatestSoap(soap) { localStorage.setItem(LS_KEYS.LATEST_SOAP(), JSON.stringify(soap || {})); }
function loadLatestSoap() { return lsSafeParse(LS_KEYS.LATEST_SOAP(), {}); }

function saveActiveItemId(id) { localStorage.setItem(LS_KEYS.ACTIVE_ITEM_ID(), id || ''); }
function loadActiveItemId() { return localStorage.getItem(LS_KEYS.ACTIVE_ITEM_ID()) || ''; }

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// Medication availability persistence
function saveMedStatus(byName, lastText) {
  const payload = { byName: byName || {}, lastText: lastText || '' };
  localStorage.setItem(LS_KEYS.MED_AVAIL(), JSON.stringify(payload));
}
function loadMedStatus() {
  const { byName = {}, lastText = '' } =
    lsSafeParse(LS_KEYS.MED_AVAIL(), { byName: {}, lastText: '' }) || {};
  return { byName, lastText };
}


// ==========================
// Status pill
// ==========================
function setStatus(status) {
  if (!statusPill) return;
  statusPill.textContent = status;
  statusPill.setAttribute('aria-label', `Connection status: ${status}`);
  statusPill.classList.remove('bg-yellow-500', 'bg-green-500', 'bg-red-600');
  switch ((status || '').toLowerCase()) {
    case 'connected': statusPill.classList.add('bg-green-500'); break;
    case 'disconnected': statusPill.classList.add('bg-red-600'); break;
    default: statusPill.classList.add('bg-yellow-500'); // 'connecting' or anything else
  }
}

// ==========================
// Devices list + device-aware status

let currentRoom = null; // cockpit view-only room, set from room_joined

let COCKPIT_FOR_XR_ID = null; // client-known xrId (from /api/platform/me)

// --- cockpit request_device_list throttling (prevents server log "shake") ---
let _reqListTimer = null;
let _lastReqListAt = 0;

function requestDeviceListThrottled(why) {
  const now = Date.now();

  // If we’re not in a room yet, throttle harder (pairing phase)
  const minGapMs = currentRoom ? 250 : 1200;

  if (now - _lastReqListAt < minGapMs) {
    console.debug('[COCKPIT][REQ_LIST] throttled', { why, currentRoom, sinceMs: now - _lastReqListAt });
    return;
  }

  if (_reqListTimer) return;
  _reqListTimer = setTimeout(() => {
    _reqListTimer = null;
    _lastReqListAt = Date.now();

    if (!socket?.connected) return;
    try {
      socket.emit('request_device_list');
      console.debug('[COCKPIT][REQ_LIST] sent', { why, currentRoom, socketId: socket.id });
    } catch (e) {
      console.warn('[COCKPIT][REQ_LIST] emit failed', { why, e });
    }
  }, 50);
}


let _lastDeviceListSig = null;


function updateConnectionStatus(src = '') {
  const connected = !!(socket && socket.connected);
  const status =
    !connected ? 'Disconnected' :
      !currentRoom ? 'Connecting' :
        'Connected';

  console.log('[COCKPIT][STATUS]', { src, connected, currentRoom, status });
  setStatus(status);
}

// ==========================
function showNoDevices() {
  if (!deviceListEl) return;
  deviceListEl.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'text-gray-400';
  li.textContent = 'No devices online';
  deviceListEl.appendChild(li);
}

/**
 * Update the device list UI and set the status pill strictly by device count:
 * - 2+ devices  -> Connected (green)
 * - 1 device    -> Connecting (yellow)
 * - 0 devices   -> Disconnected (red)
 */
function updateDeviceList(devices) {
  // ✅ Server is authoritative — never trust cached UI state
  if (!Array.isArray(devices)) devices = [];

  // 🔥 Always clear first (prevents stale XR-8005)
  deviceListEl.innerHTML = '';

  // ✅ Empty is allowed (cockpit may be unpaired or joining). Render it, but never drive status by count.
  if (devices.length === 0) {
    showNoDevices();
  } else {
    devices.forEach(d => {
      if (!d || !d.xrId) return;
      const name = d.deviceName || `Device (${d.xrId})`;
      const li = document.createElement('li');
      li.className = 'text-gray-300';
      li.textContent = `${name} (${d.xrId})`;
      deviceListEl.appendChild(li);
    });
  }

  // ✅ Status rule: socket + room only (never device count)
  console.log('[COCKPIT][DEVICES] render', {
    count: devices.length,
    xrIds: devices.map(d => d?.xrId).filter(Boolean),
    currentRoom
  });
  updateConnectionStatus('device_list');

}



// ==========================
// Transcript helpers
// ==========================
function transcriptKey(from, to) { return `${from || 'unknown'}->${to || 'unknown'}`; }

function mergeIncremental(prev, next) {
  if (!prev) return next || '';
  if (!next) return prev;
  if (next.startsWith(prev)) return next;
  if (prev.startsWith(next)) return prev;
  let k = Math.min(prev.length, next.length);
  while (k > 0 && !prev.endsWith(next.slice(0, k))) k--;
  return prev + next.slice(k);
}

function ensureTranscriptPlaceholder() {
  if (!transcriptEl) return;
  if (!document.getElementById(PLACEHOLDER_ID)) {
    const ph = document.createElement('p');
    ph.id = PLACEHOLDER_ID;
    ph.className = 'text-gray-400 italic';
    ph.textContent = 'No transcript yet…';
    transcriptEl.appendChild(ph);
  }
}
function removeTranscriptPlaceholder() {
  const ph = document.getElementById(PLACEHOLDER_ID);
  if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
}

function createTranscriptCard(item) {
  const { id, from, to, text, timestamp } = item;
  const card = document.createElement('div');
  card.className = 'scribe-card';
  card.dataset.id = id;

  const header = document.createElement('div');
  header.className = 'text-sm mb-1';
  const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
  header.innerHTML = `🗣️ <span class="font-bold">${escapeHtml(from || 'Unknown')}</span> <span class="opacity-60">→ ${escapeHtml(to || 'Unknown')}</span> <span class="opacity-60">(${time})</span>`;
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'text-sm leading-6 text-gray-100';
  body.style.textAlign = 'justify';
  body.textContent = text || '';
  applyClamp(body, true);
  card.appendChild(body);

  const del = document.createElement('button');
  del.setAttribute('data-action', 'delete');
  del.className = 'scribe-delete';
  del.title = 'Delete this transcript & linked SOAP';
  del.innerHTML = '🗑️';
  del.addEventListener('click', (e) => { e.stopPropagation(); deleteTranscriptItem(id); });
  card.appendChild(del);

  card.addEventListener('click', (e) => {
    if (e.target.closest('button[data-action="delete"]')) return;
    setActiveTranscriptId(id);
    const collapsed = body.dataset.collapsed === 'true';
    applyClamp(body, !collapsed);
  });

  if (id === loadActiveItemId()) card.classList.add('scribe-card-active');
  return card;
}
function applyClamp(el, collapse = true) {
  if (collapse) {
    el.dataset.collapsed = 'true';
    el.style.display = '-webkit-box';
    el.style.webkitBoxOrient = 'vertical';
    el.style.webkitLineClamp = '4';
    el.style.overflow = 'hidden';
    el.style.maxHeight = '';
  } else {
    el.dataset.collapsed = 'false';
    el.style.display = '';
    el.style.webkitBoxOrient = '';
    el.style.webkitLineClamp = '';
    el.style.overflow = '';
    el.style.maxHeight = 'none';
  }
}
function highlightActiveCard() {
  transcriptEl.querySelectorAll('.scribe-card').forEach(c => c.classList.remove('scribe-card-active'));
  const active = transcriptEl.querySelector(`.scribe-card[data-id="${CSS.escape(loadActiveItemId())}"]`);
  if (active) active.classList.add('scribe-card-active');
}
function setActiveTranscriptId(id) {
  currentActiveItemId = id;
  saveActiveItemId(id);
  highlightActiveCard();
  const hist = loadHistory();
  const item = hist.find(x => x.id === id);
  const soap = item?.soap || {};
  latestSoapNote = Object.keys(soap).length ? soap : loadLatestSoap();
  if (!soapGenerating) renderSoapNote(latestSoapNote);
}
function trimTranscriptIfNeeded() {
  const cards = transcriptEl.querySelectorAll('.scribe-card');
  if (cards.length > MAX_TRANSCRIPT_LINES) {
    const excess = cards.length - MAX_TRANSCRIPT_LINES;
    for (let i = 0; i < excess; i++) {
      const first = transcriptEl.querySelector('.scribe-card');
      if (first) transcriptEl.removeChild(first);
    }
  }
}

function appendTranscriptItem({ from, to, text, timestamp }) {
  if (!transcriptEl || !text) return;
  removeTranscriptPlaceholder();
  const item = { id: uid(), from: from || 'Unknown', to: to || 'Unknown', text: String(text || ''), timestamp: timestamp || Date.now() };
  const history = loadHistory(); history.push(item); saveHistory(history);
  const card = createTranscriptCard(item);
  transcriptEl.appendChild(card);
  trimTranscriptIfNeeded();
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  setActiveTranscriptId(item.id);
}

function deleteTranscriptItem(id) {
  const history = loadHistory(); const idx = history.findIndex(x => x.id === id);
  if (idx === -1) return;
  history.splice(idx, 1); saveHistory(history);
  const node = transcriptEl.querySelector(`.scribe-card[data-id="${CSS.escape(id)}"]`);
  if (node) node.remove();
  const remainingCards = transcriptEl.querySelectorAll('.scribe-card');
  if (remainingCards.length === 0) {
    ensureTranscriptPlaceholder();
    latestSoapNote = {}; saveLatestSoap(latestSoapNote);
    saveActiveItemId('');
    if (!soapGenerating) renderSoapBlank();
    return;
  }
  const activeId = loadActiveItemId();
  if (activeId === id) {
    const newActive = history.length ? history[history.length - 1].id : '';
    if (newActive) setActiveTranscriptId(newActive);
    else {
      latestSoapNote = {}; saveLatestSoap(latestSoapNote); saveActiveItemId('');
      if (!soapGenerating) renderSoapBlank();
    }
  } else {
    highlightActiveCard();
  }
}

// ==========================
// INCREMENTAL EDIT TRACKING (persistent)
// ==========================
const MAX_DELTA_CELLS = 200000; // (n+1)*(m+1) guardrail

// RLE encode/decode for provenance tags ('B'/'U')
function rleEncodeTags(tags) {
  if (!tags || !tags.length) return [];
  const out = [];
  let last = tags[0], count = 1;
  for (let i = 1; i < tags.length; i++) {
    if (tags[i] === last) count++;
    else { out.push([last, count]); last = tags[i]; count = 1; }
  }
  out.push([last, count]);
  return out;
}
function rleDecodeToTags(rle, targetLen) {
  if (!Array.isArray(rle) || rle.length === 0) return new Array(targetLen).fill('B');
  const tags = [];
  for (const [tag, cnt] of rle) {
    for (let i = 0; i < cnt && tags.length < targetLen; i++) tags.push(tag === 'U' ? 'U' : 'B');
    if (tags.length >= targetLen) break;
  }
  if (tags.length < targetLen) while (tags.length < targetLen) tags.push('B');
  else if (tags.length > targetLen) tags.length = targetLen;
  return tags;
}

function buildLcsTable(prevArr, nextArr) {
  const n = prevArr.length, m = nextArr.length;
  const rows = n + 1, cols = m + 1;
  const table = new Array(rows);
  table[0] = new Uint16Array(cols);
  for (let i = 1; i < rows; i++) {
    const row = new Uint16Array(cols);
    const pi = prevArr[i - 1];
    for (let j = 1; j < cols; j++) {
      if (pi === nextArr[j - 1]) row[j] = table[i - 1][j - 1] + 1;
      else {
        const a = table[i - 1][j], b = row[j - 1];
        row[j] = a > b ? a : b;
      }
    }
    table[i] = row;
  }
  return table;
}

function fastGreedyDelta(prevAnn, nextText, state) {
  const prevChars = prevAnn.map(x => x.ch);
  const nextChars = Array.from(nextText);

  let p = 0;
  while (p < prevChars.length && p < nextChars.length && prevChars[p] === nextChars[p]) p++;

  let s = 0;
  while (s < prevChars.length - p && s < nextChars.length - p &&
    prevChars[prevChars.length - 1 - s] === nextChars[nextChars.length - 1 - s]) s++;

  for (let i = p; i < prevChars.length - s; i++) {
    const removed = prevAnn[i];
    if (removed.tag === 'U') state.ins = Math.max(0, state.ins - 1);
    else state.del += 1;
  }

  const inserted = [];
  for (let j = p; j < nextChars.length - s; j++) {
    inserted.push({ ch: nextChars[j], tag: 'U' });
    state.ins += 1;
  }

  const prefix = prevAnn.slice(0, p);
  const suffix = prevAnn.slice(prevChars.length - s);
  return [...prefix, ...inserted, ...suffix];
}

function exactDeltaViaLcs(prevAnn, nextText, state) {
  const prevChars = prevAnn.map(x => x.ch);
  const nextChars = Array.from(nextText);
  const table = buildLcsTable(prevChars, nextChars);

  let i = prevChars.length, j = nextChars.length;
  const newAnnRev = [];

  while (i > 0 && j > 0) {
    if (prevChars[i - 1] === nextChars[j - 1]) {
      newAnnRev.push({ ch: nextChars[j - 1], tag: prevAnn[i - 1].tag });
      i--; j--;
    } else if (table[i - 1][j] >= table[i][j - 1]) {
      const removed = prevAnn[i - 1];
      if (removed.tag === 'U') state.ins = Math.max(0, state.ins - 1);
      else state.del += 1;
      i--;
    } else {
      newAnnRev.push({ ch: nextChars[j - 1], tag: 'U' });
      state.ins += 1;
      j--;
    }
  }
  while (i > 0) {
    const removed = prevAnn[i - 1];
    if (removed.tag === 'U') state.ins = Math.max(0, state.ins - 1);
    else state.del += 1;
    i--;
  }
  while (j > 0) {
    newAnnRev.push({ ch: nextChars[j - 1], tag: 'U' });
    state.ins += 1;
    j--;
  }

  newAnnRev.reverse();
  return newAnnRev;
}

function applyIncrementalDiff(box, newText) {
  let state = editStateMap.get(box);
  if (!state) {
    state = { ann: Array.from(newText).map(ch => ({ ch, tag: 'B' })), ins: 0, del: 0 };
    editStateMap.set(box, state);
    return 0;
  }

  const prevAnn = state.ann;
  const n = prevAnn.length, m = newText.length;

  let newAnn;
  if ((n + 1) * (m + 1) > MAX_DELTA_CELLS) {
    newAnn = fastGreedyDelta(prevAnn, newText, state);
  } else {
    newAnn = exactDeltaViaLcs(prevAnn, newText, state);
  }

  state.ann = newAnn;
  const total = Math.max(0, state.ins) + Math.max(0, state.del);
  return total;
}

// Persist/Restore per-section incremental state
function persistSectionState(section, state) {
  latestSoapNote._editMeta = latestSoapNote._editMeta || {};
  const tags = state.ann.map(x => x.tag);
  const provRLE = rleEncodeTags(tags);
  const edits = Math.max(0, state.ins) + Math.max(0, state.del);
  latestSoapNote._editMeta[section] = { edits, ins: state.ins, del: state.del, provRLE };
  saveLatestSoap(latestSoapNote);
}

function restoreSectionState(section, contentText) {
  const meta = latestSoapNote?._editMeta?.[section];
  if (!meta) {
    return { ann: Array.from(contentText).map(ch => ({ ch, tag: 'B' })), ins: 0, del: 0, edits: 0 };
  }
  const tags = rleDecodeToTags(meta.provRLE, contentText.length);
  const ann = Array.from(contentText).map((ch, i) => ({ ch, tag: (tags[i] === 'U' ? 'U' : 'B') }));
  const ins = Number.isFinite(meta.ins) ? meta.ins : 0;
  const del = Number.isFinite(meta.del) ? meta.del : 0;
  const edits = Number.isFinite(meta.edits) ? meta.edits : Math.max(0, ins) + Math.max(0, del);
  return { ann, ins, del, edits };
}

function rebaseBoxStateToCurrent(box) {
  const current = box.value || '';
  const state = editStateMap.get(box) || { ann: [], ins: 0, del: 0 };
  state.ann = Array.from(current).map(ch => ({ ch, tag: 'B' }));
  state.ins = 0;
  state.del = 0;
  editStateMap.set(box, state);

  const section = box.dataset.section;
  persistSectionState(section, state);
}

// ==========================
// SOAP note rendering
// ==========================
function soapContainerEnsure() {
  let scroller = document.getElementById('soapScroller');
  if (!scroller) {
    scroller = document.createElement('div');
    scroller.id = 'soapScroller';
    scroller.className = 'scribe-soap-scroll scribe-scroll';
    soapHost.appendChild(scroller);
  }
  return scroller;
}
function renderSoapBlank() {
  const scroller = soapContainerEnsure();
  scroller.innerHTML = '';
}
function autoExpandTextarea(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function initializeEditMetaForSoap(soap) {
  soap._aiMeta = soap._aiMeta || {};
  soap._editMeta = soap._editMeta || {};
  const sections = ['Chief Complaints', 'History of Present Illness', 'Subjective', 'Objective', 'Assessment', 'Plan', 'Medication'];
  sections.forEach(section => {
    const val = soap?.[section] || '';
    const textBlock = Array.isArray(val) ? val.join('\n') : String(val || '');
    soap._aiMeta[section] = { text: textBlock };
    soap._editMeta[section] = {
      edits: 0, ins: 0, del: 0,
      provRLE: rleEncodeTags(new Array(textBlock.length).fill('B'))
    };
  });
}

function persistSoapFromUI() {
  const scroller = soapContainerEnsure();
  const editors = scroller.querySelectorAll('textarea[data-section]');
  const soap = {};
  editors.forEach(t => { soap[t.dataset.section] = t.value || ''; });

  soap._aiMeta = (latestSoapNote && latestSoapNote._aiMeta) ? latestSoapNote._aiMeta : {};
  soap._editMeta = latestSoapNote?._editMeta || {};

  const medTextarea = scroller.querySelector('textarea[data-section="Medication"]');
  if (medTextarea) {
    const medications = (medTextarea.value || '').split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(name => ({
        name,
        available: medAvailability.has(normalizeDrugKey(name)) ? medAvailability.get(normalizeDrugKey(name)) : null
      }));
    soap.medications = medications;
  }

  latestSoapNote = soap;
  saveLatestSoap(latestSoapNote);

  const activeId = loadActiveItemId();
  if (activeId) {
    const hist = loadHistory();
    const i = hist.findIndex(x => x.id === activeId);
    if (i !== -1) { hist[i].soap = latestSoapNote; saveHistory(hist); }
  }
}

function ensureTopHeadingBadge() {
  if (totalEditsBadgeEl && document.body.contains(totalEditsBadgeEl)) return totalEditsBadgeEl;

  const candidates = Array.from(document.querySelectorAll('h1, h2, h3, [data-title]'));
  let heading = candidates.find(el => (el.textContent || '').trim().toLowerCase().startsWith('soap note'));

  if (!heading) {
    const wrap = document.createElement('div');
    wrap.className = 'scribe-heading-flex';
    const h = document.createElement('h2');
    h.textContent = 'SOAP Note';
    wrap.appendChild(h);
    soapHost.parentNode?.insertBefore(wrap, soapHost);
    heading = wrap;
  }

  heading.classList.add('scribe-heading-flex');

  totalEditsBadgeEl = document.createElement('div');
  totalEditsBadgeEl.id = '_scribe_total_edits';
  totalEditsBadgeEl.className = '_scribe_total_edits';
  totalEditsBadgeEl.textContent = 'Total Edits: 0';
  heading.appendChild(totalEditsBadgeEl);
  return totalEditsBadgeEl;
}

function updateTotalsAndEhrState() {
  const scroller = soapContainerEnsure();
  const editors = scroller.querySelectorAll('textarea[data-section]');
  let total = 0;
  editors.forEach(t => {
    const m = t.dataset.editCount ? Number(t.dataset.editCount) : 0;
    total += m;
    const headMeta = scroller.querySelector(`.scribe-section[data-section="${CSS.escape(t.dataset.section)}"] .scribe-section-meta`);
    if (headMeta) headMeta.textContent = `Edits: ${m}`;
  });

  const badge = ensureTopHeadingBadge();
  if (badge) badge.textContent = `Total Edits: ${total}`;

  if (addEhrBtnEl) {
    addEhrBtnEl.disabled = true;
    addEhrBtnEl.classList.add('scribe-add-ehr-disabled');
  }
}

function resetAllEditCountersToZero() {
  const scroller = soapContainerEnsure();
  const editors = scroller.querySelectorAll('textarea[data-section]');
  editors.forEach(textarea => {
    rebaseBoxStateToCurrent(textarea);
    textarea.dataset.editCount = '0';
    const headMeta = scroller.querySelector(`.scribe-section[data-section="${CSS.escape(textarea.dataset.section)}"] .scribe-section-meta`);
    if (headMeta) headMeta.textContent = `Edits: 0`;
  });
  if (latestSoapNote) latestSoapNote._editMeta = latestSoapNote._editMeta || {};
  Object.keys(latestSoapNote._aiMeta || {}).forEach(section => {
    latestSoapNote._editMeta[section] = latestSoapNote._editMeta[section] || {};
    latestSoapNote._editMeta[section].edits = 0;
    latestSoapNote._editMeta[section].ins = 0;
    latestSoapNote._editMeta[section].del = 0;
  });
  saveLatestSoap(latestSoapNote);
  updateTotalsAndEhrState();
}

function attachEditTrackingToTextarea(box, aiText) {
  const section = box.dataset.section;
  const contentText = box.value || '';

  const restored = restoreSectionState(section, contentText);
  editStateMap.set(box, { ann: restored.ann, ins: restored.ins, del: restored.del });
  box.dataset.editCount = String(restored.edits);

  const scroller = soapContainerEnsure();
  const headMeta = scroller.querySelector(`.scribe-section[data-section="${CSS.escape(section)}"] .scribe-section-meta`);
  if (headMeta) headMeta.textContent = `Edits: ${restored.edits}`;

  box.dataset.aiText = aiText || '';

  let rafId = null;
  box.addEventListener('input', () => {
    autoExpandTextarea(box);
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      try {
        const now = box.value || '';
        const totalEdits = applyIncrementalDiff(box, now);
        box.dataset.editCount = String(totalEdits);

        const state = editStateMap.get(box);
        persistSectionState(section, state);

        latestSoapNote = latestSoapNote || {};
        latestSoapNote._editMeta = latestSoapNote._editMeta || {};
        latestSoapNote._editMeta[section] = latestSoapNote._editMeta[section] || {};
        latestSoapNote._editMeta[section].edits = totalEdits;
        saveLatestSoap(latestSoapNote);

        const headMetaNow = scroller.querySelector(`.scribe-section[data-section="${CSS.escape(section)}"] .scribe-section-meta`);
        if (headMetaNow) headMetaNow.textContent = `Edits: ${totalEdits}`;

        updateTotalsAndEhrState();
        persistSoapFromUI();

        // Medication: show pending emojis and (debounced) validate ONLY when editing
        if (section === 'Medication') {
          medAvailability.clear();         // clear in-memory so overlay shows ⏳
          renderMedicationInline();        // show ⏳ while typing

          if (medicationDebounceTimer) clearTimeout(medicationDebounceTimer);
          medicationDebounceTimer = setTimeout(() => {
            checkMedicationsFromTextarea(box); // will call API only if content changed vs last validated text
          }, 600);
        }

      } catch (e) { console.warn('[SCRIBE] input handler error', e); }
      rafId = null;
    });
  });
}

function renderSoapNote(soap) {
  if (soapGenerating) return;
  const scroller = soapContainerEnsure();
  scroller.innerHTML = '';

  ensureTopHeadingBadge();

  const sections = ['Chief Complaints', 'History of Present Illness', 'Subjective', 'Objective', 'Assessment', 'Plan', 'Medication'];

  if (soap && Object.keys(soap).length && !soap._aiMeta) {
    initializeEditMetaForSoap(soap);
  }

  latestSoapNote = latestSoapNote || soap || {};
  latestSoapNote._aiMeta = latestSoapNote._aiMeta || (soap ? soap._aiMeta : {}) || {};
  latestSoapNote._editMeta = latestSoapNote._editMeta || (soap ? soap._editMeta : {}) || {};

  sections.forEach(section => {
    const wrap = document.createElement('div');
    wrap.className = 'scribe-section';
    wrap.dataset.section = section;

    const head = document.createElement('div');
    head.className = 'scribe-section-head';

    const h = document.createElement('h3');
    h.textContent = section;

    const metaSpan = document.createElement('div');
    metaSpan.className = 'scribe-section-meta';
    metaSpan.textContent = 'Edits: 0';

    head.appendChild(h);
    head.appendChild(metaSpan);
    wrap.appendChild(head);

    const box = document.createElement('textarea');
    box.className = 'scribe-textarea';
    box.readOnly = false;
    box.dataset.section = section;

    const rawVal = soap?.[section];
    const contentText = Array.isArray(rawVal) ? rawVal.join('\n') : (typeof rawVal === 'string' ? rawVal : '');
    box.value = contentText;
    autoExpandTextarea(box);

    const aiText = soap?._aiMeta?.[section]?.text ?? contentText;
    latestSoapNote._aiMeta[section] = latestSoapNote._aiMeta[section] || { text: aiText };

    attachEditTrackingToTextarea(box, aiText);

    if (section === 'Medication') {
      const w = document.createElement('div');
      w.className = 'med-wrap';
      w.appendChild(box);
      wrap.appendChild(w);
    } else {
      wrap.appendChild(box);
    }
    scroller.appendChild(wrap);

  });

  saveLatestSoap(latestSoapNote);
  updateTotalsAndEhrState();

  // Restore persisted medication availability (no API call here)
  renderMedicationInline();

  scroller.scrollTop = 0;
  const firstBox = scroller.querySelector('textarea[data-section]');
  if (firstBox) { try { firstBox.focus(); } catch { } }
}

function renderSoapNoteGenerating(elapsed) {
  const scroller = soapContainerEnsure();
  scroller.innerHTML = `
    <div class="scribe-section" style="text-align:center; color:#fbbf24;">
      Please wait, AI is generating the SOAP note… ${elapsed}s
    </div>
  `;
  ensureTopHeadingBadge();
}

// ==========================
// Drug Availability (inline in same box) — UPDATED with animated emojis + persistence
// ==========================
const medAvailability = new Map(); // Map<normalizedName, boolean>

// Validation state
let medicationValidationPending = false;
let medicationDebounceTimer = null;

// Normalize a drug string so signals and textarea lines match reliably
function normalizeDrugKey(str) {
  if (!str) return '';
  let s = String(str).trim();

  // Remove text like "for headache", "for joint pain"
  s = s.replace(/\s+for\s+.+$/i, '');

  // Drop dosage/notes in parentheses/brackets and after hyphens/commas/colon
  s = s.replace(/\s*[\(\[\{].*?[\)\]\}]\s*$/g, '');
  s = s.split(/\s*[-,:@|]\s*/)[0];

  // Collapse spaces, strip punctuation edges
  s = s.replace(/\s+/g, ' ').replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');

  return s.toLowerCase();
}

function normalizedMedicationBlock(textarea) {
  const lines = (textarea?.value || '').split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(normalizeDrugKey);
  return lines.join('\n');
}

// Call API only if textarea content changed vs last validated text
async function checkMedicationsFromTextarea(textarea) {
  if (!textarea) return;

  const currentNormalized = normalizedMedicationBlock(textarea);
  const { byName: persistedByName, lastText } = loadMedStatus();

  // If unchanged since last validation, just restore and render; no API call.
  if (currentNormalized === lastText) {
    medAvailability.clear();
    Object.entries(persistedByName).forEach(([k, v]) => medAvailability.set(k, !!v));
    medicationValidationPending = false;
    renderMedicationInline();
    updateAddToEhrButtonState();
    return;
  }

  const rawLines = (textarea.value || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (rawLines.length === 0) {
    medAvailability.clear();
    saveMedStatus({}, currentNormalized);
    renderMedicationInline();
    updateAddToEhrButtonState();
    return;
  }

  medicationValidationPending = true;
  showPendingIndicators();

  try {
    const response = await fetch(`${SERVER_URL}/api/medications/availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: rawLines })
    });

    if (!response.ok) {
      console.warn('[MED_CHECK] API error:', response.status);
      medicationValidationPending = false;
      return;
    }

    const data = await response.json();
    const results = data.results || [];

    medAvailability.clear();
    const newByName = {};
    results.forEach(item => {
      const rawName = (item.name ?? item.query ?? item.drug ?? item.drugName ?? '').toString();
      const key = normalizeDrugKey(rawName);
      if (!key) return;
      const available =
        typeof item.available === 'boolean'
          ? item.available
          : (item.status === 'exists' || item.status === 'available' || item.status === true);
      medAvailability.set(key, !!available);
      newByName[key] = !!available;
    });

    // Persist statuses & the exact normalized text these apply to
    saveMedStatus(newByName, currentNormalized);

    medicationValidationPending = false;
    renderMedicationInline();
    updateAddToEhrButtonState();
  } catch (err) {
    console.error('[MED_CHECK] Error:', err);
    medicationValidationPending = false;
  }
}

function showPendingIndicators() {
  const scroller = soapContainerEnsure();
  const medSection = scroller.querySelector('.scribe-section[data-section="Medication"]');
  if (!medSection) return;

  const wrap = ensureMedicationWrap(medSection);
  const overlay = wrap?.querySelector('.med-overlay');
  if (!overlay) return;

  const frag = document.createDocumentFragment();
  const textarea = medSection.querySelector('textarea[data-section="Medication"]');
  const lines = (textarea?.value || '').split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    const row = document.createElement('div');
    row.className = 'med-line';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = line;
    // Avoid double-visual text (textarea already shows it)
    nameSpan.style.color = 'transparent';
    row.appendChild(nameSpan);

    if (line) {
      const badge = document.createElement('span');
      badge.className = 'med-emoji med-pending';
      badge.textContent = '⏳';
      row.appendChild(badge);
    }

    frag.appendChild(row);
  }

  overlay.replaceChildren(frag);
}

function updateAddToEhrButtonState() {
  if (!addEhrBtnEl) return;
  // Always disabled per requirements; keep logic in case of future enablement.
  addEhrBtnEl.disabled = true;
}

// Inject minimal CSS once (dark-theme friendly) — UPDATED to emoji + subtle animations
function ensureMedStyles() {
  if (document.getElementById('med-inline-css')) return;
  const s = document.createElement('style');
  s.id = 'med-inline-css';
  s.textContent = `
    .med-line { display: flex; align-items: center; gap: 8px; }
    .med-emoji { font-weight: 800; display:inline-block; transform-origin: center; }
    .med-wrap { position: relative; }
    .med-overlay {
      position: absolute; inset: 0; pointer-events: none;
      white-space: pre-wrap; overflow: hidden;
      font: inherit; line-height: inherit; color: inherit;
      z-index: 2;  
      opacity: 1 !important;
    }
    /* Animations */
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(0.9); opacity: .7; }
    }
    @keyframes pop {
      0% { transform: scale(0.6); }
      60% { transform: scale(1.08); }
      100% { transform: scale(1); }
    }
    @keyframes wiggle {
      0%, 100% { transform: rotate(0deg); }
      25% { transform: rotate(-7deg); }
      75% { transform: rotate(7deg); }
    }
    .med-pending { animation: pulse 1.2s ease-in-out infinite; }
    .med-available { animation: pop 250ms ease-out; }
    .med-unavailable { animation: wiggle 400ms ease-in-out 2; }
  `;
  document.head.appendChild(s);
}

// Ensure textarea is wrapped so we can render inline overlay inside the same box
function ensureMedicationWrap(medSection) {
  const textarea = medSection.querySelector('textarea[data-section="Medication"]');
  if (!textarea) return null;

  let wrap = medSection.querySelector('.med-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'med-wrap';
    textarea.parentNode.insertBefore(wrap, textarea);
    wrap.appendChild(textarea);
  }

  // Ensure overlay exists even if wrap already created elsewhere
  let overlay = wrap.querySelector('.med-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'med-overlay';
    wrap.appendChild(overlay);

    // Keep overlay scroll synced to textarea
    textarea.addEventListener('scroll', () => { overlay.scrollTop = textarea.scrollTop; });
  }

  return wrap;
}

// Render inline emojis line-by-line on top of the textarea (same box)
function renderMedicationInline() {
  ensureMedStyles();

  const scroller = soapContainerEnsure();
  const medSection = scroller.querySelector('.scribe-section[data-section="Medication"]');
  if (!medSection) return;

  const wrap = ensureMedicationWrap(medSection);
  const textarea = medSection.querySelector('textarea[data-section="Medication"]');
  const overlay = wrap?.querySelector('.med-overlay');
  if (!wrap || !textarea || !overlay) return;

  // Mirror text metrics so overlay lines align with textarea
  const cs = getComputedStyle(textarea);
  overlay.style.padding = cs.padding;
  overlay.style.lineHeight = cs.lineHeight;
  overlay.style.fontSize = cs.fontSize;
  overlay.style.fontFamily = cs.fontFamily;
  overlay.scrollTop = textarea.scrollTop;

  // Before drawing, ensure in-memory map reflects persisted statuses if text matches
  const currentNormalized = normalizedMedicationBlock(textarea);
  const { byName, lastText } = loadMedStatus();
  if (currentNormalized === lastText) {
    medAvailability.clear();
    Object.entries(byName).forEach(([k, v]) => medAvailability.set(k, !!v));
  }

  const frag = document.createDocumentFragment();
  const lines = (textarea.value || '').split('\n');

  for (const raw of lines) {
    const line = raw.trim();

    const row = document.createElement('div');
    row.className = 'med-line';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = line;
    // Hide duplicate text (the textarea already shows it); keep width for alignment
    nameSpan.style.color = 'transparent';
    row.appendChild(nameSpan);

    if (line) {
      const key = normalizeDrugKey(line);

      if (medAvailability.has(key)) {
        const ok = !!medAvailability.get(key);
        const badge = document.createElement('span');
        badge.className = `med-emoji ${ok ? 'med-available' : 'med-unavailable'}`;
        badge.textContent = ok ? '✅' : '❌';
        row.appendChild(badge);
      } else if (medicationValidationPending) {
        // If we're currently validating, show pending
        const badge = document.createElement('span');
        badge.className = 'med-emoji med-pending';
        badge.textContent = '⏳';
        row.appendChild(badge);
      }
    }

    frag.appendChild(row);
  }

  overlay.replaceChildren(frag);
}

// Back-compat entry point (kept name so existing calls still work)
function updateMedicationAvailabilityIndicators() {
  renderMedicationInline();
}

// ==========================
// Signal handling (Socket.IO / BroadcastChannel)
// ==========================
function ingestDrugAvailabilityPayload(payload) {
  const arr = Array.isArray(payload) ? payload : (payload ? [payload] : []);
  medAvailability.clear();
  const newByName = {};
  for (const item of arr) {
    const raw =
      (item?.name ?? item?.query ?? item?.drug ?? item?.drugName ?? '').toString();
    const key = normalizeDrugKey(raw);
    if (!key) continue;
    const available =
      typeof item?.available === 'boolean'
        ? item.available
        : (item?.status === 'exists' || item?.status === 'available' || item?.status === true);
    medAvailability.set(key, !!available);
    newByName[key] = !!available;
  }

  // Persist what we ingest; tie it to the current Medication block if present
  const scroller = soapContainerEnsure();
  const medTextarea = scroller.querySelector('textarea[data-section="Medication"]');
  const currentNormalized = normalizedMedicationBlock(medTextarea);
  saveMedStatus(newByName, currentNormalized);

  renderMedicationInline();
}

function handleSignalMessage(packet) {
  if (!packet?.type) return;

  if (packet.type === 'drug_availability' || packet.type === 'drug_availability_console') {
    ingestDrugAvailabilityPayload(packet.data);
    return;
  }

  if (packet.type === 'transcript_console') {
    const p = packet.data || {};
    const { from, to, text = '', final = false, timestamp } = p;
    const key = transcriptKey(from, to);
    const slot = (transcriptState.byKey[key] ||= { partial: '', paragraph: '', flushTimer: null });

    if (!final) {
      slot.partial = text;
      return;
    }

    const mergedFinal = mergeIncremental(slot.partial, text);
    slot.partial = '';
    slot.paragraph = mergeIncremental(slot.paragraph ? slot.paragraph + ' ' : '', mergedFinal);

    if (slot.flushTimer) clearTimeout(slot.flushTimer);
    slot.flushTimer = setTimeout(() => {
      if (slot.paragraph) {
        appendTranscriptItem({ from, to, text: slot.paragraph, timestamp });
        transcriptBC.postMessage({ type: 'transcript_console', data: { from, to, text: slot.paragraph, final: true, timestamp } });
        slot.paragraph = '';
      }
      slot.flushTimer = null;
    }, 800);

    if (!soapNoteTimer) {
      soapGenerating = true;
      renderSoapNoteGenerating(0);
      soapNoteStartTime = Date.now();
      soapNoteTimer = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - soapNoteStartTime) / 1000);
        renderSoapNoteGenerating(elapsedSec);
      }, 1000);
    }
  }

  else if (packet.type === 'soap_note_console') {
    const soap = packet.data || {};
    initializeEditMetaForSoap(soap); // new AI content -> fresh baseline and counters
    latestSoapNote = soap; saveLatestSoap(latestSoapNote);

    const activeId = loadActiveItemId();
    if (activeId) {
      const hist = loadHistory();
      const i = hist.findIndex(x => x.id === activeId);
      if (i !== -1) { hist[i].soap = latestSoapNote; saveHistory(hist); }
    }

    soapBC.postMessage({ type: 'soap_note_console', data: soap, timestamp: packet.timestamp || Date.now() });

    if (soapNoteTimer) { clearInterval(soapNoteTimer); soapNoteTimer = null; }
    soapGenerating = false;
    renderSoapNote(latestSoapNote);

    // IMPORTANT: Do NOT auto-call the meds API here.
    // We only validate on user edit. If persisted statuses match current text, they will render immediately.
  }
}

try {
  transcriptBC.onmessage = (e) => handleSignalMessage(e.data);
  soapBC.onmessage = (e) => handleSignalMessage(e.data);
} catch (e) { console.warn('[SCRIBE] BroadcastChannel unavailable:', e); }

// ==========================
// Socket.IO loader + connection
// ==========================
async function loadScript(src, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; s.remove(); reject(new Error(`Timeout loading ${src}`)); } }, timeoutMs);
    s.onload = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    s.onerror = () => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`Failed to load ${src}`)); } };
    document.head.appendChild(s);
  });
}
async function loadSocketIoClientFor(endpointBase) {
  if (window.io) return;
  const endpointClient = `${endpointBase}/socket.io/socket.io.js`;
  try {
    console.log('[SCRIBE] Trying Socket.IO client from:', endpointClient);
    await loadScript(endpointClient);
    if (window.io) return;
  } catch (e) { console.warn('[SCRIBE] Load failed:', String(e)); }
  const CDN = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
  console.log('[SCRIBE] Falling back to Socket.IO CDN:', CDN);
  await loadScript(CDN);
  if (!window.io) throw new Error('Socket.IO client not available after CDN load.');
}
function connectTo(endpointBase, onFailover) {
  return new Promise(resolve => {
    setStatus('Connecting'); // initial pill
    SERVER_URL = endpointBase;

    const opts = {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: true,
      secure: SERVER_URL.startsWith('https://')
    };

    try { socket?.close(); } catch { }
    socket = window.io(SERVER_URL, opts);


    socket.off('connect_error');
    socket.off('disconnect');

    socket.on('connect_error', err => console.warn('[SCRIBE] connect_error:', err));
    socket.on('disconnect', (reason) => {
      console.warn('[COCKPIT] disconnect', { reason, socketId: socket?.id, currentRoom });

      const prevRoom = currentRoom;
      currentRoom = null;

      _lastReqListAt = 0;   // keep your existing throttle reset
      clearCockpitUiForRoomSwitch(prevRoom, null);
      showNoDevices();
      updateConnectionStatus('disconnect');
    });

    let connected = false;
    const failTimer = setTimeout(() => { if (!connected) onFailover?.(); }, 4000);

    socket.on('connect', async () => {
      connected = true;
      clearTimeout(failTimer);

      // ✅ Attach listeners BEFORE any requests (prevents missing first device_list)
      socket.off('device_list', updateDeviceList);
      socket.off('signal', handleSignalMessage);
      socket.off('room_joined');
      socket.off('peer_left');
      socket.off('room_update');   // ✅ ADD THIS
      socket.off('telemetry_update');


      socket.on('device_list', updateDeviceList); // renders list only (status is socket+room based)
      socket.on('signal', handleSignalMessage);

      socket.on('room_update', ({ pairs } = {}) => {
        try {
          if (!COCKPIT_FOR_XR_ID) return;

          const me = String(COCKPIT_FOR_XR_ID).trim().toUpperCase();
          const list = Array.isArray(pairs) ? pairs : [];

          const inAnyPair = list.some(p => {
            const a = String(p?.a || '').trim().toUpperCase();
            const b = String(p?.b || '').trim().toUpperCase();
            return a === me || b === me;
          });

          // ✅ When pairing appears, ask server for fresh device_list (throttled)
          // Only do this if we are not already in a room (prevents spam)
          if (inAnyPair && !currentRoom) {
            console.log('[COCKPIT][ROOM_UPDATE] pair detected for me; requesting device_list', { me, currentRoom });
            requestDeviceListThrottled('room_update_pair_detected');
          }
        } catch (e) {
          console.warn('[COCKPIT][ROOM_UPDATE] handler error', e);
        }
      });

      socket.on('telemetry_update', (t = {}) => {
        try {
          // If we are not paired yet, the server might still be sending telemetry for the “primary”
          // Use this as the bootstrap to show single-device-online without waiting for room_update.
          if (!COCKPIT_FOR_XR_ID) return;

          const me = String(COCKPIT_FOR_XR_ID).trim().toUpperCase();
          const xr = String(t?.xrId || '').trim().toUpperCase();
          if (!xr) return;

          // Only act when telemetry belongs to the primary XR we’re “watching”
          if (xr !== me) return;

          // If we're not in a room yet, ask server for authoritative list (throttled).
          // Server may reply [] or [me]; either way, this triggers UI refresh logic.
          if (!currentRoom) {
            requestDeviceListThrottled('telemetry_bootstrap_single_device');
          }
        } catch (e) {
          console.warn('[COCKPIT][TELEMETRY_UPDATE] handler error', e);
        }
      });


      socket.on('peer_left', ({ xrId, roomId, reason } = {}) => {
        // Ignore peer_left for some other room (extra safety)
        if (roomId && currentRoom && roomId !== currentRoom) return;

        const prevRoom = currentRoom;
        currentRoom = null;

        console.warn('[COCKPIT] peer_left', { xrId, roomId, reason, prevRoom });

        // Clear room-isolated UI (transcript/SOAP) because pairing ended
        clearCockpitUiForRoomSwitch(prevRoom, null);

        // Clear device list immediately (don’t wait for next device_list)
        showNoDevices();

        // Status pill: socket may still be connected, but room is gone => Connecting
        updateConnectionStatus('peer_left');

        // Ask server for authoritative list (will return self-only or [])
        requestDeviceListThrottled('after_peer_left');
      });


      // ✅ If/when server joins cockpit to pair room, re-request list to mirror XR Vision Dock
      socket.on('room_joined', ({ roomId, reason, members } = {}) => {
        const prevRoom = currentRoom;
        const nextRoom = roomId || null;

        console.log('[COCKPIT][ROOM] room_joined (raw)', {
          prevRoom,
          nextRoom,
          reason,
          members,
          socketId: socket.id,
          cockpitForXrId: COCKPIT_FOR_XR_ID
        });

        // ✅ Always clear if switching rooms (including first join null -> room)
        clearCockpitUiForRoomSwitch(prevRoom, nextRoom);

        // ✅ Set currentRoom BEFORE restore (restore reads currentRoom via loadHistory()/etc)
        currentRoom = nextRoom;

        updateConnectionStatus('room_joined');

        // ✅ Restore ONLY this room’s state (or blank if none)
        try {
          restoreFromLocalStorage();
          console.debug('[COCKPIT][RESTORE] after room_joined', {
            currentRoom,
            historyCount: (loadHistory() || []).length,
            activeId: loadActiveItemId()
          });
        } catch (e) {
          console.warn('[COCKPIT][RESTORE] failed after room_joined', e);
        }

        // ✅ Request device list ONLY when we actually have a room, and throttle to prevent spam
        if (currentRoom) {
          requestDeviceListThrottled('after_room_joined');
        } else {
          console.debug('[COCKPIT][REQ_LIST] skip after room_joined (not paired yet)', { reason, prevRoom, nextRoom });
        }

      });


      // ✅ Identify as COCKPIT using logged-in user's mapped xrId
      try {
        const meRes = await fetch('/api/platform/me', { credentials: 'include' });
        const me = await meRes.json();
        const xrId = (me?.xrId || me?.xr_id || '').toString().trim();
        COCKPIT_FOR_XR_ID = xrId || null;


        if (xrId) {
          socket.emit('identify', {
            xrId,
            deviceName: 'XR Dock (Scribe Cockpit)',
            clientType: 'cockpit'
          });
        } else {
          console.warn('[SCRIBE] /api/platform/me returned no xrId');
        }
      } catch (e) {
        console.warn('[SCRIBE] Failed to load /api/platform/me for identify:', e);
      }

      // ✅ Always request once after identify (server will reply [] if not paired yet, or room list if paired)
      requestDeviceListThrottled('after_identify');


      resolve();
    });



  });
}

function clearCockpitUiForRoomSwitch(prevRoom, nextRoom) {
  if (prevRoom === nextRoom) return;

  console.warn('[COCKPIT][ROOM][CLEAR] switching rooms', {
    prevRoom, nextRoom,
    prevHistoryKey: prevRoom ? `scribe:${prevRoom}:history` : null,
    nextHistoryKey: nextRoom ? `scribe:${nextRoom}:history` : null,
    prevSoapKey: prevRoom ? `scribe:${prevRoom}:latestSoap` : null,
    nextSoapKey: nextRoom ? `scribe:${nextRoom}:latestSoap` : null

  });

  // 1) stop any pending transcript flush timers (prevents late append from old room)
  try {
    Object.values(transcriptState.byKey || {}).forEach(slot => {
      try { if (slot?.flushTimer) clearTimeout(slot.flushTimer); } catch { }
    });
  } catch { }
  transcriptState.byKey = {};

  // 2) wipe transcript DOM
  try { transcriptEl.innerHTML = ''; } catch { }
  try { ensureTranscriptPlaceholder(); } catch { }

  // 3) wipe in-memory SOAP/transcript selection (do NOT delete room storage)
  currentActiveItemId = null;
  latestSoapNote = {};
  soapGenerating = false;

  // 4) clear SOAP UI to blank immediately (room isolation)
  try { renderSoapBlank(); } catch { }

  // 5) clear med in-memory; restore() will rehydrate from the correct room if applicable
  try { medAvailability.clear(); } catch { }
}


// ==========================
// Restore state from localStorage
// ==========================
function restoreFromLocalStorage() {
  // Transcript history
  transcriptEl.innerHTML = '';
  const history = loadHistory();
  if (history.length === 0) ensureTranscriptPlaceholder();
  else {
    removeTranscriptPlaceholder();
    history.forEach(item => transcriptEl.appendChild(createTranscriptCard(item)));
  }

  // SOAP
  latestSoapNote = loadLatestSoap();
  const historyList = loadHistory();
  currentActiveItemId = loadActiveItemId() || (historyList.length ? historyList[historyList.length - 1].id : '');
  if (!currentActiveItemId && historyList.length) {
    currentActiveItemId = historyList[historyList.length - 1].id; saveActiveItemId(currentActiveItemId);
  }
  highlightActiveCard();

  ensureTopHeadingBadge();

  if (historyList.length === 0) renderSoapBlank();
  else renderSoapNote(latestSoapNote || {});

  // Restore persisted med availability into memory if text matches
  const scroller = soapContainerEnsure();
  const medTextarea = scroller.querySelector('textarea[data-section="Medication"]');
  if (medTextarea) {
    const currentNormalized = normalizedMedicationBlock(medTextarea);
    const { byName, lastText } = loadMedStatus();
    if (currentNormalized === lastText) {
      medAvailability.clear();
      Object.entries(byName).forEach(([k, v]) => medAvailability.set(k, !!v));
      renderMedicationInline();
    }
  }
}

// ==========================
// Wire HTML buttons
// ==========================
function wireSoapActionButtons() {
  const scroller = soapContainerEnsure();

  if (clearBtnEl) {
    clearBtnEl.onclick = () => {
      if (!hasScribeWritePermission()) {
        notifyReadOnlyScribe();
        return;
      }

      scroller.querySelectorAll('textarea[data-section]').forEach(t => {
        t.value = '';
        autoExpandTextarea(t);
        rebaseBoxStateToCurrent(t); // provenance -> empty baseline
        t.dataset.editCount = '0';
        const headMeta = scroller.querySelector(`.scribe-section[data-section="${CSS.escape(t.dataset.section)}"] .scribe-section-meta`);
        if (headMeta) headMeta.textContent = `Edits: 0`;
      });
      persistSoapFromUI();

      // Clear med availability persistence since text is empty
      saveMedStatus({}, '');
      medAvailability.clear();
      renderMedicationInline();

      resetAllEditCountersToZero();
      console.log('[SCRIBE] SOAP cleared and edit counters reset.');
    };
  }


  if (saveBtnEl) {
    saveBtnEl.onclick = () => {
      if (!hasScribeWritePermission()) {
        notifyReadOnlyScribe();
        return;
      }

      persistSoapFromUI();
      scroller.querySelectorAll('textarea[data-section]').forEach(t => rebaseBoxStateToCurrent(t));
      resetAllEditCountersToZero();
      console.log('[SCRIBE] SOAP saved and edit counters reset.');
    };
  }


  if (addEhrBtnEl) {
    addEhrBtnEl.disabled = true;
    addEhrBtnEl.classList.add('scribe-add-ehr-disabled');
    addEhrBtnEl.onclick = () => {
      if (!hasScribeWritePermission()) {
        notifyReadOnlyScribe();
        return;
      }

      console.log('[SCRIBE] Add EHR is disabled (placeholder).');
      scroller.querySelectorAll('textarea[data-section]').forEach(t => rebaseBoxStateToCurrent(t));
      resetAllEditCountersToZero();
    };
  }

}

// ==========================
// Boot
// ==========================
(async function boot() {
  try {
    ensureTranscriptPlaceholder();
    showNoDevices();

    ensureMedStyles();

    // 1) Restore previous transcript + SOAP from localStorage
    restoreFromLocalStorage();

    // 2) Load XR Dock / Scribe Cockpit permissions, then lock UI if READ-only
    await loadDockPermissions();
    applyScribeReadOnlyUI();

    // 3) Wire buttons (they will also guard writes at click time)
    wireSoapActionButtons();

    // Initial draw for medication overlay (uses persisted statuses if available)
    renderMedicationInline();

    await loadSocketIoClientFor(preferred);
    await connectTo(preferred, async () => {
      if (!window.io) await loadSocketIoClientFor(fallback);
      await connectTo(fallback);
    });

    console.log('[SCRIBE] Cockpit booted successfully');
  } catch (e) {
    console.error('[SCRIBE] Failed to initialize:', e);
    setStatus('Disconnected');
    if (deviceListEl) {
      deviceListEl.innerHTML = `<li class="text-red-400">Could not initialize cockpit. Ensure your signaling server is live: ${isLocal ? 'NGROK' : 'AZURE'}</li>`;
    }
  }
})();



// ==========================
// Helpers
// ==========================
function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", "&#039;");
}
