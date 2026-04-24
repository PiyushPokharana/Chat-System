const state = {
  socket: null,
  currentUser: null,
  currentRoom: null,
  typingTimeout: null,
  members: [],
};

const els = {
  joinForm: document.getElementById('joinForm'),
  usernameInput: document.getElementById('usernameInput'),
  roomInput: document.getElementById('roomInput'),
  serverStatus: document.getElementById('serverStatus'),
  chatPanel: document.getElementById('chatPanel'),
  activeRoomLabel: document.getElementById('activeRoomLabel'),
  activeUserLabel: document.getElementById('activeUserLabel'),
  memberList: document.getElementById('memberList'),
  recentRooms: document.getElementById('recentRooms'),
  runtimeMeta: document.getElementById('runtimeMeta'),
  messageList: document.getElementById('messageList'),
  typingHint: document.getElementById('typingHint'),
  messageForm: document.getElementById('messageForm'),
  messageInput: document.getElementById('messageInput'),
  refreshHistoryBtn: document.getElementById('refreshHistoryBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
};

boot();

async function boot() {
  await refreshServerMeta();
  await refreshRooms();

  els.joinForm.addEventListener('submit', onJoinSubmit);
  els.messageForm.addEventListener('submit', onMessageSubmit);
  els.messageInput.addEventListener('input', onTypingInput);
  els.refreshHistoryBtn.addEventListener('click', requestHistory);
  els.disconnectBtn.addEventListener('click', disconnectSocket);
}

async function onJoinSubmit(event) {
  event.preventDefault();
  const username = els.usernameInput.value.trim();
  const roomId = els.roomInput.value.trim();

  if (!username || !roomId) {
    toast('Please enter both username and room');
    return;
  }

  connectSocket(username, roomId);
}

function connectSocket(username, initialRoom) {
  if (state.socket) {
    state.socket.disconnect();
  }

  const socket = io(window.location.origin, {
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 4000,
  });

  state.socket = socket;
  els.serverStatus.textContent = 'Server: socket connecting...';

  socket.on('connect', () => {
    els.serverStatus.textContent = 'Server: connected';

    socket.emit('join', { username }, (response) => {
      if (!response?.ok) {
        toast(response?.error || 'Join failed');
        return;
      }
      state.currentUser = response.user;
      openChatUI();
      joinRoom(initialRoom);
    });
  });

  socket.on('disconnect', () => {
    els.serverStatus.textContent = 'Server: disconnected';
    els.activeUserLabel.textContent = 'Disconnected';
  });

  socket.on('error_message', (payload) => {
    toast(payload.error || 'Socket error');
  });

  socket.on('room_joined', ({ roomId }) => {
    state.currentRoom = roomId;
    els.activeRoomLabel.textContent = `# ${roomId}`;
    els.activeUserLabel.textContent = `Signed in as ${state.currentUser?.username || 'Unknown'}`;
    clearMessages();
    addSystemNote(`Joined room ${roomId}`);
    refreshRooms();
    requestHistory();
  });

  socket.on('room_history', ({ roomId, messages }) => {
    if (roomId !== state.currentRoom) {
      return;
    }
    clearMessages();
    messages.forEach((msg) => addMessage(msg));
    addSystemNote(`Loaded ${messages.length} historical messages`);
  });

  socket.on('receive_message', (message) => {
    if (message.roomId !== state.currentRoom) {
      return;
    }
    addMessage(message);
  });

  socket.on('room_members', ({ roomId, members }) => {
    if (roomId !== state.currentRoom) {
      return;
    }
    state.members = members;
    renderMembers();
  });

  socket.on('user_typing', ({ roomId, username: typingUser }) => {
    if (roomId === state.currentRoom && typingUser !== state.currentUser?.username) {
      els.typingHint.textContent = `${typingUser} is typing...`;
    }
  });

  socket.on('user_stopped_typing', ({ roomId }) => {
    if (roomId === state.currentRoom) {
      els.typingHint.textContent = '';
    }
  });
}

function openChatUI() {
  els.chatPanel.classList.remove('hidden');
}

function joinRoom(roomId) {
  if (!state.socket) {
    return;
  }

  state.socket.emit('join_room', { roomId }, (response) => {
    if (!response?.ok) {
      toast(response?.error || 'Could not join room');
    }
  });
}

function onMessageSubmit(event) {
  event.preventDefault();
  const content = els.messageInput.value.trim();

  if (!content || !state.socket || !state.currentRoom) {
    return;
  }

  state.socket.emit('send_message', { message: content, roomId: state.currentRoom }, (response) => {
    if (!response?.ok) {
      toast(response?.error || 'Message failed');
    }
  });

  els.messageInput.value = '';
  state.socket.emit('stop_typing');
  clearTimeout(state.typingTimeout);
}

function onTypingInput() {
  if (!state.socket || !state.currentRoom) {
    return;
  }

  state.socket.emit('typing');
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => {
    if (state.socket) {
      state.socket.emit('stop_typing');
    }
  }, 1400);
}

