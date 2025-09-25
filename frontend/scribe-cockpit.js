// -------------------------------------------------- Scribe-cockpit.js --------------------------------------------------
// - Constant headers in both panes (defined in HTML)
// - Connected Devices stays fixed; "Live Translation" header fixed; only inner areas scroll (grey scrollbars)
// - Red bin delete; deleting transcript removes linked SOAP and reselects newest
// - Right pane is BLANK when there is no transcript (no editors rendered)
// - No flicker while generating: show a single "Generating..." card; editors only after SOAP arrives
// - Click a transcript → load its linked SOAP
// -----------------------------------------------------------------------------------------------------------------------

console.log('[SCRIBE] Booting Scribe Cockpit');

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
  HISTORY: 'scribe.history',           // Array<{id, from, to, text, timestamp, soap?}>
  LATEST_SOAP: 'scribe.latestSoap',    // SOAP object (latest in UI)
  ACTIVE_ITEM_ID: 'scribe.activeItem', // Which transcript item the SOAP corresponds to
};

const NGROK_URL = 'https://9b7f761efa3b.ngrok-free.app';
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

// ==========================
// BroadcastChannels
// ==========================
const transcriptBC = new BroadcastChannel('scribe-transcript');
const soapBC = new BroadcastChannel('scribe-soap-note');

// ==========================
// Styles for cards & SOAP (bin in red)
// ==========================
injectStyle(`
  .scribe-card{
    position:relative;background:#1f2937;padding:12px;border-radius:10px;margin-bottom:10px;
    transition:background .15s ease;cursor:pointer
  }
  .scribe-card:hover{background:#222b3a}
  .scribe-card-active{outline:2px solid #2563eb;background:#243041}
  .scribe-delete{
    position:absolute;top:8px;right:8px;color:#ef4444;font-size:16px;line-height:1;background:transparent;border:0;cursor:pointer
  }
  .scribe-delete:hover{transform:scale(1.1)}
  .scribe-soap-scroll{height:100%;overflow-y:auto;padding:12px}
  .scribe-section{background:#1f2937;padding:12px;border-radius:10px;margin-bottom:10px}
  .scribe-section h3{font-size:14px;font-weight:600;margin-bottom:8px;color:#fff}
  .scribe-textarea{width:100%;background:#0f172a;color:#fff;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.06);resize:none;min-height:60px;outline:none}
  .scribe-soap-actions{
    position:sticky;bottom:0;z-index:2;padding:10px;display:flex;gap:8px;justify-content:flex-end;
    background:linear-gradient(180deg,rgba(11,15,25,0),rgba(11,15,25,.85) 30%,rgba(11,15,25,1) 60%);
    margin:-12px;margin-top:6px;padding-top:16px
  }
  .scribe-btn{padding:8px 12px;border-radius:10px;border:0;color:#fff;cursor:pointer}
  .scribe-btn-primary{background:#2563eb}.scribe-btn-primary:hover{background:#1d4ed8}
  .scribe-btn-ghost{background:#374151}.scribe-btn-ghost:hover{background:#4b5563}

  /* Grey scrollbars for SOAP area as well */
  .scribe-soap-scroll::-webkit-scrollbar{width:10px}
  .scribe-soap-scroll::-webkit-scrollbar-track{background:#0b0f19;border-radius:10px}
  .scribe-soap-scroll::-webkit-scrollbar-thumb{background:#6b7280;border-radius:10px;border:2px solid #0b0f19}
  .scribe-soap-scroll::-webkit-scrollbar-thumb:hover{background:#9ca3af}
  .scribe-soap-scroll{scrollbar-width:thin;scrollbar-color:#6b7280 #0b0f19}
`);

function injectStyle(css){ const s=document.createElement('style'); s.textContent=css; document.head.appendChild(s); }

