// watch-ngrok.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

let lastUrl = null;

async function fetchNgrokUrl() {
  try {
    // ngrok API endpoint for tunnel info (http://127.0.0.1:4040/api/tunnels)
    const res = await axios.get('http://127.0.0.1:4040/api/tunnels');
    const tunnel = res.data.tunnels.find(t => t.proto === 'https');
    if (tunnel) {
      const wsUrl = tunnel.public_url.replace(/^https/, 'wss');
      if (wsUrl !== lastUrl) {
        lastUrl = wsUrl;

        // Save for backend
        fs.writeFileSync(path.join(__dirname, 'backend/NGROK_URL.txt'), wsUrl);

        // Save for frontend (make sure this folder exists!)
        const frontendPath = path.join(__dirname, 'frontend/public/ngrok-url.json');
        fs.writeFileSync(frontendPath, JSON.stringify({ url: wsUrl }, null, 2));

        console.log('Updated NGROK URL:', wsUrl);
      }
    }
  } catch (e) {
    process.stdout.write('.');
    // Optional: log only once every 10 times to avoid spam
  }
}

setInterval(fetchNgrokUrl, 2000);
