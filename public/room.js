const roomId = window.location.pathname.split('/').pop();
const roomDisplay = document.getElementById('roomDisplay');
const videoGrid = document.getElementById('videoGrid');
const localVideo = document.getElementById('localVideo');
const toggleAudioBtn = document.getElementById('toggleAudio');
const toggleVideoBtn = document.getElementById('toggleVideo');
const leaveBtn = document.getElementById('leaveRoom');

roomDisplay.textContent = `Room: ${roomId}`;

// connect socket.io explicitly and prefer websocket transport
const socket = io(location.origin, { path: '/socket.io', transports: ['websocket'] });

// State
const peers = new Map();            // peerId -> RTCPeerConnection
const remoteVideos = new Map();     // peerId -> <video>
const candidateBuffer = new Map();  // peerId -> [candidate]
let localStream = null;
let audioEnabled = true;
let videoEnabled = true;
let rtcConfig = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };

function log(...args) { console.debug('[room]', ...args); }

// Fetch ICE servers (server may provide TURN)
async function fetchIceServers() {
  try {
    const res = await fetch(`${location.origin}/ice-servers`);
    if (!res.ok) throw new Error('Failed fetching ICE servers');
    const data = await res.json();
    if (data && data.iceServers && data.iceServers.length) {
      log('ICE servers:', data.iceServers);
      return { iceServers: data.iceServers };
    }
  } catch (e) {
    console.warn('Using fallback STUN only', e);
  }
  return rtcConfig;
}

// Acquire media with constraints
async function getNewMedia(constraints = { video: true, audio: true }) {
  return navigator.mediaDevices.getUserMedia(constraints);
}

// Replace sender.track for given kind across all peers; newTrack may be null to stop sending
async function replaceTrackForAllPeers(kind, newTrack) {
  for (const [peerId, pc] of peers.entries()) {
    try {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === kind);
      if (sender && typeof sender.replaceTrack === 'function') {
        await sender.replaceTrack(newTrack);
        log(`replaceTrack ${kind} for ${peerId}`);
      } else if (sender && newTrack === null) {
        // fallback: if replaceTrack not available, stop existing track
        try { if (sender.track) sender.track.stop(); } catch (e) {}
        log(`stopped ${kind} for ${peerId} (fallback)`);
      } else if (newTrack) {
        // fallback: addTrack (may need renegotiation on some browsers)
        pc.addTrack(newTrack, localStream);
        log(`added ${kind} for ${peerId} (fallback addTrack)`);
      }
    } catch (err) {
      console.warn('replaceTrackForAllPeers error', err);
    }
  }
}

// Ensure there is a usable audio track on localStream; reacquire if ended/missing
async function ensureAudioTrack() {
  if (!localStream) return null;
  let audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack || audioTrack.readyState === 'ended') {
    const s = await getNewMedia({ audio: true, video: false });
    const newTrack = s.getAudioTracks()[0];
    // remove old audio tracks
    localStream.getAudioTracks().forEach(t => {
      try { t.stop(); } catch (e) {}
      try { localStream.removeTrack(t); } catch (e) {}
    });
    localStream.addTrack(newTrack);
    await replaceTrackForAllPeers('audio', newTrack);
    return newTrack;
  }
  return audioTrack;
}

// Ensure there is a usable video track on localStream; reacquire if ended/missing
async function ensureVideoTrack() {
  if (!localStream) return null;
  let videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack || videoTrack.readyState === 'ended') {
    const s = await getNewMedia({ video: true, audio: false });
    const newTrack = s.getVideoTracks()[0];
    // remove old video tracks
    localStream.getVideoTracks().forEach(t => {
      try { t.stop(); } catch (e) {}
      try { localStream.removeTrack(t); } catch (e) {}
    });
    localStream.addTrack(newTrack);
    localVideo.srcObject = localStream;
    await replaceTrackForAllPeers('video', newTrack);
    return newTrack;
  }
  return videoTrack;
}