// ==========================
// localStorage helpers
// ==========================
function lsSafeParse(key, fallback){ try{ const raw=localStorage.getItem(key); return raw?JSON.parse(raw):fallback; }catch{ return fallback; } }
function saveHistory(arr){ localStorage.setItem(LS_KEYS.HISTORY, JSON.stringify(arr||[])); }
function loadHistory(){ return lsSafeParse(LS_KEYS.HISTORY, []); }
function saveLatestSoap(soap){ localStorage.setItem(LS_KEYS.LATEST_SOAP, JSON.stringify(soap||{})); }
function loadLatestSoap(){ return lsSafeParse(LS_KEYS.LATEST_SOAP, {}); }
function saveActiveItemId(id){ localStorage.setItem(LS_KEYS.ACTIVE_ITEM_ID, id||''); }
function loadActiveItemId(){ return localStorage.getItem(LS_KEYS.ACTIVE_ITEM_ID)||''; }
function uid(){ return Math.random().toString(36).slice(2)+Date.now().toString(36); }

// ==========================
// Status pillar
// ==========================
function setStatus(status){
  if(!statusPill) return;
  statusPill.textContent=status;
  statusPill.setAttribute('aria-label',`Connection status: ${status}`);
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
  deviceListEl.innerHTML='';
  const li=document.createElement('li');
  li.className='text-gray-400'; li.textContent='No devices online';
  deviceListEl.appendChild(li);
}
function updateDeviceList(devices){
  if(!Array.isArray(devices)) return;
  deviceListEl.innerHTML='';
  devices.forEach(d=>{
    const name=d.deviceName||d.name||(d.xrId?`Device (${d.xrId})`:'Unknown');
    const li=document.createElement('li');
    li.className='text-gray-300';
    li.textContent=d.xrId?`${name} (${d.xrId})`:name;
    deviceListEl.appendChild(li);
  });
  if(devices.length===0) showNoDevices();
}

// ==========================
// Transcript helpers
// ==========================
function transcriptKey(from,to){ return `${from||'unknown'}->${to||'unknown'}`; }
function mergeIncremental(prev,next){
  if(!prev) return next||''; if(!next) return prev;
  if(next.startsWith(prev)) return next;
  if(prev.startsWith(next)) return prev;
  let k=Math.min(prev.length,next.length);
  while(k>0 && !prev.endsWith(next.slice(0,k))) k--;
  return prev+next.slice(k);
}
function ensureTranscriptPlaceholder(){
  if(!transcriptEl) return;
  if(!document.getElementById(PLACEHOLDER_ID)){
    const ph=document.createElement('p');
    ph.id=PLACEHOLDER_ID; ph.className='text-gray-400 italic';
    ph.textContent='No transcript yet…';
    transcriptEl.appendChild(ph);
  }
}
function removeTranscriptPlaceholder(){
  const ph=document.getElementById(PLACEHOLDER_ID);
  if(ph && ph.parentNode) ph.parentNode.removeChild(ph);
}

