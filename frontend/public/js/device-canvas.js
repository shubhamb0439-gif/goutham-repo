const ORB_PX = 185;
document.querySelector('.orb-root').style.setProperty('--orb-size', ORB_PX + 'px');

const SC = document.getElementById('sc');
const WC = document.getElementById('wc');
const shell = document.getElementById('shell');
const scx = SC.getContext('2d');
const wcx = WC.getContext('2d');

function resizeCanvases() {
  SC.width = shell.offsetWidth || 390;
  SC.height = shell.offsetHeight || 844;
  const r = WC.parentElement.getBoundingClientRect();
  WC.width = Math.round(r.width) || ORB_PX;
  WC.height = Math.round(r.height) || ORB_PX;
}
resizeCanvases();
setTimeout(resizeCanvases, 80);
setTimeout(resizeCanvases, 300);
window.addEventListener('resize', resizeCanvases);

const STARS = Array.from({ length: 55 }, () => ({
  x: Math.random(), y: Math.random(),
  r: Math.random() * .65 + .12,
  a: Math.random() * .28 + .05,
  s: Math.random() * .005 + .001,
  p: Math.random() * Math.PI * 2
}));

window._xrCanvas = {
  smoothAmp: 0,
  tick: 0,
  analyser: null,
  dataArr: null,
  listening: false
};

function drawWave(W, H, live, amp, t) {
  const cy = H * .50;
  const N = 380;
  const idle = Math.max(0, 1 - amp * 1.5);
  const LAYERS = [
    { cr: 0, cg: 212, cb: 255, lw: 2.0, glow: 22, al: .95 },
    { cr: 40, cg: 118, cb: 255, lw: 1.5, glow: 15, al: .54 },
    { cr: 150, cg: 48, cb: 255, lw: .95, glow: 9, al: .27 },
  ];
  LAYERS.forEach((L, li) => {
    const phOff = li * 1.2;
    const spd = 1 - li * .08;
    const xs = new Float32Array(N + 1);
    const ys = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const ph = t * .011 * spd + phOff;
      const bA = H * (.088 + li * .003);
      const idY =
        Math.sin(u * Math.PI * 2 * 2.2 + ph) * bA * .62 +
        Math.sin(u * Math.PI * 2 * 1.1 + ph * .70) * bA * .44 +
        Math.sin(u * Math.PI * 2 * .52 + ph * .36) * bA * .20;
      let micY = 0;
      if (live) {
        const idx = Math.floor(u * (live.length - 1));
        const v = (live[idx] / 128) - 1;
        micY = v * H * .38 * amp + Math.sin(u * Math.PI * 2 * 2.2 + ph) * H * .05 * amp;
      }
      const total = idY * idle + (idY * .2 + micY) * amp;
      xs[i] = u * W;
      ys[i] = cy + total * Math.sin(u * Math.PI);
    }
    const path = () => {
      wcx.beginPath();
      wcx.moveTo(xs[0], ys[0]);
      for (let i = 1; i <= N; i++) wcx.lineTo(xs[i], ys[i]);
    };
    const mkG = (a) => {
      const g = wcx.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, `rgba(${L.cr},${L.cg},${L.cb},0)`);
      g.addColorStop(.07, `rgba(${L.cr},${L.cg},${L.cb},${a})`);
      g.addColorStop(.50, `rgba(${L.cr},${L.cg},${L.cb},${Math.min(a * 1.1, 1)})`);
      g.addColorStop(.93, `rgba(${L.cr},${L.cg},${L.cb},${a})`);
      g.addColorStop(1, `rgba(${L.cr},${L.cg},${L.cb},0)`);
      return g;
    };
    wcx.lineJoin = 'round';
    wcx.lineCap = 'round';
    path(); wcx.lineWidth = L.lw * 11; wcx.strokeStyle = mkG(L.al * .09); wcx.shadowBlur = 0; wcx.stroke();
    path(); wcx.lineWidth = L.lw * 3.8; wcx.strokeStyle = mkG(L.al * .43); wcx.shadowColor = `rgba(${L.cr},${L.cg},${L.cb},.88)`; wcx.shadowBlur = L.glow; wcx.stroke();
    path(); wcx.lineWidth = L.lw; wcx.strokeStyle = mkG(L.al); wcx.shadowColor = `rgba(${L.cr},${L.cg},${L.cb},1)`; wcx.shadowBlur = L.glow * .45; wcx.stroke();
  });
  wcx.shadowBlur = 0;
}

function loop(ts) {
  const ctx = window._xrCanvas;

  scx.clearRect(0, 0, SC.width, SC.height);
  STARS.forEach(s => {
    const a = s.a * (0.5 + 0.5 * Math.sin(ts * .001 * s.s * 55 + s.p));
    scx.beginPath();
    scx.arc(s.x * SC.width, s.y * SC.height, s.r, 0, Math.PI * 2);
    scx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    scx.fill();
  });

  const W = WC.width;
  const H = WC.height;
  wcx.clearRect(0, 0, W, H);

  if (W > 10 && H > 10) {
    if (ctx.analyser && ctx.listening && ctx.dataArr) {
      ctx.analyser.getByteTimeDomainData(ctx.dataArr);
      let rms = 0;
      for (let i = 0; i < ctx.dataArr.length; i++) {
        const v = (ctx.dataArr[i] / 128) - 1;
        rms += v * v;
      }
      const tgt = Math.min(Math.sqrt(rms / ctx.dataArr.length) * 7, 1);
      ctx.smoothAmp += (tgt - ctx.smoothAmp) * (tgt > ctx.smoothAmp ? .45 : .07);
    } else {
      ctx.smoothAmp += (0 - ctx.smoothAmp) * .05;
    }
    drawWave(W, H, (ctx.listening && ctx.dataArr) ? ctx.dataArr : null, ctx.smoothAmp, ctx.tick);
    ctx.tick++;
  }
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
