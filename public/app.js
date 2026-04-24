const state = {
  socket: null,
  currentUser: null,
  currentRoom: null,
  typingTimeout: null,
  members: [],
  typingUsers: [],
  seenMessageIds: new Set(),
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
    state.typingUsers = [];
    renderTypingHint();
  });

  socket.on('error_message', (payload) => {
    toast(payload.error || 'Socket error');
  });

  socket.on('room_joined', ({ roomId }) => {
    state.currentRoom = roomId;
    state.typingUsers = [];
    renderTypingHint();
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
    messages.forEach((msg) => handleIncomingMessage(msg));
    addSystemNote(`Loaded ${messages.length} historical messages`);
  });

  socket.on('pending_messages', (payload, ack) => {
    const pending = payload?.messages || [];
    if (pending.length > 0) {
      addSystemNote(`Recovered ${pending.length} missed messages after reconnect`);
      pending.forEach((msg) => {
        if (!state.currentRoom || msg.roomId === state.currentRoom) {
          handleIncomingMessage(msg);
        } else {
          addSystemNote(`Missed message in #${msg.roomId} from ${msg.senderName}`);
        }
      });
    }

    if (typeof ack === 'function') {
      ack({ ok: true, deliveryId: payload?.deliveryId || null });
    }
  });

  socket.on('receive_message', (message) => {
    handleIncomingMessage(message);
  });

  socket.on('deliver_message', (payload, ack) => {
    if (payload?.message) {
      handleIncomingMessage(payload.message);
    }
    if (typeof ack === 'function') {
      ack({ ok: true, deliveryId: payload?.deliveryId || null });
    }
  });

  socket.on('room_members', ({ roomId, members }) => {
    if (roomId !== state.currentRoom) {
      return;
    }
    state.members = members;
    renderMembers();
  });

  socket.on('typing_status', ({ roomId, users }) => {
    if (roomId !== state.currentRoom) {
      return;
    }
    state.typingUsers = (users || []).filter((u) => u.userId !== state.currentUser?.userId);
    renderTypingHint();
  });

  socket.on('message_delivery_update', ({ messageId, recipientId, status, attempts, error }) => {
    const details = `Delivery: msg=${messageId} recipient=${recipientId} status=${status} attempts=${attempts}`;
    addSystemNote(error ? `${details} error=${error}` : details);
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

  const clientMessageId = generateClientMessageId();
  state.socket.emit('send_message', {
    message: content,
    roomId: state.currentRoom,
    clientMessageId,
  }, (response) => {
    if (!response?.ok) {
      toast(response?.error || 'Message failed');
      return;
    }
    if (response.duplicate) {
      addSystemNote(`Deduped resend for message ${response.messageId}`);
    }
  });

  els.messageInput.value = '';
  state.socket.emit('typing_stop');
  clearTimeout(state.typingTimeout);
}

function onTypingInput() {
  if (!state.socket || !state.currentRoom) {
    return;
  }

  state.socket.emit('typing_start');
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => {
    if (state.socket) {
      state.socket.emit('typing_stop');
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
    state.typingUsers = [];
    renderMembers();
    renderTypingHint();
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

function handleIncomingMessage(message) {
  if (!message || message.roomId !== state.currentRoom) {
    return;
  }
  if (message.messageId && state.seenMessageIds.has(message.messageId)) {
    return;
  }
  if (message.messageId) {
    state.seenMessageIds.add(message.messageId);
  }
  addMessage(message);
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
  state.seenMessageIds = new Set();
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
      `delivery.sent: ${payload.delivery?.sent ?? 0}`,
      `delivery.delivered: ${payload.delivery?.delivered ?? 0}`,
      `delivery.failed: ${payload.delivery?.failed ?? 0}`,
    ].join('\n');
  } catch (error) {
    els.runtimeMeta.textContent = 'Runtime status unavailable';
  }
}

function toast(text) {
  addSystemNote(text);
}

function renderTypingHint() {
  if (!state.typingUsers.length) {
    els.typingHint.textContent = '';
    return;
  }

  const names = state.typingUsers.map((u) => u.username);
  if (names.length === 1) {
    els.typingHint.textContent = `${names[0]} is typing...`;
    return;
  }

  if (names.length === 2) {
    els.typingHint.textContent = `${names[0]} and ${names[1]} are typing...`;
    return;
  }

  els.typingHint.textContent = `${names[0]} and ${names.length - 1} others are typing...`;
}

function generateClientMessageId() {
  return `cm_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}