// Create or return an RTCPeerConnection for a given peerId
function createPeerConnection(peerId) {
  if (peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection(rtcConfig);
  log('createPeerConnection', peerId);

  // attach local tracks if present
  if (localStream) {
    for (const track of localStream.getTracks()) {
      const already = pc.getSenders().some(s => s.track === track);
      if (!already) pc.addTrack(track, localStream);
    }
  }

  pc.ontrack = (event) => {
    log('ontrack', peerId, event);
    let stream = null;
    if (event.streams && event.streams[0]) {
      stream = event.streams[0];
    } else {
      stream = new MediaStream();
      if (event.track) stream.addTrack(event.track);
    }
    attachRemoteStream(peerId, stream);
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      log('emit ice-candidate ->', peerId, ev.candidate);
      socket.emit('ice-candidate', { target: peerId, candidate: ev.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    log(`ICE state ${peerId}:`, pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      // try cleanup
      removePeer(peerId);
    }
  };

  pc.onconnectionstatechange = () => {
    log(`connection state ${peerId}:`, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') removePeer(peerId);
  };

  peers.set(peerId, pc);

  // drain any buffered ICE candidates for this peer
  if (candidateBuffer.has(peerId)) {
    const list = candidateBuffer.get(peerId);
    for (const c of list) {
      pc.addIceCandidate(new RTCIceCandidate(c)).catch(e => console.warn('addIceCandidate drain failed', e));
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
  if (video.srcObject !== stream) video.srcObject = stream;
}

function removePeer(peerId) {
  log('removePeer', peerId);
  const pc = peers.get(peerId);
  if (pc) {
    try { pc.close(); } catch (e) {}
    peers.delete(peerId);
  }
  const video = remoteVideos.get(peerId);
  if (video && video.parentElement) video.parentElement.remove();
  remoteVideos.delete(peerId);
  candidateBuffer.delete(peerId);
}

// Create and send offer to a target peer (called by new participant for each existing user)
async function createOfferTo(peerId) {
  try {
    const pc = createPeerConnection(peerId);
    // ensure local tracks present
    if (localStream) {
      for (const t of localStream.getTracks()) {
        if (!pc.getSenders().some(s => s.track === t)) pc.addTrack(t, localStream);
      }
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    log('send offer ->', peerId);
    socket.emit('offer', { target: peerId, sdp: pc.localDescription });
  } catch (err) {
    console.error('createOfferTo error', err);
  }
}

// Signaling handlers
socket.on('offer', async ({ from, sdp }) => {
  log('received offer from', from);
  try {
    const pc = createPeerConnection(from);
    // ensure local tracks present before creating answer
    if (localStream) {
      for (const t of localStream.getTracks()) {
        if (!pc.getSenders().some(s => s.track === t)) pc.addTrack(t, localStream);
      }
    }
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    log('send answer ->', from);
    socket.emit('answer', { target: from, sdp: pc.localDescription });
  } catch (err) {
    console.error('handle offer error', err);
  }
});

socket.on('answer', async ({ from, sdp }) => {
  log('received answer from', from);
  const pc = peers.get(from);
  if (!pc) {
    console.warn('answer from unknown peer', from);
    return;
  }
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (err) {
    console.error('setRemoteDescription(answer) failed', err);
  }
});

socket.on('ice-candidate', ({ from, candidate }) => {
  const pc = peers.get(from);
  if (pc) {
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.warn('addIceCandidate failed', e));
  } else {
    if (!candidateBuffer.has(from)) candidateBuffer.set(from, []);
    candidateBuffer.get(from).push(candidate);
  }
});

// New participant receives list of existing users and should create offers to each
socket.on('room-users', (users) => {
  log('room-users', users);
  users.forEach((peerId) => {
    createOfferTo(peerId);
  });
});

// Existing participants are notified of a join; no immediate offer (joining user will call createOfferTo)
socket.on('user-joined', (peerId) => {
  log('user-joined', peerId);
  // Optionally create placeholder pc to accept future candidates
  createPeerConnection(peerId);
});

socket.on('user-left', (peerId) => {
  log('user-left', peerId);
  removePeer(peerId);
});

// Connect flow: fetch ICE, getLocalMedia, then join room
socket.on('connect', async () => {
  log('socket connected', socket.id);
  try {
    const fetched = await fetchIceServers();
    rtcConfig = fetched || rtcConfig;

    // get media
    localStream = await getNewMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localVideo.muted = true;

    audioEnabled = !!(localStream.getAudioTracks()[0] && localStream.getAudioTracks()[0].enabled);
    videoEnabled = !!(localStream.getVideoTracks()[0] && localStream.getVideoTracks()[0].enabled);
    toggleAudioBtn.textContent = audioEnabled ? 'Mute' : 'Unmute';
    toggleVideoBtn.textContent = videoEnabled ? 'Stop Video' : 'Start Video';

    socket.emit('join-room', { roomId });
  } catch (err) {
    console.error('connect flow error', err);
    alert('Camera and microphone access are required to join the room.');
  }
});

// Mute/unmute handling with re-acquire if needed
toggleAudioBtn.addEventListener('click', async () => {
  try {
    if (!localStream) {
      localStream = await getNewMedia({ audio: true, video: false });
      localVideo.srcObject = localStream;
    }
    let audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) {
      // acquire
      audioTrack = (await getNewMedia({ audio: true, video: false })).getAudioTracks()[0];
      localStream.addTrack(audioTrack);
      await replaceTrackForAllPeers('audio', audioTrack);
    }
    audioEnabled = !audioEnabled;
    audioTrack.enabled = audioEnabled;
    toggleAudioBtn.textContent = audioEnabled ? 'Mute' : 'Unmute';
    log('audio toggled', audioEnabled);

    // If track had ended and user re-enabled, ensure new track is used
    if (audioEnabled && audioTrack.readyState === 'ended') {
      const newTrack = (await getNewMedia({ audio: true, video: false })).getAudioTracks()[0];
      localStream.getAudioTracks().forEach(t => { try { t.stop(); } catch (e) {} localStream.removeTrack(t); });
      localStream.addTrack(newTrack);
      await replaceTrackForAllPeers('audio', newTrack);
    }
  } catch (err) {
    console.error('toggleAudio error', err);
  }
});

// Stop/Start camera behavior: actually stop camera when stopping; reacquire when starting
toggleVideoBtn.addEventListener('click', async () => {
  try {
    if (!localStream) {
      localStream = await getNewMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
    }
    let videoTrack = localStream.getVideoTracks()[0];
    // toggle intent
    videoEnabled = !videoEnabled;
    toggleVideoBtn.textContent = videoEnabled ? 'Stop Video' : 'Start Video';
    log('video toggled', videoEnabled);

    if (videoEnabled) {
      if (videoTrack && videoTrack.readyState !== 'ended') {
        videoTrack.enabled = true;
        await replaceTrackForAllPeers('video', videoTrack);
        localVideo.srcObject = localStream;
      } else {
        // reacquire
        const s = await getNewMedia({ video: true, audio: false });
        const newTrack = s.getVideoTracks()[0];
        // remove old tracks
        localStream.getVideoTracks().forEach(t => { try { t.stop(); } catch (e) {}; try { localStream.removeTrack(t); } catch (e) {} });
        localStream.addTrack(newTrack);
        localVideo.srcObject = localStream;
        await replaceTrackForAllPeers('video', newTrack);
      }
    } else {
      // stop camera: stop track, remove from localStream, and tell peers to stop (replace with null)
      localStream.getVideoTracks().forEach(t => { try { t.stop(); } catch (e) {}; try { localStream.removeTrack(t); } catch (e) {} });
      await replaceTrackForAllPeers('video', null);
      localVideo.srcObject = null;
    }
  } catch (err) {
    console.error('toggleVideo error', err);
  }
});

// Leave room
leaveBtn.addEventListener('click', () => {
  for (const pid of Array.from(peers.keys())) removePeer(pid);
  if (socket && socket.connected) socket.disconnect();
  if (localStream) localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
  window.location.href = '/';
});

// Clean disconnect on unload
window.addEventListener('beforeunload', () => {
  try { if (socket && socket.connected) socket.disconnect(); } catch (e) {}
});