function requestHistory() {
  if (!state.socket || !state.currentRoom) {
    return;
  }

  state.socket.emit('get_room_history', { roomId: state.currentRoom, limit: 80 });
}

function disconnectSocket() {
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
    state.currentRoom = null;
    state.members = [];
    renderMembers();
    addSystemNote('Disconnected from server');
  }
}

function addMessage(message) {
  const mine = message.senderId === state.currentUser?.userId;
  const wrap = document.createElement('article');
  wrap.className = `message ${mine ? 'mine' : ''}`;

  const text = document.createElement('div');
  text.textContent = message.content;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = new Date(message.timestamp).toLocaleTimeString();
  meta.textContent = `${mine ? 'You' : message.senderName} · ${time}`;

  wrap.appendChild(text);
  wrap.appendChild(meta);
  els.messageList.appendChild(wrap);
  els.messageList.scrollTop = els.messageList.scrollHeight;
}

function addSystemNote(text) {
  const note = document.createElement('div');
  note.className = 'system-note';
  note.textContent = text;
  els.messageList.appendChild(note);
  els.messageList.scrollTop = els.messageList.scrollHeight;
}

function clearMessages() {
  els.messageList.innerHTML = '';
}

function renderMembers() {
  els.memberList.innerHTML = '';
  if (!state.members.length) {
    const li = document.createElement('li');
    li.textContent = 'No members yet';
    els.memberList.appendChild(li);
    return;
  }

  state.members.forEach((member) => {
    const li = document.createElement('li');
    li.textContent = member.username;
    els.memberList.appendChild(li);
  });
}

async function refreshRooms() {
  try {
    const response = await fetch('/api/rooms?limit=10');
    const payload = await response.json();

    els.recentRooms.innerHTML = '';
    if (!payload.rooms?.length) {
      const li = document.createElement('li');
      li.textContent = 'No persisted rooms yet';
      els.recentRooms.appendChild(li);
      return;
    }

    payload.rooms.forEach((room) => {
      const li = document.createElement('li');
      li.textContent = `${room.roomId} (${new Date(room.lastMessageAt).toLocaleTimeString()})`;
      li.title = `Join ${room.roomId}`;
      li.addEventListener('click', () => {
        els.roomInput.value = room.roomId;
        if (state.socket) {
          joinRoom(room.roomId);
        }
      });
      els.recentRooms.appendChild(li);
    });
  } catch (error) {
    els.recentRooms.innerHTML = '<li>Unable to load rooms</li>';
  }
}

async function refreshServerMeta() {
  try {
    const response = await fetch('/api/status');
    const payload = await response.json();
    els.runtimeMeta.textContent = [
      `instance: ${payload.instanceId}`,
      `connections: ${payload.socketConnections}`,
      `store: ${payload.messageStore.storageMode}`,
      `sync: ${payload.socketSync.enabled ? 'redis-on' : 'redis-off'}`,
    ].join('\n');
  } catch (error) {
    els.runtimeMeta.textContent = 'Runtime status unavailable';
  }
}

function toast(text) {
  addSystemNote(text);
}
