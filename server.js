const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();

// allow ALL origins for development
// For production on Render, we will set this manually in settings.
const allowedOrigin = '*';

app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SIMPLE HEALTH CHECK ROUTE FOR RENDER
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// CREATE PLAIN HTTP SERVER (Render adds HTTPS automatically)
const httpServer = http.createServer(app);

// SOCKET.IO SETUP
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigin,
    methods: ["GET", "POST"]
  },
  path: "/socket.io",
  transports: ["websocket", "polling"]
});

// In-memory rooms (NO DATABASE)
const rooms = new Map();     // roomId -> Set(socketIds)
const socketRoom = new Map(); // socketId -> roomId

// Serve landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve room page
app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// Create room endpoint
app.post('/create-room', (req, res) => {
  const roomId = crypto.randomBytes(24).toString('base64url'); // unpredictable, URL-safe
  rooms.set(roomId, new Set());
  res.json({ roomId });
});

// ICE servers endpoint
app.get('/ice-servers', (req, res) => {
  res.json({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  });
});

// SOCKET.IO EVENTS
io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId }) => {
    if (!roomId) return;

    if (!rooms.has(roomId)) rooms.set(roomId, new Set());

    const roomSet = rooms.get(roomId);
    roomSet.add(socket.id);
    socketRoom.set(socket.id, roomId);

    socket.join(roomId);

    const existingUsers = [...roomSet].filter(id => id !== socket.id);
    socket.emit("room-users", existingUsers);

    socket.to(roomId).emit("user-joined", socket.id);
  });

  socket.on("offer", ({ target, sdp }) => {
    socket.to(target).emit("offer", { from: socket.id, sdp });
  });

  socket.on("answer", ({ target, sdp }) => {
    socket.to(target).emit("answer", { from: socket.id, sdp });
  });

  socket.on("ice-candidate", ({ target, candidate }) => {
    socket.to(target).emit("ice-candidate", { from: socket.id, candidate });
  });

  socket.on("disconnect", () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;

    const roomSet = rooms.get(roomId);
    roomSet.delete(socket.id);

    socket.to(roomId).emit("user-left", socket.id);

    if (roomSet.size === 0) rooms.delete(roomId);

    socketRoom.delete(socket.id);
  });
});

// RUN SERVER ON RENDER PORT
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
