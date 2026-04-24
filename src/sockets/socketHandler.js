const { Server } = require('socket.io');
const config = require('../config/environment');
const userService = require('../services/userService');
const messageService = require('../services/messageService');
const socketSyncService = require('../services/socketSyncService');
const rateLimiterService = require('../services/rateLimiterService');

let io;
const MAX_USERNAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 2000;
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{2,48}$/;

function initializeSocket(httpServer) {
    io = new Server(httpServer, {
        cors: config.socket.cors,
        transports: ['websocket', 'polling'],
    });

    io.on('connection', (socket) => {
        console.log(`User connected: ${socket.id}`);

        socket.on('join', (data, ack) => {
            const username = normalizeUsername(data?.username);
            if (!username) {
                emitError(socket, 'Username is required and must be <= 32 chars', ack);
                return;
            }

            const user = userService.addUser(socket.id, username);
            socket.user = user;

            socket.emit('user_joined', {
                userId: user.userId,
                username: user.username,
                message: `Welcome, ${user.username}!`,
            });

            safeAck(ack, {
                ok: true,
                user: {
                    userId: user.userId,
                    username: user.username,
                },
            });

            broadcastActiveUsers();
            console.log(`[Socket] User ${user.username} joined. Total users: ${userService.getUserCount()}`);
        });

        socket.on('join_room', async (data, ack) => {
            const user = socket.user;
            if (!user) {
                emitError(socket, 'User not authenticated', ack);
                return;
            }

            const roomId = normalizeRoomId(data?.roomId);
            if (!roomId) {
                emitError(socket, 'Valid roomId is required (2-48 chars, alnum/_/-)', ack);
                return;
            }

            if (user.currentRoomId === roomId) {
                socket.emit('room_joined', { roomId, message: `Already in room ${roomId}` });
                safeAck(ack, { ok: true, roomId, alreadyInRoom: true });
                return;
            }

            if (user.currentRoomId) {
                const previousRoomId = user.currentRoomId;
                socket.leave(previousRoomId);
                socket.to(previousRoomId).emit('room_user_left', {
                    roomId: previousRoomId,
                    userId: user.userId,
                    username: user.username,
                });
                emitRoomMembers(previousRoomId);
            }

            socket.join(roomId);
            userService.updateUser(socket.id, { currentRoomId: roomId });
            socket.user.currentRoomId = roomId;

            socket.emit('room_joined', { roomId, message: `Joined room ${roomId}` });
            socket.to(roomId).emit('room_user_joined', {
                roomId,
                userId: user.userId,
                username: user.username,
            });

            await emitRoomHistory(socket, roomId);
            emitRoomMembers(roomId);
            safeAck(ack, { ok: true, roomId });

            console.log(`[Room] ${user.username} joined room ${roomId}`);
        });

        socket.on('leave_room', (data, ack) => {
            const user = socket.user;
            if (!user) {
                emitError(socket, 'User not authenticated', ack);
                return;
            }

            const roomId = normalizeRoomId(data?.roomId || user.currentRoomId);
            if (!roomId || user.currentRoomId !== roomId) {
                emitError(socket, 'User is not in the specified room', ack);
                return;
            }

            socket.leave(roomId);
            userService.updateUser(socket.id, { currentRoomId: null });
            socket.user.currentRoomId = null;

            socket.emit('room_left', { roomId, message: `Left room ${roomId}` });
            socket.to(roomId).emit('room_user_left', {
                roomId,
                userId: user.userId,
                username: user.username,
            });
            emitRoomMembers(roomId);
            safeAck(ack, { ok: true, roomId });

            console.log(`[Room] ${user.username} left room ${roomId}`);
        });

        socket.on('send_message', async (data, ack) => {
            const user = socket.user;
            if (!user) {
                emitError(socket, 'User not authenticated', ack);
                return;
            }

            const rateCheck = rateLimiterService.allow(`message:${socket.id}`);
            if (!rateCheck.allowed) {
                emitError(socket, 'Rate limit exceeded. Please slow down.', ack, {
                    retryAfterMs: rateCheck.retryAfterMs,
                });
                return;
            }

            const roomId = normalizeRoomId(data?.roomId || user.currentRoomId);
            const rawMessage = typeof data?.message === 'string' ? data.message.trim() : '';

            if (!rawMessage) {
                emitError(socket, 'Message cannot be empty', ack);
                return;
            }

            if (rawMessage.length > MAX_MESSAGE_LENGTH) {
                emitError(socket, `Message exceeds ${MAX_MESSAGE_LENGTH} characters`, ack);
                return;
            }

            if (!roomId) {
                emitError(socket, 'Join a room before sending messages', ack);
                return;
            }

            if (user.currentRoomId !== roomId) {
                emitError(socket, 'User is not a member of this room', ack);
                return;
            }

            const messageData = {
                messageId: generateMessageId(),
                senderId: user.userId,
                senderName: user.username,
                content: rawMessage,
                timestamp: new Date().toISOString(),
                roomId,
            };

            let savedMessage;
            try {
                savedMessage = await messageService.saveMessage(messageData);
            } catch (error) {
                console.error('[Message] Failed to persist message:', error.message);
                emitError(socket, 'Failed to save message', ack);
                return;
            }

            io.to(roomId).emit('receive_message', savedMessage);
            await socketSyncService.publishMessage(savedMessage);
            safeAck(ack, { ok: true, messageId: savedMessage.messageId, roomId: savedMessage.roomId });

            console.log(`[Message][${roomId}] ${user.username}: ${rawMessage.substring(0, 50)}`);
        });

        socket.on('get_room_history', async (data, ack) => {
            const user = socket.user;
            if (!user) {
                emitError(socket, 'User not authenticated', ack);
                return;
            }

            const roomId = normalizeRoomId(data?.roomId || user.currentRoomId);
            if (!roomId) {
                emitError(socket, 'Valid roomId is required', ack);
                return;
            }

            if (user.currentRoomId !== roomId) {
                emitError(socket, 'User is not a member of this room', ack);
                return;
            }

            await emitRoomHistory(socket, roomId, data?.limit);
            safeAck(ack, { ok: true, roomId });
        });

        socket.on('typing', () => {
            const user = socket.user;
            if (user && user.currentRoomId) {
                socket.to(user.currentRoomId).emit('user_typing', {
                    userId: user.userId,
                    username: user.username,
                    roomId: user.currentRoomId,
                });
            }
        });

        socket.on('stop_typing', () => {
            const user = socket.user;
            if (user && user.currentRoomId) {
                socket.to(user.currentRoomId).emit('user_stopped_typing', {
                    userId: user.userId,
                    username: user.username,
                    roomId: user.currentRoomId,
                });
            }
        });

        socket.on('disconnect', () => {
            const user = socket.user;
            if (!user) {
                return;
            }

            const previousRoomId = user.currentRoomId;
            userService.removeUser(socket.id);

            io.emit('user_disconnected', {
                userId: user.userId,
                username: user.username,
            });
            broadcastActiveUsers();
            if (previousRoomId) {
                emitRoomMembers(previousRoomId);
            }

            console.log(`[Socket] User ${user.username} disconnected. Total users: ${userService.getUserCount()}`);
        });

        socket.on('error', (error) => {
            console.error(`[Socket Error] ${socket.id}:`, error);
        });
    });

    return io;
}

