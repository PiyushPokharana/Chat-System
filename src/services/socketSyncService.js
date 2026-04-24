const redisClient = require('../config/redis');

const MESSAGE_CHANNEL = 'chat:messages';
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

class SocketSyncService {
    constructor() {
        this.io = null;
        this.instanceId = null;
        this.publisher = null;
        this.subscriber = null;
        this.enabled = false;
        this.recentMessageIds = new Map();
    }

    async initialize(io, instanceId) {
        this.io = io;
        this.instanceId = instanceId;
        this.publisher = redisClient;

        try {
            this.subscriber = redisClient.duplicate();
            await this.subscriber.connect();

            await this.subscriber.subscribe(MESSAGE_CHANNEL, (rawPayload) => {
                this.handleIncoming(rawPayload);
            });

            this.enabled = true;
            console.log(`[SocketSync] Redis pub/sub enabled for instance ${instanceId}`);
        } catch (error) {
            this.enabled = false;
            console.warn(`[SocketSync] Redis pub/sub disabled: ${error.message}`);
        }
    }

    async publishMessage(message) {
        if (!this.enabled || !this.publisher) {
            return false;
        }

        const payload = JSON.stringify({
            type: 'message',
            sourceInstanceId: this.instanceId,
            message,
        });

        try {
            await this.publisher.publish(MESSAGE_CHANNEL, payload);
            return true;
        } catch (error) {
            console.warn(`[SocketSync] Failed to publish message ${message.messageId}: ${error.message}`);
            return false;
        }
    }

    handleIncoming(rawPayload) {
        let parsedPayload;
        try {
            parsedPayload = JSON.parse(rawPayload);
        } catch (error) {
            console.warn(`[SocketSync] Ignoring invalid payload: ${error.message}`);
            return;
        }

        if (parsedPayload.type !== 'message' || !parsedPayload.message) {
            return;
        }

        if (parsedPayload.sourceInstanceId === this.instanceId) {
            return;
        }

        const message = parsedPayload.message;
        if (!message.messageId || !message.roomId) {
            return;
        }

        if (this.isDuplicate(message.messageId)) {
            return;
        }

        this.io.to(message.roomId).emit('receive_message', message);
        console.log(`[SocketSync] Re-broadcast message ${message.messageId} to room ${message.roomId}`);
    }

    isDuplicate(messageId) {
        this.pruneRecent();

        if (this.recentMessageIds.has(messageId)) {
            return true;
        }

        this.recentMessageIds.set(messageId, Date.now());
        return false;
    }

    pruneRecent() {
        const now = Date.now();
        for (const [messageId, timestamp] of this.recentMessageIds.entries()) {
            if (now - timestamp > DEDUPE_WINDOW_MS) {
                this.recentMessageIds.delete(messageId);
            }
        }
    }

    async shutdown() {
        if (this.subscriber) {
            try {
                await this.subscriber.unsubscribe(MESSAGE_CHANNEL);
                await this.subscriber.quit();
            } catch (_) {
                // no-op
            }
            this.subscriber = null;
        }
    }

    getStatus() {
        return {
            enabled: this.enabled,
            instanceId: this.instanceId,
            channel: MESSAGE_CHANNEL,
        };
    }
}

module.exports = new SocketSyncService();
