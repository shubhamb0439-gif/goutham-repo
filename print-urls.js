// print-urls.js
const fs = require('fs');
const os = require('os');

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function printBanner() {
  // NGROK URL
  let ngrokUrl = 'Not available';
  try {
    ngrokUrl = fs.readFileSync('./backend/NGROK_URL.txt', 'utf8');
  } catch {}
  // Frontend URLs
  const frontendPort = 3000;
  const localUrl = `http://localhost:${frontendPort}`;
  const lanUrl = `http://${getLocalIp()}:${frontendPort}`;

  console.log(`
================= XR MESSAGING LINKS =================

Backend (WebSocket Signaling): ${ngrokUrl.trim()}
Frontend (Desktop App):        
   - Local:   ${localUrl}
   - Network: ${lanUrl}

======================================================
  `);
}

// --- PRINT JUST ONCE ---
printBanner();
