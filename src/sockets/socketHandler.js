const { Server } = require('socket.io');
const config = require('../config/environment');
const userService = require('../services/userService');
const messageService = require('../services/messageService');
const socketSyncService = require('../services/socketSyncService');
const rateLimiterService = require('../services/rateLimiterService');
const presenceService = require('../services/presenceService');
const deliveryService = require('../services/deliveryService');

let io;
const MAX_USERNAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 2000;
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{2,48}$/;
const TYPING_TIMEOUT_MS = 3000;
const DELIVERY_ACK_TIMEOUT_MS = 1200;
const DELIVERY_BACKOFF_MS = [300, 900, 1800];
const MAX_DELIVERY_ATTEMPTS = DELIVERY_BACKOFF_MS.length + 1;
const typingStateByKey = new Map();
const CLIENT_MESSAGE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

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
            presenceService.markOnline(socket.id, username).catch(() => undefined);

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
            deliverPendingMessages(socket).catch(() => undefined);
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
                stopTypingForUser(user, previousRoomId, 'room_change');
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
            await presenceService.markRoom(socket.id, roomId);

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

            stopTypingForUser(user, roomId, 'left_room');
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
            const clientMessageId = normalizeClientMessageId(data?.clientMessageId);

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

            if (data?.clientMessageId && !clientMessageId) {
                emitError(socket, 'Invalid clientMessageId format', ack);
                return;
            }

            if (clientMessageId) {
                const existingMessage = deliveryService.getClientMessage(user.userId, clientMessageId);
                if (existingMessage) {
                    safeAck(ack, {
                        ok: true,
                        duplicate: true,
                        messageId: existingMessage.messageId,
                        roomId: existingMessage.roomId,
                    });
                    return;
                }
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
            queueForOfflineUsers(roomId, savedMessage, user.username);
            if (clientMessageId) {
                deliveryService.rememberClientMessage(user.userId, clientMessageId, savedMessage);
            }
            initiateGuaranteedDelivery(savedMessage, user, roomId);
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

        socket.on('typing_start', () => handleTypingStart(socket.user));
        socket.on('typing_stop', () => handleTypingStop(socket.user, 'manual_stop'));
        // Backward compatibility with previous event names.
        socket.on('typing', () => handleTypingStart(socket.user));
        socket.on('stop_typing', () => handleTypingStop(socket.user, 'manual_stop'));

        socket.on('disconnect', () => {
            const user = socket.user;
            if (!user) {
                return;
            }

            const previousRoomId = user.currentRoomId;
            stopTypingForUser(user, previousRoomId, 'disconnect');
            userService.removeUser(socket.id);
            presenceService.markOffline(socket.id).catch(() => undefined);

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

function initiateGuaranteedDelivery(message, senderUser, roomId) {
    const recipients = userService
        .getConnectedUsersByRoom(roomId)
        .filter((candidate) => candidate.userId !== senderUser.userId);

    if (recipients.length === 0) {
        emitDeliverySummary(senderUser.socketId, message.messageId);
        return;
    }

    for (const recipient of recipients) {
        const delivery = deliveryService.createDelivery({
            messageId: message.messageId,
            recipientId: recipient.userId,
            recipientSocketId: recipient.socketId,
            senderSocketId: senderUser.socketId,
        });
        attemptDelivery(delivery, message, 1);
    }
}

function attemptDelivery(delivery, message, attemptNumber) {
    const recipient = userService.getUserByUserId(delivery.recipientId);
    if (!recipient || recipient.socketId !== delivery.recipientSocketId) {
        const failed = deliveryService.markFailed(delivery.deliveryId, 'recipient_disconnected');
        emitDeliveryUpdate(failed, 'recipient_disconnected');
        return;
    }

    const sentState = deliveryService.markAttempt(delivery.deliveryId, attemptNumber);
    emitDeliveryUpdate(sentState, null);
    const targetSocket = io.sockets.sockets.get(recipient.socketId);
    if (!targetSocket) {
        const failed = deliveryService.markFailed(delivery.deliveryId, 'socket_not_found');
        emitDeliveryUpdate(failed, 'socket_not_found');
        return;
    }

    let acknowledged = false;
    const timeoutHandle = setTimeout(() => {
        if (acknowledged) {
            return;
        }
        acknowledged = true;
        handleDeliveryMiss(delivery, message, attemptNumber);
    }, DELIVERY_ACK_TIMEOUT_MS);

    targetSocket.emit('deliver_message', {
        deliveryId: delivery.deliveryId,
        attempt: attemptNumber,
        maxAttempts: MAX_DELIVERY_ATTEMPTS,
        message,
    }, (ackPayload) => {
        if (acknowledged) {
            return;
        }
        acknowledged = true;
        clearTimeout(timeoutHandle);

        if (ackPayload?.ok) {
            const delivered = deliveryService.markDelivered(delivery.deliveryId);
            emitDeliveryUpdate(delivered, null);
            return;
        }
        handleDeliveryMiss(delivery, message, attemptNumber);
    });
}

function handleDeliveryMiss(delivery, message, attemptNumber) {
    if (attemptNumber >= MAX_DELIVERY_ATTEMPTS) {
        const failed = deliveryService.markFailed(delivery.deliveryId, 'ack_timeout');
        emitDeliveryUpdate(failed, 'ack_timeout');
        return;
    }

    const backoffDelay = DELIVERY_BACKOFF_MS[attemptNumber - 1] || DELIVERY_BACKOFF_MS[DELIVERY_BACKOFF_MS.length - 1];
    setTimeout(() => {
        attemptDelivery(delivery, message, attemptNumber + 1);
    }, backoffDelay);
}

function emitDeliveryUpdate(delivery, reason) {
    if (!delivery) {
        return;
    }

    io.to(delivery.senderSocketId).emit('message_delivery_update', {
        messageId: delivery.messageId,
        deliveryId: delivery.deliveryId,
        recipientId: delivery.recipientId,
        status: delivery.status,
        attempts: delivery.attempts,
        error: reason || delivery.error || null,
    });
    emitDeliverySummary(delivery.senderSocketId, delivery.messageId);
}

function emitDeliverySummary(senderSocketId, messageId) {
    const summary = deliveryService.getMessageStats(messageId);
    io.to(senderSocketId).emit('message_delivery_summary', summary);
}

function handleTypingStart(user) {
    if (!user || !user.currentRoomId) {
        return;
    }

    const key = getTypingKey(user.userId, user.currentRoomId);
    const existing = typingStateByKey.get(key);
    if (existing?.timeoutHandle) {
        clearTimeout(existing.timeoutHandle);
    }

    const timeoutHandle = setTimeout(() => {
        handleTypingStop(user, 'timeout');
    }, TYPING_TIMEOUT_MS);

    typingStateByKey.set(key, {
        userId: user.userId,
        username: user.username,
        roomId: user.currentRoomId,
        timeoutHandle,
    });

    io.to(user.currentRoomId).emit('typing_start', {
        roomId: user.currentRoomId,
        userId: user.userId,
        username: user.username,
    });
    emitTypingStatus(user.currentRoomId);
}

function handleTypingStop(user, reason = 'manual_stop') {
    if (!user || !user.currentRoomId) {
        return;
    }
    stopTypingForUser(user, user.currentRoomId, reason);
}

function stopTypingForUser(user, roomId, reason = 'manual_stop') {
    if (!user || !roomId) {
        return;
    }

    const key = getTypingKey(user.userId, roomId);
    const existing = typingStateByKey.get(key);
    if (!existing) {
        return;
    }

    if (existing.timeoutHandle) {
        clearTimeout(existing.timeoutHandle);
    }
    typingStateByKey.delete(key);

    io.to(roomId).emit('typing_stop', {
        roomId,
        userId: user.userId,
        username: user.username,
        reason,
    });
    emitTypingStatus(roomId);
}

function emitTypingStatus(roomId) {
    const users = [];
    for (const state of typingStateByKey.values()) {
        if (state.roomId === roomId) {
            users.push({
                userId: state.userId,
                username: state.username,
            });
        }
    }

    io.to(roomId).emit('typing_status', {
        roomId,
        users,
    });
}

function getTypingKey(userId, roomId) {
    return `${userId}::${roomId}`;
}

function normalizeClientMessageId(clientMessageId) {
    if (typeof clientMessageId !== 'string') {
        return null;
    }
    const trimmed = clientMessageId.trim();
    return CLIENT_MESSAGE_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function queueForOfflineUsers(roomId, message, senderUsername) {
    const offlineUsers = presenceService.getOfflineUsersByRoom(roomId);
    for (const offlineUser of offlineUsers) {
        if (offlineUser.username === senderUsername) {
            continue;
        }
        presenceService.enqueuePending(offlineUser.identityKey, message);
    }
}

async function deliverPendingMessages(socket) {
    const username = socket?.user?.username;
    if (!username) {
        return;
    }

    const claimed = presenceService.claimPending(username);
    if (!claimed) {
        return;
    }

    const { deliveryId, messages } = claimed;
    socket.emit('pending_messages', {
        deliveryId,
        totalMessages: messages.length,
        messages,
    }, (ackPayload) => {
        if (ackPayload?.ok) {
            presenceService.confirmDelivery(username, deliveryId);
            return;
        }
        presenceService.restoreDelivery(deliveryId);
    });

    presenceService.scheduleRestoreIfUnacked(deliveryId);
}

module.exports = {
    initializeSocket,
    getIO,
    generateMessageId,
};
