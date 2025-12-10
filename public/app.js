const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const roomLinkInput = document.getElementById('roomLink');
const joinError = document.getElementById('joinError');

const roomUrlPattern = /\/room\/([A-Za-z0-9_-]{32})(?:\/|$)/;

createRoomBtn.addEventListener('click', async () => {
  try {
    const res = await fetch(`${location.origin}/create-room`, { method: 'POST' });
    const { roomId } = await res.json();
    if (roomId) window.location.href = `${location.origin}/room/${roomId}`;
  } catch (err) {
    joinError.textContent = 'Unable to create room. Please try again.';
  }
});

joinRoomBtn.addEventListener('click', () => {
  joinError.textContent = '';
  const link = roomLinkInput.value.trim();
  // accept either just the id or a full URL containing /room/:id
  const idOnly = /^[A-Za-z0-9_-]{32}$/.test(link) ? link : null;
  const match = idOnly ? [null, idOnly] : link.match(roomUrlPattern);
  if (!match) {
    joinError.textContent = 'Please paste a valid room link or room id.';
    return;
  }
  const roomId = match[1];
  window.location.href = `${location.origin}/room/${roomId}`;
});
