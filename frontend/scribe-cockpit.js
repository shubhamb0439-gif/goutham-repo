// -------------------------------------------------- scribe-cockpit-updated.js --------------------------------------------------
// Full scribe cockpit with per-textbox human insert-only edit tracking vs AI baseline
// - Tracks AI baseline (original text) when SOAP is generated
// - Per box shows "Edits: N" (only insertions vs AI baseline)
//   • Deleting previously-added text reduces N
//   • Deleting AI baseline text does NOT increase N
// - "Total Edits" is rendered on the FIRST/EXISTING "SOAP Note" heading (right side, same line)
// - No duplicate (second) "SOAP Note" heading is added by this script
// - Persistent 1rem spacing at end of transcript pane (left), across refresh/resizes
// - "Add EHR" stays disabled (red) always; "Just Save" is green
// - Clear / Just Save / Add EHR reset counters to 0

console.log('[SCRIBE] Booting Scribe Cockpit (updated: single heading, total edits on first heading, larger buttons)');

// ==========================
// DOM Elements (safe grabs)
// ==========================
const statusPill = document.getElementById('statusPill');
const deviceListEl = document.getElementById('deviceList');
const transcriptEl = document.getElementById('liveTranscript');
let soapHost = document.getElementById('soapNotePanel');
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
const LS_KEYS = {
  HISTORY: 'scribe.history',
  LATEST_SOAP: 'scribe.latestSoap',
  ACTIVE_ITEM_ID: 'scribe.activeItem',
};

const NGROK_URL = 'https://52846d7be156.ngrok-free.app';
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

// In-memory state
let latestSoapNote = {};                   // last received/edited SOAP
const transcriptState = { byKey: {} };     // incremental transcript merging
let soapNoteTimer = null;
let soapNoteStartTime = null;
let forceNoDevices = true;
let currentActiveItemId = null;
let soapGenerating = false;                // prevents editor render during generation

// A reference to the single global "Total Edits" badge (rendered on the first heading)
let totalEditsBadgeEl = null;

// ==========================
// BroadcastChannels
// ==========================
const transcriptBC = new BroadcastChannel('scribe-transcript');
const soapBC = new BroadcastChannel('scribe-soap-note');

// ==========================
// Styles for cards & SOAP
// ==========================
injectStyle(`
  .scribe-card{ position:relative;background:#1f2937;padding:12px;border-radius:10px;margin-bottom:10px; transition:background .15s ease;cursor:pointer }
  .scribe-card:hover{background:#222b3a}
  .scribe-card-active{outline:2px solid #2563eb;background:#243041}
  .scribe-delete{ position:absolute;top:8px;right:8px;color:#ef4444;font-size:16px;line-height:1;background:transparent;border:0;cursor:pointer }
  .scribe-delete:hover{transform:scale(1.1)}
  .scribe-soap-scroll{height:100%;overflow-y:auto;padding:12px}
  .scribe-section{background:#1f2937;padding:12px;border-radius:10px;margin-bottom:10px}
  .scribe-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .scribe-section h3{font-size:14px;font-weight:600;margin:0;color:#fff}
  .scribe-section .scribe-section-meta{font-size:13px;color:#a7f3d0;font-weight:600;margin-left:12px}
  .scribe-textarea{width:100%;background:#0f172a;color:#fff;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.06);resize:none;min-height:60px;outline:none}
  .scribe-soap-actions{ position:sticky;bottom:0;z-index:2;padding:10px;display:flex;gap:8px;justify-content:flex-end;
    background:linear-gradient(180deg,rgba(11,15,25,0),rgba(11,15,25,.85) 30%,rgba(11,15,25,1) 60%); margin:-12px;margin-top:6px;padding-top:16px }
  /* Buttons: make a bit longer / standard */
  .scribe-btn{padding:10px 18px;border-radius:10px;border:0;color:#fff;cursor:pointer;min-width:120px;font-weight:600}
  .scribe-btn-primary{background:#16a34a}.scribe-btn-primary:hover{background:#15803d} /* green for "Just Save" */
  .scribe-btn-ghost{background:#374151}.scribe-btn-ghost:hover{background:#4b5563}
  .scribe-add-ehr-disabled{background:#7f1d1d;color:#fff;opacity:0.95;cursor:not-allowed} /* always disabled & red */

  /* The single global Total Edits badge on the FIRST heading */
  ._scribe_total_edits{font-size:13px;color:#10b981;font-weight:700;margin-left:auto}

  /* Provide flex layout to the existing heading so badge sits on the right on the same line */
  .scribe-heading-flex{display:flex;align-items:center;gap:.75rem}
  .scribe-heading-flex > ._scribe_total_edits{margin-left:auto}

  /* Persistent 1rem space at the END of transcript pane (left) */
  #liveTranscript{ padding-bottom:1rem; }
  #liveTranscript .scribe-card:last-child{ margin-bottom:1rem; }
`);