// ==========================
// Transcript UI (card, select, delete)
// ==========================
function createTranscriptCard(item){
  const {id,from,to,text,timestamp}=item;
  const card=document.createElement('div');
  card.className='scribe-card'; card.dataset.id=id;

  const header=document.createElement('div');
  header.className='text-sm mb-1';
  const time=timestamp?new Date(timestamp).toLocaleTimeString():new Date().toLocaleTimeString();
  header.innerHTML=`🗣️ <span class="font-bold">${escapeHtml(from||'Unknown')}</span> <span class="opacity-60">→ ${escapeHtml(to||'Unknown')}</span> <span class="opacity-60">(${time})</span>`;
  card.appendChild(header);

  const body=document.createElement('div');
  body.className='text-sm leading-6 text-gray-100';
  body.style.textAlign='justify';
  body.textContent=text||'';
  applyClamp(body,true);
  card.appendChild(body);

  const del=document.createElement('button');
  del.setAttribute('data-action','delete');
  del.className='scribe-delete'; del.title='Delete this transcript & linked SOAP'; del.innerHTML='🗑️';
  del.addEventListener('click',(e)=>{ e.stopPropagation(); deleteTranscriptItem(id); });
  card.appendChild(del);

  card.addEventListener('click',(e)=>{
    if(e.target.closest('button[data-action="delete"]')) return;
    setActiveTranscriptId(id);
    const collapsed=body.dataset.collapsed==='true';
    applyClamp(body,!collapsed);
  });

  if(id===loadActiveItemId()) card.classList.add('scribe-card-active');
  return card;
}
function applyClamp(el,collapse=true){
  if(collapse){ el.dataset.collapsed='true'; el.style.display='-webkit-box'; el.style.webkitBoxOrient='vertical'; el.style.webkitLineClamp='4'; el.style.overflow='hidden'; el.style.maxHeight=''; }
  else{ el.dataset.collapsed='false'; el.style.display=''; el.style.webkitBoxOrient=''; el.style.webkitLineClamp=''; el.style.overflow=''; el.style.maxHeight='none'; }
}
function highlightActiveCard(){
  transcriptEl.querySelectorAll('.scribe-card').forEach(c=>c.classList.remove('scribe-card-active'));
  const active=transcriptEl.querySelector(`.scribe-card[data-id="${CSS.escape(loadActiveItemId())}"]`);
  if(active) active.classList.add('scribe-card-active');
}
function setActiveTranscriptId(id){
  currentActiveItemId=id; saveActiveItemId(id); highlightActiveCard();
  const hist=loadHistory();
  const item=hist.find(x=>x.id===id);
  const soap=item?.soap||{};
  latestSoapNote=Object.keys(soap).length?soap:loadLatestSoap();
  if(!soapGenerating) renderSoapNote(latestSoapNote); // editors only if not generating
}
function trimTranscriptIfNeeded(){
  const cards=transcriptEl.querySelectorAll('.scribe-card');
  if(cards.length>MAX_TRANSCRIPT_LINES){
    const excess=cards.length-MAX_TRANSCRIPT_LINES;
    for(let i=0;i<excess;i++){ const first=transcriptEl.querySelector('.scribe-card'); if(first) transcriptEl.removeChild(first); }
  }
}
function appendTranscriptItem({from,to,text,timestamp}){
  if(!transcriptEl || !text) return;
  removeTranscriptPlaceholder();
  const item={ id:uid(), from:from||'Unknown', to:to||'Unknown', text:String(text||''), timestamp:timestamp||Date.now() };
  const history=loadHistory(); history.push(item); saveHistory(history);
  const card=createTranscriptCard(item);
  transcriptEl.appendChild(card);
  trimTranscriptIfNeeded();
  transcriptEl.scrollTop=transcriptEl.scrollHeight;
  setActiveTranscriptId(item.id);
}
function deleteTranscriptItem(id){
  const history=loadHistory();
  const idx=history.findIndex(x=>x.id===id);
  if(idx===-1) return;
  history.splice(idx,1);
  saveHistory(history);

  const node=transcriptEl.querySelector(`.scribe-card[data-id="${CSS.escape(id)}"]`);
  if(node) node.remove();

  const remainingCards=transcriptEl.querySelectorAll('.scribe-card');
  if(remainingCards.length===0){
    ensureTranscriptPlaceholder();
    latestSoapNote={}; saveLatestSoap(latestSoapNote);
    saveActiveItemId('');
    if(!soapGenerating) renderSoapBlank();  // blank right pane if no transcripts
    return;
  }

  const activeId=loadActiveItemId();
  if(activeId===id){
    const newActive=history.length?history[history.length-1].id:'';
    if(newActive){ setActiveTranscriptId(newActive); }
    else{
      latestSoapNote={}; saveLatestSoap(latestSoapNote); saveActiveItemId('');
      if(!soapGenerating) renderSoapBlank();
    }
  }else{
    highlightActiveCard();
  }
}

