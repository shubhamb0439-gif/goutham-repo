// /public/js/config.js
(function () {
  const qp = new URLSearchParams(location.search);
  const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '') ?? null;
  const up = v => (v ? String(v).trim().toUpperCase() : v);

  // SIGNAL URL priority: ?signal → injected → stored → same-origin → ngrok fallback
  const override = qp.get('signal');
  const injected = (typeof window !== 'undefined' && window.__SIGNAL_URL__) || null;
  let stored = null; try { stored = localStorage.getItem('signal_url') || null; } catch {}
  const sameOrigin = (location && location.origin) || null;
  const ngrokFallback = (typeof window !== 'undefined' && window.__NGROK_FALLBACK__) || 'http://localhost:3000';

  window.SIGNAL_URL = pick(override, injected, stored, sameOrigin, ngrokFallback);
  if (override) { try { localStorage.setItem('signal_url', window.SIGNAL_URL); } catch {} }

  // ICE servers (keep in sync with APK). TURN can be injected if you have it.
  const injectedIce = (typeof window !== 'undefined' && window.__ICE_SERVERS__) || null;
  const turnUrl  = (typeof window !== 'undefined' && window.__TURN_URL__) || null;
  const turnUser = (typeof window !== 'undefined' && window.__TURN_USERNAME__) || null;
  const turnCred = (typeof window !== 'undefined' && window.__TURN_CREDENTIAL__) || null;
  const defaultIce = [{ urls: 'stun:stun.l.google.com:19302' }];
  const maybeTurn  = (turnUrl && turnUser && turnCred) ? [{ urls: turnUrl, username: turnUser, credential: turnCred }] : [];
  window.ICE_SERVERS = injectedIce || defaultIce.concat(maybeTurn);

  // XR IDs (overrideable via query or injection)
  const injectedDevice   = (typeof window !== 'undefined' && window.__XR_DEVICE_ID__) || null;
  const injectedOperator = (typeof window !== 'undefined' && window.__XR_OPERATOR_ID__) || null;
  const qpDevice   = qp.get('device')   || qp.get('deviceId')   || qp.get('xr_device');
  const qpOperator = qp.get('operator') || qp.get('operatorId') || qp.get('xr_operator');
  window.XR_DEVICE_ID   = up(pick(qpDevice, injectedDevice, 'XR-1234'));
  window.XR_OPERATOR_ID = up(pick(qpOperator, injectedOperator, 'XR-1238'));

  console.log('[CONFIG] SIGNAL:', window.SIGNAL_URL);
  console.log('[CONFIG] ICE_SERVERS:', window.ICE_SERVERS);
  console.log('[CONFIG] XR IDs:', { device: window.XR_DEVICE_ID, operator: window.XR_OPERATOR_ID });
})();