// helper to inject CSS
function injectStyle(css){
  const s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
}

// ==========================
// localStorage helpers
// ==========================
function lsSafeParse(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch{ return fallback; }
}
function saveHistory(arr){ localStorage.setItem(LS_KEYS.HISTORY, JSON.stringify(arr||[])); }
function loadHistory(){ return lsSafeParse(LS_KEYS.HISTORY, []); }
function saveLatestSoap(soap){ localStorage.setItem(LS_KEYS.LATEST_SOAP, JSON.stringify(soap||{})); }
function loadLatestSoap(){ return lsSafeParse(LS_KEYS.LATEST_SOAP, {}); }
function saveActiveItemId(id){ localStorage.setItem(LS_KEYS.ACTIVE_ITEM_ID, id||''); }
function loadActiveItemId(){ return localStorage.getItem(LS_KEYS.ACTIVE_ITEM_ID) || ''; }
function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ==========================
// Status pillar
// ==========================
function setStatus(status){
  if(!statusPill) return;
  statusPill.textContent = status;
  statusPill.setAttribute('aria-label', `Connection status: ${status}`);
  statusPill.classList.remove('bg-yellow-500','bg-green-500','bg-red-600');
  switch((status||'').toLowerCase()){
    case 'connected': statusPill.classList.add('bg-green-500'); break;
    case 'disconnected': statusPill.classList.add('bg-red-600'); break;
    default: statusPill.classList.add('bg-yellow-500');
  }
}

// ==========================
// Devices
// ==========================
function showNoDevices(){
  if(!deviceListEl) return;
  deviceListEl.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'text-gray-400'; li.textContent = 'No devices online';
  deviceListEl.appendChild(li);
}
function updateDeviceList(devices){
  if(!Array.isArray(devices)) return;
  deviceListEl.innerHTML = '';
  devices.forEach(d=>{
    const name = d.deviceName || d.name || (d.xrId ? `Device (${d.xrId})` : 'Unknown');
    const li = document.createElement('li');
    li.className = 'text-gray-300';
    li.textContent = d.xrId ? `${name} (${d.xrId})` : name;
    deviceListEl.appendChild(li);
  });
  if(devices.length === 0) showNoDevices();
}

// ==========================
// Transcript helpers
// ==========================
function transcriptKey(from,to){ return `${from||'unknown'}->${to||'unknown'}`; }
function mergeIncremental(prev,next){
  if(!prev) return next||'';
  if(!next) return prev;
  if(next.startsWith(prev)) return next;
  if(prev.startsWith(next)) return prev;
  let k = Math.min(prev.length,next.length);
  while(k>0 && !prev.endsWith(next.slice(0,k))) k--;
  return prev + next.slice(k);
}
function ensureTranscriptPlaceholder(){
  if(!transcriptEl) return;
  if(!document.getElementById(PLACEHOLDER_ID)){
    const ph = document.createElement('p');
    ph.id = PLACEHOLDER_ID; ph.className = 'text-gray-400 italic';
    ph.textContent = 'No transcript yet…';
    transcriptEl.appendChild(ph);
  }
}
function removeTranscriptPlaceholder(){
  const ph = document.getElementById(PLACEHOLDER_ID);
  if(ph && ph.parentNode) ph.parentNode.removeChild(ph);
}

