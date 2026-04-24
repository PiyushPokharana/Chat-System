const CLIENT_MESSAGE_TTL_MS = 10 * 60 * 1000;

class DeliveryService {
    constructor() {
        this.deliveries = new Map();
        this.clientMessageMap = new Map();
        this.messageStats = new Map();
    }

    getClientMessage(senderId, clientMessageId) {
        this.pruneClientMessages();
        const key = this.buildClientMessageKey(senderId, clientMessageId);
        if (!key) {
            return null;
        }
        return this.clientMessageMap.get(key)?.message || null;
    }

    rememberClientMessage(senderId, clientMessageId, message) {
        const key = this.buildClientMessageKey(senderId, clientMessageId);
        if (!key) {
            return;
        }
        this.clientMessageMap.set(key, {
            message,
            createdAt: Date.now(),
        });
    }

    createDelivery({ messageId, recipientId, recipientSocketId, senderSocketId }) {
        const deliveryId = `${messageId}:${recipientId}`;
        const delivery = {
            deliveryId,
            messageId,
            recipientId,
            recipientSocketId,
            senderSocketId,
            status: 'sent',
            attempts: 0,
            updatedAt: new Date().toISOString(),
            error: null,
        };

        this.deliveries.set(deliveryId, delivery);
        this.ensureMessageStats(messageId);
        const stats = this.messageStats.get(messageId);
        stats.sent += 1;
        return delivery;
    }

    markAttempt(deliveryId, attemptNumber) {
        const delivery = this.deliveries.get(deliveryId);
        if (!delivery) {
            return null;
        }
        delivery.attempts = attemptNumber;
        delivery.status = 'sent';
        delivery.updatedAt = new Date().toISOString();
        return delivery;
    }

    markDelivered(deliveryId) {
        const delivery = this.deliveries.get(deliveryId);
        if (!delivery || delivery.status === 'delivered') {
            return delivery || null;
        }

        const wasFailed = delivery.status === 'failed';
        delivery.status = 'delivered';
        delivery.error = null;
        delivery.updatedAt = new Date().toISOString();

        const stats = this.ensureMessageStats(delivery.messageId);
        stats.delivered += 1;
        if (wasFailed && stats.failed > 0) {
            stats.failed -= 1;
        }
        return delivery;
    }

    markFailed(deliveryId, error) {
        const delivery = this.deliveries.get(deliveryId);
        if (!delivery || delivery.status === 'failed') {
            return delivery || null;
        }

        const wasDelivered = delivery.status === 'delivered';
        delivery.status = 'failed';
        delivery.error = error || 'delivery_failed';
        delivery.updatedAt = new Date().toISOString();

        const stats = this.ensureMessageStats(delivery.messageId);
        stats.failed += 1;
        if (wasDelivered && stats.delivered > 0) {
            stats.delivered -= 1;
        }
        return delivery;
    }

    getMessageStats(messageId) {
        return this.ensureMessageStats(messageId);
    }

    getStatus() {
        let sent = 0;
        let delivered = 0;
        let failed = 0;

        for (const stats of this.messageStats.values()) {
            sent += stats.sent;
            delivered += stats.delivered;
            failed += stats.failed;
        }

        return {
            trackedMessages: this.messageStats.size,
            trackedDeliveries: this.deliveries.size,
            sent,
            delivered,
            failed,
        };
    }

    ensureMessageStats(messageId) {
        if (!this.messageStats.has(messageId)) {
            this.messageStats.set(messageId, {
                messageId,
                sent: 0,
                delivered: 0,
                failed: 0,
            });
        }
        return this.messageStats.get(messageId);
    }

    buildClientMessageKey(senderId, clientMessageId) {
        if (!senderId || !clientMessageId) {
            return null;
        }
        return `${senderId}:${clientMessageId}`;
    }

    pruneClientMessages() {
        const now = Date.now();
        for (const [key, value] of this.clientMessageMap.entries()) {
            if (now - value.createdAt > CLIENT_MESSAGE_TTL_MS) {
                this.clientMessageMap.delete(key);
            }
        }
    }
}

module.exports = new DeliveryService();
