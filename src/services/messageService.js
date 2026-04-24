const pool = require('../config/database');

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

class MessageService {
    constructor() {
        this.schemaReady = false;
        this.storageMode = 'postgres';
        this.memoryMessages = [];
    }

    async initializeSchema() {
        if (this.schemaReady) {
            return;
        }

        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    room_id TEXT NOT NULL,
                    sender_id TEXT NOT NULL,
                    sender_name TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_messages_room_timestamp
                ON messages (room_id, timestamp DESC)
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_messages_timestamp
                ON messages (timestamp DESC)
            `);

            this.schemaReady = true;
            this.storageMode = 'postgres';
            console.log('[MessageService] Message schema ready');
        } catch (error) {
            this.storageMode = 'memory';
            this.schemaReady = true;
            console.warn('[MessageService] PostgreSQL unavailable, using in-memory message store');
            console.warn(`[MessageService] Reason: ${error.message}`);
        }
    }

    async saveMessage(message) {
        await this.initializeSchema();

        if (this.storageMode === 'memory') {
            this.memoryMessages.push({ ...message });
            return { ...message };
        }

        const query = `
            INSERT INTO messages (id, room_id, sender_id, sender_name, content, timestamp)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, room_id, sender_id, sender_name, content, timestamp
        `;
        const values = [
            message.messageId,
            message.roomId,
            message.senderId,
            message.senderName,
            message.content,
            message.timestamp,
        ];

        const result = await pool.query(query, values);
        const row = result.rows[0];

        return this.mapRow(row);
    }

    async getRoomHistory(roomId, limit = DEFAULT_HISTORY_LIMIT) {
        await this.initializeSchema();
        const safeLimit = this.normalizeLimit(limit);

        if (this.storageMode === 'memory') {
            return this.memoryMessages
                .filter((m) => m.roomId === roomId)
                .slice(-safeLimit);
        }

        const query = `
            SELECT id, room_id, sender_id, sender_name, content, timestamp
            FROM messages
            WHERE room_id = $1
            ORDER BY timestamp DESC
            LIMIT $2
        `;
        const result = await pool.query(query, [roomId, safeLimit]);

        return result.rows
            .map((row) => this.mapRow(row))
            .reverse();
    }

    async getRecentRooms(limit = 20) {
        await this.initializeSchema();
        const safeLimit = this.normalizeLimit(limit);

        if (this.storageMode === 'memory') {
            const latestByRoom = new Map();
            for (const message of this.memoryMessages) {
                const existing = latestByRoom.get(message.roomId);
                if (!existing || new Date(message.timestamp) > new Date(existing.lastMessageAt)) {
                    latestByRoom.set(message.roomId, {
                        roomId: message.roomId,
                        lastMessageAt: message.timestamp,
                    });
                }
            }

            return Array.from(latestByRoom.values())
                .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt))
                .slice(0, safeLimit);
        }

        const query = `
            SELECT room_id, MAX(timestamp) AS last_message_at
            FROM messages
            GROUP BY room_id
            ORDER BY last_message_at DESC
            LIMIT $1
        `;
        const result = await pool.query(query, [safeLimit]);

        return result.rows.map((row) => ({
            roomId: row.room_id,
            lastMessageAt: new Date(row.last_message_at).toISOString(),
        }));
    }

    getStatus() {
        return {
            storageMode: this.storageMode,
            schemaReady: this.schemaReady,
        };
    }

    normalizeLimit(limit) {
        const parsedLimit = Number(limit);
        if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
            return DEFAULT_HISTORY_LIMIT;
        }

        return Math.min(parsedLimit, MAX_HISTORY_LIMIT);
    }

    mapRow(row) {
        return {
            messageId: row.id,
            roomId: row.room_id,
            senderId: row.sender_id,
            senderName: row.sender_name,
            content: row.content,
            timestamp: new Date(row.timestamp).toISOString(),
        };
    }
}

module.exports = new MessageService();