// ==========================
// Transcript UI (card, select, delete)
// ==========================
function createTranscriptCard(item){
  const {id,from,to,text,timestamp} = item;
  const card = document.createElement('div');
  card.className = 'scribe-card'; card.dataset.id = id;

  const header = document.createElement('div');
  header.className = 'text-sm mb-1';
  const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
  header.innerHTML = `🗣️ <span class="font-bold">${escapeHtml(from||'Unknown')}</span> <span class="opacity-60">→ ${escapeHtml(to||'Unknown')}</span> <span class="opacity-60">(${time})</span>`;
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'text-sm leading-6 text-gray-100';
  body.style.textAlign = 'justify';
  body.textContent = text || '';
  applyClamp(body, true);
  card.appendChild(body);

  const del = document.createElement('button');
  del.setAttribute('data-action','delete');
  del.className = 'scribe-delete'; del.title = 'Delete this transcript & linked SOAP';
  del.innerHTML = '🗑️';
  del.addEventListener('click', (e)=>{ e.stopPropagation(); deleteTranscriptItem(id); });
  card.appendChild(del);

  card.addEventListener('click', (e)=>{
    if(e.target.closest('button[data-action="delete"]')) return;
    setActiveTranscriptId(id);
    const collapsed = body.dataset.collapsed === 'true';
    applyClamp(body, !collapsed);
  });

  if(id === loadActiveItemId()) card.classList.add('scribe-card-active');
  return card;
}
function applyClamp(el,collapse=true){
  if(collapse){
    el.dataset.collapsed='true';
    el.style.display='-webkit-box';
    el.style.webkitBoxOrient='vertical';
    el.style.webkitLineClamp='4';
    el.style.overflow='hidden';
    el.style.maxHeight='';
  } else{
    el.dataset.collapsed='false';
    el.style.display='';
    el.style.webkitBoxOrient='';
    el.style.webkitLineClamp='';
    el.style.overflow='';
    el.style.maxHeight='none';
  }
}
function highlightActiveCard(){
  transcriptEl.querySelectorAll('.scribe-card').forEach(c=>c.classList.remove('scribe-card-active'));
  const active = transcriptEl.querySelector(`.scribe-card[data-id="${CSS.escape(loadActiveItemId())}"]`);
  if(active) active.classList.add('scribe-card-active');
}
function setActiveTranscriptId(id){
  currentActiveItemId = id; saveActiveItemId(id); highlightActiveCard();
  const hist = loadHistory();
  const item = hist.find(x=>x.id === id);
  const soap = item?.soap || {};
  latestSoapNote = Object.keys(soap).length ? soap : loadLatestSoap();
  if(!soapGenerating) renderSoapNote(latestSoapNote);
}
function trimTranscriptIfNeeded(){
  const cards = transcriptEl.querySelectorAll('.scribe-card');
  if(cards.length > MAX_TRANSCRIPT_LINES){
    const excess = cards.length - MAX_TRANSCRIPT_LINES;
    for(let i=0;i<excess;i++){
      const first = transcriptEl.querySelector('.scribe-card');
      if(first) transcriptEl.removeChild(first);
    }
  }
}
function appendTranscriptItem({from,to,text,timestamp}){
  if(!transcriptEl || !text) return;
  removeTranscriptPlaceholder();
  const item = { id: uid(), from: from||'Unknown', to: to||'Unknown', text: String(text||''), timestamp: timestamp||Date.now() };
  const history = loadHistory(); history.push(item); saveHistory(history);
  const card = createTranscriptCard(item);
  transcriptEl.appendChild(card);
  trimTranscriptIfNeeded();
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  setActiveTranscriptId(item.id);
}
function deleteTranscriptItem(id){
  const history = loadHistory(); const idx = history.findIndex(x=>x.id===id);
  if(idx === -1) return;
  history.splice(idx,1); saveHistory(history);
  const node = transcriptEl.querySelector(`.scribe-card[data-id="${CSS.escape(id)}"]`);
  if(node) node.remove();
  const remainingCards = transcriptEl.querySelectorAll('.scribe-card');
  if(remainingCards.length === 0){
    ensureTranscriptPlaceholder();
    latestSoapNote = {}; saveLatestSoap(latestSoapNote);
    saveActiveItemId('');
    if(!soapGenerating) renderSoapBlank();
    return;
  }
  const activeId = loadActiveItemId();
  if(activeId === id){
    const newActive = history.length ? history[history.length-1].id : '';
    if(newActive){
      setActiveTranscriptId(newActive);
    } else {
      latestSoapNote = {}; saveLatestSoap(latestSoapNote); saveActiveItemId('');
      if(!soapGenerating) renderSoapBlank();
    }
  } else {
    highlightActiveCard();
  }
}

