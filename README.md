# 🚀 XR Messaging System – Desktop to XR Glasses Communication

This project demonstrates real-time messaging between a desktop Electron app and an XR glasses emulator in the browser using WebSocket, with voice command support to clear messages.

---

## 🧠 Project Overview

- Desktop app sends messages via WebSocket.
- XR glasses emulator displays messages instantly.
- Voice command "clear message" removes messages using Speech Recognition.

---

## ⚙️ Tech Stack

| Component   | Technology          |
|-------------|---------------------|
| Desktop App | Electron, JavaScript|
| XR Emulator | HTML, JS, Web Speech API |
| Server      | Node.js, WebSocket  |

---

## 🏗️ Project Structure

🚀 How to Run the Project
1️⃣ Start the WebSocket Server

bash
Copy code
cd server
npm install
node server.js
Server runs at: ws://localhost:8080

2️⃣ Run the Desktop App

bash
Copy code
cd ../desktop-app
npm install
npm start
A GUI will open to send messages.

3️⃣ Start the XR Glasses Emulator

Option A (Recommended): Serve locally

bash
Copy code
cd ../xr-emulator
npx serve -p 3000
Open http://localhost:3000/display.html in your browser.

Option B: Open xr-emulator/display.html directly in your browser (voice commands may have limited functionality).

🎤 Voice Commands
Say "clear message" in the XR emulator to clear displayed messages instantly.
xr-messaging system status for webrtc