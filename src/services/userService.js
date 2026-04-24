/**
 * User Service
 * Manages user connections, tracking, and metadata
 */

const { v4: uuidv4 } = require('uuid');

class UserService {
    constructor() {
        // In-memory store: socketId -> userObject
        this.users = new Map();
    }

    /**
     * Add a connected user
     * @param {string} socketId - Socket connection ID
     * @param {string} username - User's display name (optional, can be generated)
     * @returns {Object} User object with userId, socketId, username, connectedAt
     */
    addUser(socketId, username) {
        const userId = uuidv4();
        const user = {
            userId,
            socketId,
            username: username || `User_${userId.substring(0, 8)}`,
            connectedAt: new Date(),
            currentRoomId: null,
        };

        this.users.set(socketId, user);
        console.log(`[UserService] User added: ${user.username} (${userId})`);
        return user;
    }

    /**
     * Remove a disconnected user
     * @param {string} socketId - Socket connection ID
     * @returns {Object|null} Removed user object or null if not found
     */
    removeUser(socketId) {
        const user = this.users.get(socketId);
        if (user) {
            this.users.delete(socketId);
            console.log(`[UserService] User removed: ${user.username} (${user.userId})`);
            return user;
        }
        return null;
    }

    /**
     * Get user by socket ID
     * @param {string} socketId - Socket connection ID
     * @returns {Object|null} User object or null if not found
     */
    getUserBySocketId(socketId) {
        return this.users.get(socketId) || null;
    }

    /**
     * Get all connected users
     * @returns {Array} Array of user objects
     */
    getAllUsers() {
        return Array.from(this.users.values());
    }

    /**
     * Get number of connected users
     * @returns {number} Count of connected users
     */
    getUserCount() {
        return this.users.size;
    }

    /**
     * Update user metadata (e.g., typing status, room)
     * @param {string} socketId - Socket connection ID
     * @param {Object} updates - Object with fields to update
     * @returns {Object|null} Updated user object or null if not found
     */
    updateUser(socketId, updates) {
        const user = this.users.get(socketId);
        if (user) {
            Object.assign(user, updates);
            return user;
        }
        return null;
    }

    /**
     * Get active user list for broadcasting
     * @returns {Array} Array with user IDs and usernames (for client-side display)
     */
    getActiveUserList() {
        return Array.from(this.users.values()).map(u => ({
            userId: u.userId,
            username: u.username,
            connectedAt: u.connectedAt,
            currentRoomId: u.currentRoomId || null,
        }));
    }

    getUsersByRoom(roomId) {
        return this.getActiveUserList().filter((user) => user.currentRoomId === roomId);
    }

    getConnectedUsersByRoom(roomId) {
        return Array.from(this.users.values()).filter((user) => user.currentRoomId === roomId);
    }

    getUserByUserId(userId) {
        for (const user of this.users.values()) {
            if (user.userId === userId) {
                return user;
            }
        }
        return null;
    }
}

module.exports = new UserService();