// ==========================
// Edit math: insert-only distance vs AI baseline
// editCount = |current| - LCS(current, aiText)
// (counts only user insertions; deleting those insertions reduces count; deleting AI text doesn't add)
// ==========================
function computeInsertOnlyEdits(aiText, current){
  aiText = String(aiText||''); current = String(current||'');
  if(current === aiText) return 0;
  const MAX_CELLS = 800000;
  const n = current.length, m = aiText.length;
  if(n * m > MAX_CELLS){
    let i=0, j=0;
    while(i<n && j<m && current[i] === aiText[j]) { i++; j++; }
    let ii=n-1, jj=m-1;
    while(ii>=i && jj>=j && current[ii] === aiText[jj]) { ii--; jj--; }
    const approxCommon = i + (n-1-ii > 0 && m-1-jj > 0 ? Math.min(n-1-ii, m-1-jj) : 0);
    const lcsApprox = Math.min(approxCommon, Math.min(n,m));
    return Math.max(0, n - lcsApprox);
  }
  const prev = new Uint16Array(m+1);
  const curr = new Uint16Array(m+1);
  for(let i=1;i<=n;i++){
    for(let j=1;j<=m;j++){
      if(current.charCodeAt(i-1) === aiText.charCodeAt(j-1)){
        curr[j] = prev[j-1] + 1;
      }else{
        curr[j] = prev[j] > curr[j-1] ? prev[j] : curr[j-1];
      }
    }
    prev.set(curr);
  }
  const lcs = prev[m];
  return Math.max(0, n - lcs);
}

// ==========================
// SOAP Note rendering
// ==========================
function soapContainerEnsure(){
  let scroller = soapHost.querySelector('.scribe-soap-scroll');
  if(!scroller){
    scroller = document.createElement('div');
    scroller.className = 'scribe-soap-scroll scribe-scroll';
    soapHost.innerHTML = '';
    soapHost.appendChild(scroller);
  }
  return scroller;
}
function renderSoapBlank(){
  const scroller = soapContainerEnsure();
  scroller.innerHTML = ''; // blank per requirement
}
function autoExpandTextarea(el){ el.style.height='auto'; el.style.height = el.scrollHeight + 'px'; }

// Initialize AI meta (original AI text) and reset edit meta
function initializeEditMetaForSoap(soap){
  soap._aiMeta = soap._aiMeta || {};
  soap._editMeta = soap._editMeta || {};
  const sections = ['Chief Complaints','History of Present Illness','Subjective','Objective','Assessment','Plan','Medication'];
  sections.forEach(section=>{
    const val = soap?.[section] || '';
    const textBlock = Array.isArray(val) ? val.join('\n') : String(val||'');
    soap._aiMeta[section] = { text: textBlock };
    soap._editMeta[section] = { edits: 0 };
  });
}