function getIO() {
    if (!io) {
        throw new Error('Socket.io not initialized');
    }
    return io;
}

function generateMessageId() {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function normalizeRoomId(roomId) {
    if (typeof roomId !== 'string') {
        return null;
    }

    const trimmed = roomId.trim();
    return ROOM_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeUsername(username) {
    if (typeof username !== 'string') {
        return null;
    }

    const trimmed = username.trim();
    if (!trimmed || trimmed.length > MAX_USERNAME_LENGTH) {
        return null;
    }

    return trimmed;
}

async function emitRoomHistory(socket, roomId, limit) {
    try {
        const messages = await messageService.getRoomHistory(roomId, limit);
        socket.emit('room_history', {
            roomId,
            messages,
            totalMessages: messages.length,
        });
    } catch (error) {
        console.error(`[History] Failed to fetch history for room ${roomId}:`, error.message);
        socket.emit('error_message', { error: 'Failed to load room history' });
    }
}

function emitRoomMembers(roomId) {
    io.to(roomId).emit('room_members', {
        roomId,
        members: userService.getUsersByRoom(roomId),
    });
}

function broadcastActiveUsers() {
    io.emit('active_users', {
        users: userService.getActiveUserList(),
        totalUsers: userService.getUserCount(),
    });
}

function safeAck(ack, payload) {
    if (typeof ack === 'function') {
        ack(payload);
    }
}

function emitError(socket, error, ack, extra = {}) {
    socket.emit('error_message', { error, ...extra });
    safeAck(ack, { ok: false, error, ...extra });
}

module.exports = {
    initializeSocket,
    getIO,
    generateMessageId,
};
