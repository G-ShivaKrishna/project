const roomId = window.location.pathname.split('/').pop();
const roomDisplay = document.getElementById('roomDisplay');
const videoGrid = document.getElementById('videoGrid');
const localVideo = document.getElementById('localVideo');
const toggleAudioBtn = document.getElementById('toggleAudio');
const toggleVideoBtn = document.getElementById('toggleVideo');
const leaveBtn = document.getElementById('leaveRoom');

roomDisplay.textContent = `Room: ${roomId}`;

const socket = io();

// store peers/streams
const peers = new Map();
const remoteVideos = new Map();
let localStream;
let audioEnabled = true;
let videoEnabled = true;

// rtcConfig will be populated from server /ice-servers
let rtcConfig = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };

// fetch ICE servers from server (returns TURN if configured + STUN fallback)
async function fetchIceServers() {
  try {
    const res = await fetch(`${location.origin}/ice-servers`);
    if (!res.ok) throw new Error('Failed to fetch ICE servers');
    const data = await res.json();
    if (data && data.iceServers && data.iceServers.length) return { iceServers: data.iceServers };
  } catch (err) {
    console.warn('Could not fetch ICE servers, using fallback STUNs', err);
  }
  return rtcConfig;
}

async function initMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localVideo.srcObject = localStream;
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(rtcConfig);
  if (localStream) localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    attachRemoteStream(peerId, stream);
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { target: peerId, candidate });
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      removePeer(peerId);
    }
  };

  peers.set(peerId, pc);
  return pc;
}

function attachRemoteStream(peerId, stream) {
  let video = remoteVideos.get(peerId);
  if (!video) {
    const tile = document.createElement('div');
    tile.className = 'video-tile';
    video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    tile.appendChild(video);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Guest';
    tile.appendChild(label);
    videoGrid.appendChild(tile);
    remoteVideos.set(peerId, video);
  }
  remoteVideos.get(peerId).srcObject = stream;
}

function removePeer(peerId) {
  const pc = peers.get(peerId);
  if (pc) pc.close();
  peers.delete(peerId);
  const video = remoteVideos.get(peerId);
  if (video && video.parentElement) video.parentElement.remove();
  remoteVideos.delete(peerId);
}

async function handleRoomUsers(users) {
  for (const userId of users) {
    const pc = createPeerConnection(userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { target: userId, sdp: offer });
  }
}

socket.on('connect', async () => {
  try {
    // fetch ice config before starting/creating peer connections
    const fetched = await fetchIceServers();
    rtcConfig = fetched || rtcConfig;

    await initMedia();
    socket.emit('join-room', { roomId });
  } catch (err) {
    alert('Camera/Mic are required to join the room. Please enable and reload.');
    console.error(err);
  }
});

socket.on('room-users', (users) => handleRoomUsers(users));

socket.on('user-joined', (peerId) => {
  if (peers.has(peerId)) return;
  createPeerConnection(peerId);
});

socket.on('offer', async ({ from, sdp }) => {
  let pc = peers.get(from);
  if (!pc) pc = createPeerConnection(from);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { target: from, sdp: answer });
});

socket.on('answer', async ({ from, sdp }) => {
  const pc = peers.get(from);
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const pc = peers.get(from);
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Error adding ICE candidate', err);
  }
});

socket.on('user-left', (peerId) => removePeer(peerId));

toggleAudioBtn.addEventListener('click', () => {
  audioEnabled = !audioEnabled;
  localStream.getAudioTracks().forEach((t) => (t.enabled = audioEnabled));
  toggleAudioBtn.textContent = audioEnabled ? 'Mute' : 'Unmute';
});

toggleVideoBtn.addEventListener('click', () => {
  videoEnabled = !videoEnabled;
  localStream.getVideoTracks().forEach((t) => (t.enabled = videoEnabled));
  toggleVideoBtn.textContent = videoEnabled ? 'Stop Video' : 'Start Video';
});

leaveBtn.addEventListener('click', () => {
  peers.forEach((_pc, id) => removePeer(id));
  if (socket.connected) socket.disconnect();
  window.location.href = '/';
});

window.addEventListener('beforeunload', () => socket.disconnect());
