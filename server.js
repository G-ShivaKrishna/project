const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();

// allow ALL origins for development
// For production set ALLOWED_ORIGIN env var to your deployed domain
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.set('trust proxy', true);
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// simple health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// create HTTP server (Render terminates TLS for you)
const httpServer = http.createServer(app);

// socket.io with sensible options behind proxies
const io = new Server(httpServer, {
  cors: { origin: allowedOrigin, methods: ["GET", "POST"] },
  path: "/socket.io",
  transports: ["websocket", "polling"],
  pingInterval: 25000,
  pingTimeout: 60000
});

// in-memory room state
const rooms = new Map();      // roomId -> Set(socketId)
const socketRoom = new Map(); // socketId -> roomId

// routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/room/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));

// create room (32-char url-safe ID)
app.post('/create-room', (req, res) => {
  const roomId = crypto.randomBytes(24).toString('base64url');
  rooms.set(roomId, new Set());
  console.log(`Created room ${roomId}`);
  res.json({ roomId });
});

// ice servers endpoint: always include STUN, optionally include TURN if env vars set
app.get('/ice-servers', (req, res) => {
  const ice = [];
  const turnUrl = process.env.TURN_URL; // format: turn:turn.example.com:3478 or multiple comma-separated
  const turnUser = process.env.TURN_USERNAME;
  const turnPass = process.env.TURN_PASSWORD;

  // Add TURN(s) if provided
  if (turnUrl && turnUser && turnPass) {
    const urls = turnUrl.split(',').map(s => s.trim());
    ice.push({ urls, username: turnUser, credential: turnPass });
    console.log('Providing TURN servers to clients.');
  } else {
    console.log('No TURN configured; clients will use STUN only.');
  }

  // Always include Google STUNs as fallback
  ice.push({ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' });

  res.json({ iceServers: ice });
});

// helper to safely get room set
function getRoomSet(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}

// signaling handlers
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('join-room', ({ roomId }) => {
    if (!roomId || typeof roomId !== 'string') {
      console.warn(`Invalid join attempt by ${socket.id}`);
      return;
    }

    const roomSet = getRoomSet(roomId);
    roomSet.add(socket.id);
    socketRoom.set(socket.id, roomId);
    socket.join(roomId);

    const others = [...roomSet].filter(id => id !== socket.id);
    console.log(`Socket ${socket.id} joined room ${roomId}. Others: ${others.join(',')}`);

    // send the list of existing user ids to the new joiner
    socket.emit('room-users', others);

    // notify existing occupants about the new user
    socket.to(roomId).emit('user-joined', socket.id);
  });

  socket.on('offer', ({ target, sdp }) => {
    if (!target || !sdp) return;
    // safety: ensure both sockets are in a room
    const fromRoom = socketRoom.get(socket.id);
    const toRoom = socketRoom.get(target);
    if (!fromRoom || fromRoom !== toRoom) {
      console.warn(`Offer from ${socket.id} to ${target} rejected: not in same room`);
      return;
    }
    console.log(`Forwarding offer from ${socket.id} -> ${target}`);
    socket.to(target).emit('offer', { from: socket.id, sdp });
  });

  socket.on('answer', ({ target, sdp }) => {
    if (!target || !sdp) return;
    const fromRoom = socketRoom.get(socket.id);
    const toRoom = socketRoom.get(target);
    if (!fromRoom || fromRoom !== toRoom) {
      console.warn(`Answer from ${socket.id} to ${target} rejected: not in same room`);
      return;
    }
    console.log(`Forwarding answer from ${socket.id} -> ${target}`);
    socket.to(target).emit('answer', { from: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    if (!target || !candidate) return;
    const fromRoom = socketRoom.get(socket.id);
    const toRoom = socketRoom.get(target);
    if (!fromRoom || fromRoom !== toRoom) {
      console.warn(`ICE candidate from ${socket.id} to ${target} rejected: not in same room`);
      return;
    }
    // forward candidate
    socket.to(target).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    const rid = socketRoom.get(socket.id);
    if (!rid) {
      console.log(`Socket ${socket.id} disconnected (no room).`);
      return;
    }
    const roomSet = rooms.get(rid);
    if (roomSet) {
      roomSet.delete(socket.id);
      socket.to(rid).emit('user-left', socket.id);
      console.log(`Socket ${socket.id} left room ${rid}. Remaining: ${roomSet.size}`);
      if (roomSet.size === 0) {
        rooms.delete(rid);
        console.log(`Room ${rid} deleted (empty).`);
      }
    }
    socketRoom.delete(socket.id);
  });
});

// Start server (Render provides PORT)
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
