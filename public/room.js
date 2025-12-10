const roomId = window.location.pathname.split('/').pop();
const roomDisplay = document.getElementById('roomDisplay');
const videoGrid = document.getElementById('videoGrid');
const localVideo = document.getElementById('localVideo');
const toggleAudioBtn = document.getElementById('toggleAudio');
const toggleVideoBtn = document.getElementById('toggleVideo');
const leaveBtn = document.getElementById('leaveRoom');

roomDisplay.textContent = `Room: ${roomId}`;

// connect socket.io explicitly to the same origin/path and prefer websocket transport
const socket = io(location.origin, { path: '/socket.io', transports: ['websocket'] });

// state
const peers = new Map(); // peerId -> RTCPeerConnection
const remoteVideos = new Map(); // peerId -> video element
const candidateBuffer = new Map(); // peerId -> [candidate]
let localStream = null;
let audioEnabled = true;
let videoEnabled = true;
let rtcConfig = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };

// debug helper
function log(...args) { console.debug('[room]', ...args); }

// fetch ICE servers (TURN if provided by server)
async function fetchIceServers() {
  try {
    const res = await fetch(`${location.origin}/ice-servers`);
    if (!res.ok) throw new Error('Failed to fetch ICE servers');
    const data = await res.json();
    if (data && data.iceServers && data.iceServers.length) {
      log('Received ICE servers from server:', data.iceServers);
      return { iceServers: data.iceServers };
    }
  } catch (err) {
    console.warn('Using fallback STUN only:', err);
  }
  return rtcConfig;
}

// create or return existing pc for peerId
function createPeerConnection(peerId) {
  if (peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection(rtcConfig);
  log('Creating RTCPeerConnection for', peerId);

  // attach local tracks (if available)
  if (localStream) {
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  // ontrack: attach remote streams reliably (streams[] preferred)
  pc.ontrack = (event) => {
    log(`ontrack from ${peerId}`, event);
    let stream = null;
    if (event.streams && event.streams[0]) {
      stream = event.streams[0];
    } else {
      // fallback: build a stream from received tracks
      stream = remoteVideos.has(peerId) && remoteVideos.get(peerId).srcObject ? remoteVideos.get(peerId).srcObject : new MediaStream();
      stream.addTrack(event.track);
    }
    attachRemoteStream(peerId, stream);
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      log('sending ice-candidate to', peerId, ev.candidate);
      socket.emit('ice-candidate', { target: peerId, candidate: ev.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    log(`ICE state for ${peerId}:`, pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      // try cleanup; remote may reconnect with new pc
      removePeer(peerId);
    }
  };

  pc.onconnectionstatechange = () => {
    log(`Connection state for ${peerId}:`, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removePeer(peerId);
    }
  };

  peers.set(peerId, pc);

  // drain any buffered ICE candidates for this peer
  if (candidateBuffer.has(peerId)) {
    const candidates = candidateBuffer.get(peerId);
    for (const c of candidates) {
      pc.addIceCandidate(new RTCIceCandidate(c)).catch(e => console.warn('addIceCandidate error', e));
    }
    candidateBuffer.delete(peerId);
  }

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
    video.controls = false;
    tile.appendChild(video);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = peerId;
    tile.appendChild(label);
    videoGrid.appendChild(tile);
    remoteVideos.set(peerId, video);
  }
  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }
}

function removePeer(peerId) {
  log('removePeer', peerId);
  const pc = peers.get(peerId);
  if (pc) {
    try { pc.close(); } catch (e) { /* ignore */ }
    peers.delete(peerId);
  }
  const video = remoteVideos.get(peerId);
  if (video && video.parentElement) video.parentElement.remove();
  remoteVideos.delete(peerId);
  candidateBuffer.delete(peerId);
}

// create offer to a remote peer (call from new participant to existing users)
async function createOfferTo(peerId) {
  try {
    const pc = createPeerConnection(peerId);
    // ensure local tracks are added before creating offer
    if (localStream) {
      for (const track of localStream.getTracks()) {
        // Avoid duplicating tracks
        const has = pc.getSenders().some(s => s.track === track);
        if (!has) pc.addTrack(track, localStream);
      }
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    log('Sending offer to', peerId);
    socket.emit('offer', { target: peerId, sdp: pc.localDescription });
  } catch (err) {
    console.error('createOfferTo error', err);
  }
}

// when an offer is received: set remote, add tracks, create and send answer
socket.on('offer', async ({ from, sdp }) => {
  log('Received offer from', from);
  try {
    const pc = createPeerConnection(from);

    // ensure local tracks are added before setting remote and creating answer
    if (localStream) {
      for (const track of localStream.getTracks()) {
        const has = pc.getSenders().some(s => s.track === track);
        if (!has) pc.addTrack(track, localStream);
      }
    }

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    log('Sending answer to', from);
    socket.emit('answer', { target: from, sdp: pc.localDescription });
  } catch (err) {
    console.error('Error handling offer', err);
  }
});

// when an answer is received: set remote
socket.on('answer', async ({ from, sdp }) => {
  log('Received answer from', from);
  const pc = peers.get(from);
  if (!pc) {
    console.warn('Answer from unknown peer', from);
    return;
  }
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (err) {
    console.error('Error setting remote description on answer', err);
  }
});

// when ICE candidate received: add or buffer if pc missing
socket.on('ice-candidate', ({ from, candidate }) => {
  const pc = peers.get(from);
  if (pc) {
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.warn('addIceCandidate failed', e));
  } else {
    // buffer it until pc exists
    if (!candidateBuffer.has(from)) candidateBuffer.set(from, []);
    candidateBuffer.get(from).push(candidate);
  }
});

// initial user list: the new participant receives existing users and should create offers to them
socket.on('room-users', (users) => {
  log('room-users:', users);
  // create offers to all existing users
  users.forEach((userId) => {
    createOfferTo(userId);
  });
});

// when some other user joins later: no immediate offer from existing users; the new user will create offers (handled by their room-users event)
socket.on('user-joined', (peerId) => {
  log('user-joined', peerId);
  // we don't create an offer here; the joining participant should create offers to us.
  // but ensure we have a placeholder pc so buffered candidates can be drained if needed
  // createPeerConnection(peerId); // optionally create early
});

// when a user leaves
socket.on('user-left', (peerId) => {
  log('user-left', peerId);
  removePeer(peerId);
});

// connect flow: fetch ICE servers, get media, then join
socket.on('connect', async () => {
  log('socket connected', socket.id);
  try {
    const fetched = await fetchIceServers();
    rtcConfig = fetched || rtcConfig;

    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;

    // emit join after we have media
    socket.emit('join-room', { roomId });
  } catch (err) {
    console.error('Media access error', err);
    alert('Camera and microphone access are required to join this room.');
  }
});

// UI controls
toggleAudioBtn.addEventListener('click', () => {
  if (!localStream) return;
  audioEnabled = !audioEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = audioEnabled);
  toggleAudioBtn.textContent = audioEnabled ? 'Mute' : 'Unmute';
});

toggleVideoBtn.addEventListener('click', () => {
  if (!localStream) return;
  videoEnabled = !videoEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = videoEnabled);
  toggleVideoBtn.textContent = videoEnabled ? 'Stop Video' : 'Start Video';
});

leaveBtn.addEventListener('click', () => {
  // close all peers and disconnect
  for (const pid of Array.from(peers.keys())) removePeer(pid);
  if (socket && socket.connected) socket.disconnect();
  // stop local tracks
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  window.location.href = '/';
});

window.addEventListener('beforeunload', () => {
  try { if (socket && socket.connected) socket.disconnect(); } catch (e) {}
});