// ==========================
/* SOAP Note rendering
   - renderSoapBlank(): completely blank right pane (no editors)
   - renderSoapNote(): editors with content
   - renderSoapNoteGenerating(): single generating panel (no editors)
*/
function soapContainerEnsure(){
  let scroller=soapHost.querySelector('.scribe-soap-scroll');
  if(!scroller){
    scroller=document.createElement('div');
    scroller.className='scribe-soap-scroll scribe-scroll';
    soapHost.innerHTML='';
    soapHost.appendChild(scroller);
  }
  return scroller;
}
function renderSoapBlank(){
  const scroller=soapContainerEnsure();
  scroller.innerHTML=''; // blank per requirement
}
function autoExpandTextarea(el){ el.style.height='auto'; el.style.height=el.scrollHeight+'px'; }
function persistSoapFromUI(){
  const scroller=soapContainerEnsure();
  const editors=scroller.querySelectorAll('textarea[data-section]');
  const soap={};
  editors.forEach(t=>{ soap[t.dataset.section]=t.value||''; });
  latestSoapNote=soap; saveLatestSoap(latestSoapNote);

  const activeId=loadActiveItemId();
  if(activeId){
    const hist=loadHistory(); const i=hist.findIndex(x=>x.id===activeId);
    if(i!==-1){ hist[i].soap=latestSoapNote; saveHistory(hist); }
  }
}
function renderSoapNote(soap){
  if(soapGenerating) return; // guard
  const scroller=soapContainerEnsure();
  scroller.innerHTML='';

  const sections=['Chief Complaints','History of Present Illness','Subjective','Objective','Assessment','Plan','Medication'];
  sections.forEach(section=>{
    const wrap=document.createElement('div'); wrap.className='scribe-section';
    const h=document.createElement('h3'); h.textContent=section;
    const box=document.createElement('textarea'); box.className='scribe-textarea'; box.readOnly=false; box.dataset.section=section;
    const val=soap?.[section];
    box.value=Array.isArray(val)?val.join('\n'):typeof val==='string'?val:'';
    autoExpandTextarea(box);
    box.addEventListener('input',()=>{ autoExpandTextarea(box); if(renderSoapNote._debounce) cancelAnimationFrame(renderSoapNote._debounce); renderSoapNote._debounce=requestAnimationFrame(()=>persistSoapFromUI()); });
    wrap.appendChild(h); wrap.appendChild(box); scroller.appendChild(wrap);
  });

  const actions=document.createElement('div'); actions.className='scribe-soap-actions';
  const clearBtn=document.createElement('button'); clearBtn.className='scribe-btn scribe-btn-ghost'; clearBtn.textContent='Clear';
  clearBtn.onclick=()=>{ scroller.querySelectorAll('textarea[data-section]').forEach(t=>{ t.value=''; autoExpandTextarea(t); }); persistSoapFromUI(); };
  const saveBtn=document.createElement('button'); saveBtn.className='scribe-btn scribe-btn-primary'; saveBtn.textContent='Save SOAP';
  saveBtn.onclick=()=>{ persistSoapFromUI(); console.log('[SCRIBE] SOAP saved.'); };
  actions.appendChild(clearBtn); actions.appendChild(saveBtn); scroller.appendChild(actions);

  scroller.scrollTop=scroller.scrollHeight;
}
function renderSoapNoteGenerating(elapsed){
  const scroller=soapContainerEnsure();
  scroller.innerHTML=`
    <div class="scribe-section" style="text-align:center; color:#fbbf24;">
      Please wait, AI is generating the SOAP note… ${elapsed}s
    </div>
  `;
}

// ==========================
// Signals
// ==========================
function handleSignalMessage(packet){
  if(!packet?.type) return;

  if(packet.type==='transcript_console'){
    const p=packet.data||{};
    const { from, to, text='', final=false, timestamp }=p;
    const key=transcriptKey(from,to);
    const slot=(transcriptState.byKey[key] ||= { partial:'', paragraph:'', flushTimer:null });

    if(!final){ slot.partial=text; return; }

    const mergedFinal=mergeIncremental(slot.partial,text);
    slot.partial='';
    slot.paragraph=mergeIncremental(slot.paragraph?slot.paragraph+' ':'', mergedFinal);

    if(slot.flushTimer) clearTimeout(slot.flushTimer);
    slot.flushTimer=setTimeout(()=>{
      if(slot.paragraph){
        appendTranscriptItem({ from, to, text:slot.paragraph, timestamp });
        transcriptBC.postMessage({ type:'transcript_console', data:{ from, to, text:slot.paragraph, final:true, timestamp }});
        slot.paragraph='';
      }
      slot.flushTimer=null;
    }, 800);

    // Start "generating" and keep right pane free of editors
    if(!soapNoteTimer){
      soapGenerating=true;
      renderSoapNoteGenerating(0);
      soapNoteStartTime=Date.now();
      soapNoteTimer=setInterval(()=>{
        const elapsed=Math.floor((Date.now()-soapNoteStartTime)/1000);
        renderSoapNoteGenerating(elapsed);
      }, 1000);
    }
  }

  else if(packet.type==='soap_note_console'){
    const soap=packet.data||{};
    latestSoapNote=soap; saveLatestSoap(latestSoapNote);

    const activeId=loadActiveItemId();
    if(activeId){
      const hist=loadHistory(); const i=hist.findIndex(x=>x.id===activeId);
      if(i!==-1){ hist[i].soap=latestSoapNote; saveHistory(hist); }
    }

    soapBC.postMessage({ type:'soap_note_console', data:soap, timestamp:packet.timestamp||Date.now() });

    if(soapNoteTimer){ clearInterval(soapNoteTimer); soapNoteTimer=null; }
    soapGenerating=false;
    renderSoapNote(latestSoapNote);
  }
}