// Persist current textarea values back into latestSoapNote and history
function persistSoapFromUI(){
  const scroller = soapContainerEnsure();
  const editors = scroller.querySelectorAll('textarea[data-section]');
  const soap = {};
  editors.forEach(t=>{
    soap[t.dataset.section] = t.value || '';
  });
  soap._aiMeta = (latestSoapNote && latestSoapNote._aiMeta) ? latestSoapNote._aiMeta : {};
  soap._editMeta = latestSoapNote?._editMeta || {};
  latestSoapNote = soap;
  saveLatestSoap(latestSoapNote);

  const activeId = loadActiveItemId();
  if(activeId){
    const hist = loadHistory(); const i = hist.findIndex(x=>x.id === activeId);
    if(i !== -1){ hist[i].soap = latestSoapNote; saveHistory(hist); }
  }
}

// === Single global Total Edits badge on FIRST heading ======================
// We do NOT create our own "SOAP Note" heading. Instead, we augment the FIRST
// existing "SOAP Note" heading in the page with a right-aligned badge.
function ensureTopHeadingBadge(){
  if (totalEditsBadgeEl && document.body.contains(totalEditsBadgeEl)) return totalEditsBadgeEl;

  // Try to find the first heading that says "SOAP Note"
  const candidates = Array.from(document.querySelectorAll('h1, h2, h3, [data-title]'));
  let heading = candidates.find(el => (el.textContent || '').trim().toLowerCase().startsWith('soap note'));

  // As a fallback, if no explicit title element found, create a lightweight one above our panel.
  if (!heading) {
    const fallbackWrap = document.createElement('div');
    fallbackWrap.className = 'scribe-heading-flex';
    const h = document.createElement('h2');
    h.textContent = 'SOAP Note';
    fallbackWrap.appendChild(h);
    // Insert right before our soapHost, so it becomes the first heading visually
    soapHost.parentNode?.insertBefore(fallbackWrap, soapHost);
    heading = fallbackWrap;
  }

  // Ensure the heading is flex so the badge floats to the right on the same line
  heading.classList.add('scribe-heading-flex');

  // Create / attach the single badge
  totalEditsBadgeEl = document.createElement('div');
  totalEditsBadgeEl.id = '_scribe_total_edits';
  totalEditsBadgeEl.className = '_scribe_total_edits';
  totalEditsBadgeEl.textContent = 'Total Edits: 0';

  // If heading is a plain H2, append badge into the same line
  heading.appendChild(totalEditsBadgeEl);
  return totalEditsBadgeEl;
}

// Update total edits and per-section badges
function updateTotalsAndEhrState(){
  const scroller = soapContainerEnsure();
  const editors = scroller.querySelectorAll('textarea[data-section]');
  let total = 0;
  editors.forEach(t=>{
    const m = t.dataset.editCount ? Number(t.dataset.editCount) : 0;
    total += m;
    const headMeta = scroller.querySelector(`.scribe-section[data-section="${CSS.escape(t.dataset.section)}"] .scribe-section-meta`);
    if(headMeta){
      headMeta.textContent = `Edits: ${m}`;
    }
  });

  // Update the SINGLE global badge on the first heading
  const badge = ensureTopHeadingBadge();
  if (badge) badge.textContent = `Total Edits: ${total}`;

  // Keep Add EHR disabled & red ALWAYS
  const addBtn = scroller.querySelector('#_scribe_add_ehr');
  if(addBtn){
    addBtn.disabled = true;
    addBtn.className = 'scribe-btn scribe-add-ehr-disabled';
  }
}

// Reset visual counters to 0 (logic used by Clear / Just Save / Add EHR)
function resetAllEditCountersToZero(){
  const scroller = soapContainerEnsure();
  const editors = scroller.querySelectorAll('textarea[data-section]');
  editors.forEach(textarea=>{
    textarea.dataset.editCount = '0';
    const headMeta = scroller.querySelector(`.scribe-section[data-section="${CSS.escape(textarea.dataset.section)}"] .scribe-section-meta`);
    if(headMeta) headMeta.textContent = `Edits: 0`;
  });
  if(latestSoapNote) latestSoapNote._editMeta = latestSoapNote._editMeta || {};
  Object.keys(latestSoapNote._aiMeta || {}).forEach(section => {
    latestSoapNote._editMeta[section] = { edits: 0 };
  });
  saveLatestSoap(latestSoapNote);
  updateTotalsAndEhrState();
}

