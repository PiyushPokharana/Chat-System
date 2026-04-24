const redisClient = require('../config/redis');

const ONLINE_USERS_SET_KEY = 'chat:presence:online';
const USER_STATUS_KEY_PREFIX = 'chat:presence:user:';
const DELIVERY_ACK_TIMEOUT_MS = 8000;

class PresenceService {
    constructor() {
        this.userBySocketId = new Map();
        this.presenceByIdentity = new Map();
        this.pendingByIdentity = new Map();
        this.inFlightByDeliveryId = new Map();
    }

    normalizeIdentity(username) {
        return String(username || '').trim().toLowerCase();
    }

    async markOnline(socketId, username) {
        const identityKey = this.normalizeIdentity(username);
        if (!identityKey) {
            return null;
        }

        const now = new Date().toISOString();
        const existing = this.presenceByIdentity.get(identityKey) || {};
        const presence = {
            identityKey,
            username: username || existing.username || identityKey,
            status: 'online',
            socketId,
            currentRoomId: existing.currentRoomId || null,
            connectedAt: existing.connectedAt || now,
            lastSeenAt: now,
        };

        this.presenceByIdentity.set(identityKey, presence);
        this.userBySocketId.set(socketId, identityKey);
        await this.syncPresenceToRedis(presence);
        return presence;
    }

    async markRoom(socketId, roomId) {
        const identityKey = this.userBySocketId.get(socketId);
        if (!identityKey) {
            return null;
        }

        const presence = this.presenceByIdentity.get(identityKey);
        if (!presence) {
            return null;
        }

        presence.currentRoomId = roomId || null;
        presence.lastSeenAt = new Date().toISOString();
        await this.syncPresenceToRedis(presence);
        return presence;
    }

    async markOffline(socketId) {
        const identityKey = this.userBySocketId.get(socketId);
        this.userBySocketId.delete(socketId);
        if (!identityKey) {
            return null;
        }

        const presence = this.presenceByIdentity.get(identityKey);
        if (!presence) {
            return null;
        }

        presence.status = 'offline';
        presence.socketId = null;
        presence.lastSeenAt = new Date().toISOString();
        await this.syncPresenceToRedis(presence);
        return presence;
    }

    getOfflineUsersByRoom(roomId) {
        const results = [];
        for (const presence of this.presenceByIdentity.values()) {
            if (presence.status === 'offline' && presence.currentRoomId === roomId) {
                results.push(presence);
            }
        }
        return results;
    }

    enqueuePending(identityKey, message) {
        const key = this.normalizeIdentity(identityKey);
        if (!key) {
            return 0;
        }

        const queue = this.pendingByIdentity.get(key) || [];
        queue.push({
            ...message,
            enqueuedAt: new Date().toISOString(),
        });
        this.pendingByIdentity.set(key, queue);
        return queue.length;
    }

    claimPending(identityKey) {
        const key = this.normalizeIdentity(identityKey);
        const queue = this.pendingByIdentity.get(key) || [];
        if (queue.length === 0) {
            return null;
        }

        const deliveryId = `delivery_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const payload = queue.slice();
        this.pendingByIdentity.set(key, []);
        this.inFlightByDeliveryId.set(deliveryId, {
            identityKey: key,
            messages: payload,
            claimedAt: Date.now(),
        });

        return { deliveryId, messages: payload };
    }

    confirmDelivery(identityKey, deliveryId) {
        const record = this.inFlightByDeliveryId.get(deliveryId);
        if (!record) {
            return false;
        }
        if (record.identityKey !== this.normalizeIdentity(identityKey)) {
            return false;
        }
        this.inFlightByDeliveryId.delete(deliveryId);
        return true;
    }

    restoreDelivery(deliveryId) {
        const record = this.inFlightByDeliveryId.get(deliveryId);
        if (!record) {
            return false;
        }

        const existingQueue = this.pendingByIdentity.get(record.identityKey) || [];
        this.pendingByIdentity.set(record.identityKey, [...record.messages, ...existingQueue]);
        this.inFlightByDeliveryId.delete(deliveryId);
        return true;
    }

    scheduleRestoreIfUnacked(deliveryId) {
        setTimeout(() => {
            this.restoreDelivery(deliveryId);
        }, DELIVERY_ACK_TIMEOUT_MS);
    }

    getPendingCount(identityKey) {
        return (this.pendingByIdentity.get(this.normalizeIdentity(identityKey)) || []).length;
    }

    getStatus() {
        let onlineUsers = 0;
        let offlineUsers = 0;

        for (const presence of this.presenceByIdentity.values()) {
            if (presence.status === 'online') {
                onlineUsers += 1;
            } else {
                offlineUsers += 1;
            }
        }

        return {
            onlineUsers,
            offlineUsers,
            trackedUsers: this.presenceByIdentity.size,
            inFlightDeliveries: this.inFlightByDeliveryId.size,
        };
    }

    async syncPresenceToRedis(presence) {
        if (!redisClient.isReady) {
            return;
        }

        const identityKey = presence.identityKey;
        const redisUserKey = `${USER_STATUS_KEY_PREFIX}${identityKey}`;

        try {
            if (presence.status === 'online') {
                await redisClient.sAdd(ONLINE_USERS_SET_KEY, identityKey);
            } else {
                await redisClient.sRem(ONLINE_USERS_SET_KEY, identityKey);
            }

            await redisClient.hSet(redisUserKey, {
                username: presence.username,
                status: presence.status,
                currentRoomId: presence.currentRoomId || '',
                lastSeenAt: presence.lastSeenAt,
            });
        } catch (error) {
            console.warn(`[PresenceService] Redis presence sync failed: ${error.message}`);
        }
    }
}

module.exports = new PresenceService();