// Mirror BroadcastChannel events
try{
  transcriptBC.onmessage=(e)=>handleSignalMessage(e.data);
  soapBC.onmessage=(e)=>handleSignalMessage(e.data);
}catch(e){ console.warn('[SCRIBE] BroadcastChannel unavailable:', e); }

// ==========================
// Socket.IO
// ==========================
async function loadScript(src, timeoutMs=8000){
  return new Promise((resolve,reject)=>{
    const s=document.createElement('script'); s.src=src; s.async=true;
    let done=false;
    const timer=setTimeout(()=>{ if(!done){ done=true; s.remove(); reject(new Error(`Timeout loading ${src}`)); } }, timeoutMs);
    s.onload=()=>{ if(!done){ done=true; clearTimeout(timer); resolve(); } };
    s.onerror=()=>{ if(!done){ done=true; clearTimeout(timer); reject(new Error(`Failed to load ${src}`)); } };
    document.head.appendChild(s);
  });
}
async function loadSocketIoClientFor(endpointBase){
  if(window.io) return;
  const endpointClient=`${endpointBase}/socket.io/socket.io.js`;
  try{
    console.log('[SCRIBE] Trying Socket.IO client from:', endpointClient);
    await loadScript(endpointClient);
    if(window.io) return;
  }catch(e){ console.warn('[SCRIBE] Load failed:', String(e)); }
  const CDN='https://cdn.socket.io/4.7.5/socket.io.min.js';
  console.log('[SCRIBE] Falling back to Socket.IO CDN:', CDN);
  await loadScript(CDN);
  if(!window.io) throw new Error('Socket.IO client not available after CDN load.');
}
function connectTo(endpointBase, onFailover){
  return new Promise(resolve=>{
    setStatus('Connecting');
    SERVER_URL=endpointBase;
    const opts={ path:'/socket.io', transports:['websocket'], reconnection:true, secure:SERVER_URL.startsWith('https://') };
    try{ socket?.close(); }catch{}
    socket=window.io(SERVER_URL, opts);

    let connected=false;
    const failTimer=setTimeout(()=>{ if(!connected) onFailover?.(); }, 4000);

    socket.on('connect', ()=>{
      connected=true; clearTimeout(failTimer);
      socket.emit('request_device_list');
      socket.on('device_list', updateDeviceList);
      socket.on('signal', handleSignalMessage);
      setStatus('Connected');
      resolve();
    });

    socket.on('connect_error', err=>console.warn('[SCRIBE] connect_error:', err));
    socket.on('disconnect', ()=>{ showNoDevices(); setStatus('Disconnected'); });
  });
}

// ==========================
// Restore from localStorage
// ==========================
function restoreFromLocalStorage(){
  // Transcript history
  transcriptEl.innerHTML='';
  const history=loadHistory();
  if(history.length===0){ ensureTranscriptPlaceholder(); }
  else{
    removeTranscriptPlaceholder();
    history.forEach(item=> transcriptEl.appendChild(createTranscriptCard(item)));
  }

  // SOAP
  latestSoapNote=loadLatestSoap();
  currentActiveItemId=loadActiveItemId() || (history.length ? history[history.length-1].id : '');
  if(!currentActiveItemId && history.length){
    currentActiveItemId=history[history.length-1].id; saveActiveItemId(currentActiveItemId);
  }
  highlightActiveCard();

  // If there are no transcripts at all, keep right pane BLANK
  if(history.length===0){ renderSoapBlank(); }
  else{ renderSoapNote(latestSoapNote||{}); }
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
    .replaceAll('"','&quot;').replaceAll("'",'&#039;');
}