// Attach insert-only edit tracking to a textarea
function attachEditTrackingToTextarea(box, aiText){
  box.dataset.aiText = aiText || '';
  const initialEdits = computeInsertOnlyEdits(aiText, box.value || '');
  box.dataset.editCount = String(initialEdits);

  const scroller = soapContainerEnsure();
  const headMeta = scroller.querySelector(`.scribe-section[data-section="${CSS.escape(box.dataset.section)}"] .scribe-section-meta`);
  if(headMeta){
    headMeta.textContent = `Edits: ${initialEdits}`;
  }

  let rafId = null;
  box.addEventListener('input', ()=>{
    autoExpandTextarea(box);
    if(rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(()=>{
      try{
        const ai = box.dataset.aiText || '';
        const now = box.value || '';
        const edits = computeInsertOnlyEdits(ai, now);
        box.dataset.editCount = String(edits);
        latestSoapNote = latestSoapNote || {};
        latestSoapNote._editMeta = latestSoapNote._editMeta || {};
        latestSoapNote._editMeta[box.dataset.section] = { edits };
        saveLatestSoap(latestSoapNote);

        const headMetaNow = scroller.querySelector(`.scribe-section[data-section="${CSS.escape(box.dataset.section)}"] .scribe-section-meta`);
        if(headMetaNow) headMetaNow.textContent = `Edits: ${edits}`;
        updateTotalsAndEhrState();
        persistSoapFromUI();
      }catch(e){ console.warn('[SCRIBE] input handler error', e); }
      rafId = null;
    });
  });
}

// Render the SOAP note with editors (NO second heading is created here)
function renderSoapNote(soap){
  if(soapGenerating) return;
  const scroller = soapContainerEnsure();
  scroller.innerHTML = '';

  // Ensure the single global badge exists on the FIRST heading
  ensureTopHeadingBadge();

  const sections = ['Chief Complaints','History of Present Illness','Subjective','Objective','Assessment','Plan','Medication'];

  if(soap && Object.keys(soap).length && !soap._aiMeta){
    initializeEditMetaForSoap(soap);
  }

  latestSoapNote = latestSoapNote || soap || {};
  latestSoapNote._aiMeta = latestSoapNote._aiMeta || (soap ? soap._aiMeta : {}) || {};
  latestSoapNote._editMeta = latestSoapNote._editMeta || (soap ? soap._editMeta : {}) || {};

  sections.forEach(section=>{
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

    const initialEdits = computeInsertOnlyEdits(aiText, contentText);
    latestSoapNote._editMeta[section] = { edits: initialEdits };
    box.dataset.editCount = String(initialEdits);

    wrap.appendChild(box);
    scroller.appendChild(wrap);

    attachEditTrackingToTextarea(box, aiText);
  });

  // Actions (Clear, Just Save, Add EHR[disabled])
  const actions = document.createElement('div');
  actions.className = 'scribe-soap-actions';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'scribe-btn scribe-btn-ghost';
  clearBtn.textContent = 'Clear';
  clearBtn.onclick = ()=>{
    scroller.querySelectorAll('textarea[data-section]').forEach(t=>{
      t.value = '';
      autoExpandTextarea(t);
      t.dataset.editCount = '0';
      const headMeta = scroller.querySelector(`.scribe-section[data-section="${CSS.escape(t.dataset.section)}"] .scribe-section-meta`);
      if(headMeta) headMeta.textContent = `Edits: 0`;
    });
    persistSoapFromUI();
    resetAllEditCountersToZero();
    console.log('[SCRIBE] SOAP cleared and edit counters reset.');
  };

  const saveBtn = document.createElement('button');
  saveBtn.className = 'scribe-btn scribe-btn-primary';
  saveBtn.textContent = 'Save';
  saveBtn.onclick = ()=>{
    persistSoapFromUI();
    resetAllEditCountersToZero();
    console.log('[SCRIBE] SOAP saved and edit counters reset.');
  };

  const addEhrBtn = document.createElement('button');
  addEhrBtn.id = '_scribe_add_ehr';
  addEhrBtn.className = 'scribe-btn scribe-add-ehr-disabled';
  addEhrBtn.textContent = 'Add To EHR';
  addEhrBtn.disabled = true;
  addEhrBtn.onclick = ()=>{
    console.log('[SCRIBE] Add EHR is disabled (placeholder).');
    resetAllEditCountersToZero();
  };

  actions.appendChild(clearBtn);
  actions.appendChild(saveBtn);
  actions.appendChild(addEhrBtn);
  scroller.appendChild(actions);

  saveLatestSoap(latestSoapNote);
  updateTotalsAndEhrState();

  scroller.scrollTop = 0;
  const firstBox = scroller.querySelector('textarea[data-section]');
  if(firstBox){
    try{ firstBox.focus(); }catch{}
  }
}

// Rendering while AI generating (NO duplicate heading; keep the single top badge)
function renderSoapNoteGenerating(elapsed){
  const scroller = soapContainerEnsure();
  scroller.innerHTML = `
    <div class="scribe-section" style="text-align:center; color:#fbbf24;">
      Please wait, AI is generating the SOAP note… ${elapsed}s
    </div>
  `;
  ensureTopHeadingBadge();
}

// ==========================
// Signals
// ==========================
function handleSignalMessage(packet){
  if(!packet?.type) return;

  if(packet.type === 'transcript_console'){
    const p = packet.data || {};
    const { from, to, text = '', final = false, timestamp } = p;
    const key = transcriptKey(from,to);
    const slot = (transcriptState.byKey[key] ||= { partial:'', paragraph:'', flushTimer:null });

    if(!final){
      slot.partial = text;
      return;
    }

    const mergedFinal = mergeIncremental(slot.partial, text);
    slot.partial = '';
    slot.paragraph = mergeIncremental(slot.paragraph ? slot.paragraph + ' ' : '', mergedFinal);

    if(slot.flushTimer) clearTimeout(slot.flushTimer);
    slot.flushTimer = setTimeout(()=>{
      if(slot.paragraph){
        appendTranscriptItem({ from, to, text: slot.paragraph, timestamp });
        transcriptBC.postMessage({ type:'transcript_console', data: { from, to, text: slot.paragraph, final: true, timestamp }});
        slot.paragraph = '';
      }
      slot.flushTimer = null;
    }, 800);

    if(!soapNoteTimer){
      soapGenerating = true;
      renderSoapNoteGenerating(0);
      soapNoteStartTime = Date.now();
      soapNoteTimer = setInterval(()=>{
        const elapsedSec = Math.floor((Date.now() - soapNoteStartTime) / 1000);
        renderSoapNoteGenerating(elapsedSec);
      }, 1000);
    }
  }

  else if(packet.type === 'soap_note_console'){
    const soap = packet.data || {};
    initializeEditMetaForSoap(soap);
    latestSoapNote = soap; saveLatestSoap(latestSoapNote);

    const activeId = loadActiveItemId();
    if(activeId){
      const hist = loadHistory(); const i = hist.findIndex(x=>x.id === activeId);
      if(i !== -1){ hist[i].soap = latestSoapNote; saveHistory(hist); }
    }

    soapBC.postMessage({ type:'soap_note_console', data: soap, timestamp: packet.timestamp || Date.now() });

    if(soapNoteTimer){ clearInterval(soapNoteTimer); soapNoteTimer = null; }
    soapGenerating = false;
    renderSoapNote(latestSoapNote);
  }
}

// Mirror BroadcastChannel events
try{
  transcriptBC.onmessage = (e) => handleSignalMessage(e.data);
  soapBC.onmessage = (e) => handleSignalMessage(e.data);
}catch(e){ console.warn('[SCRIBE] BroadcastChannel unavailable:', e); }

// ==========================
// Socket.IO
// ==========================
async function loadScript(src, timeoutMs = 8000){
  return new Promise((resolve,reject)=>{
    const s = document.createElement('script'); s.src = src; s.async = true;
    let done = false;
    const timer = setTimeout(()=>{ if(!done){ done = true; s.remove(); reject(new Error(`Timeout loading ${src}`)); }}, timeoutMs);
    s.onload = ()=>{ if(!done){ done = true; clearTimeout(timer); resolve(); } };
    s.onerror = ()=>{ if(!done){ done = true; clearTimeout(timer); reject(new Error(`Failed to load ${src}`)); } };
    document.head.appendChild(s);
  });
}
async function loadSocketIoClientFor(endpointBase){
  if(window.io) return;
  const endpointClient = `${endpointBase}/socket.io/socket.io.js`;
  try{
    console.log('[SCRIBE] Trying Socket.IO client from:', endpointClient);
    await loadScript(endpointClient);
    if(window.io) return;
  }catch(e){ console.warn('[SCRIBE] Load failed:', String(e)); }
  const CDN = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
  console.log('[SCRIBE] Falling back to Socket.IO CDN:', CDN);
  await loadScript(CDN);
  if(!window.io) throw new Error('Socket.IO client not available after CDN load.');
}
function connectTo(endpointBase, onFailover){
  return new Promise(resolve=>{
    setStatus('Connecting');
    SERVER_URL = endpointBase;
    const opts = { path: '/socket.io', transports: ['websocket'], reconnection: true, secure: SERVER_URL.startsWith('https://') };
    try{ socket?.close(); }catch{}
    socket = window.io(SERVER_URL, opts);

    let connected = false;
    const failTimer = setTimeout(()=>{ if(!connected) onFailover?.(); }, 4000);

    socket.on('connect', ()=>{
      connected = true; clearTimeout(failTimer);
      socket.emit('request_device_list');
      socket.on('device_list', updateDeviceList);
      socket.on('signal', handleSignalMessage);
      setStatus('Connected');
      resolve();
    });

    socket.on('connect_error', err => console.warn('[SCRIBE] connect_error:', err));
    socket.on('disconnect', ()=>{ showNoDevices(); setStatus('Disconnected'); });
  });
}

// ==========================
// Restore from localStorage
// ==========================
function restoreFromLocalStorage(){
  // Transcript history
  transcriptEl.innerHTML = '';
  const history = loadHistory();
  if(history.length === 0){ ensureTranscriptPlaceholder(); }
  else{
    removeTranscriptPlaceholder();
    history.forEach(item => transcriptEl.appendChild(createTranscriptCard(item)));
  }

  // SOAP
  latestSoapNote = loadLatestSoap();
  const historyList = loadHistory();
  currentActiveItemId = loadActiveItemId() || (historyList.length ? historyList[historyList.length-1].id : '');
  if(!currentActiveItemId && historyList.length){
    currentActiveItemId = historyList[historyList.length-1].id; saveActiveItemId(currentActiveItemId);
  }
  highlightActiveCard();

  // Ensure the single global badge is present on the FIRST heading
  ensureTopHeadingBadge();

  if(historyList.length === 0){
    renderSoapBlank();
  } else {
    renderSoapNote(latestSoapNote || {});
  }
}

// ==========================
// Boot
// ==========================
(async function boot(){
  try{
    ensureTranscriptPlaceholder();
    showNoDevices();

    restoreFromLocalStorage();

    await loadSocketIoClientFor(preferred);
    await connectTo(preferred, async ()=>{
      if(!window.io) await loadSocketIoClientFor(fallback);
      await connectTo(fallback);
    });

    console.log('[SCRIBE] Cockpit booted successfully');
  }catch(e){
    console.error('[SCRIBE] Failed to initialize:', e);
    setStatus('Disconnected');
    if(deviceListEl){
      deviceListEl.innerHTML = `<li class="text-red-400">Could not initialize cockpit. Ensure your signaling server is live: ${isLocal ? 'NGROK' : 'AZURE'}</li>`;
    }
  }
})();

// ==========================
// Helpers
// ==========================
function escapeHtml(str){
  return String(str||'')
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'","&#039;");
}
