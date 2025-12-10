# Secure Video Rooms

## Prerequisites

- Node.js 18+ recommended
- npm

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. (Optional) For development with auto-restart:
   ```bash
   npm run dev
   ```

## Run locally

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

Then open from your browser (or another device on the same LAN): `http://<your-local-ip>:${PORT:-3000}`  
e.g., `http://192.168.1.2:3000` (use the `inet` value from `ifconfig`/`en0`).

> Note: Browsers allow camera/mic on `localhost` over HTTP, but typically block on plain IP. For IP testing, either use HTTPS (ngrok/mkcert) or enable the Chrome flag `unsafely-treat-insecure-origin-as-secure` for `http://<your-local-ip>:3000` (dev only).

## Environment

- `PORT` (optional): port to listen on. Default 3000.

## Deployment (Render)

1. Create a new Web Service on Render.
2. Set **Build Command**: `npm install`
3. Set **Start Command**: `npm start`
4. Ensure **Environment** is Node, **Region** near you.
5. Render terminates HTTPS; no extra TLS config needed in app.

## Usage

- Landing page: click **Create Room** to generate a secure room and join.
- Or paste a full room link into **Join Room** field and click **Join Room**.
- On room page: allow camera/mic, use Mute/Stop Video/Leave controls.

## Testing on another device (same network)

- Ensure both devices are on the same Wi‑Fi/LAN and the server machine’s firewall allows inbound on the chosen `PORT` (default 3000).
- Start the app: `npm start`.
- Find the host machine’s local IP (e.g., `inet 192.168.1.2` under `en0` from `ifconfig`).
- On the other device, open `http://<host-local-ip>:<PORT>` (e.g., `http://192.168.1.2:3000`), then use Create Room or paste full room links that include that IP.

## Permissions over IP (HTTPS required)

Browsers block camera/mic on plain HTTP when using an IP (only `localhost` is exempt). Use HTTPS for LAN testing:

- Quick tunnel: `ngrok http 3000` (or `lt --port 3000`) and open the HTTPS URL on all devices.
- Local cert: generate with mkcert/openssl, set env vars `SSL_KEY_PATH` and `SSL_CERT_PATH`, then `npm start` and open `https://<your-local-ip>:3000` (trust the cert on your devices).
- Last-resort dev flag: in Chrome, `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://<your-local-ip>:3000`, restart (not for production).

## Notes

- Rooms live only in memory; restarting the server clears them.
- Uses Google STUN servers for ICE.
