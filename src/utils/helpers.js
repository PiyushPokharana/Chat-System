const { v4: uuidv4 } = require('uuid');

/**
 * Generate a unique user ID
 */
function generateUserId() {
    return uuidv4();
}

/**
 * Generate a unique message ID
 */
function generateMessageId() {
    return uuidv4();
}

/**
 * Get current timestamp
 */
function getCurrentTimestamp() {
    return new Date().toISOString();
}

/**
 * Format error response
 */
function formatError(message, code = 'ERROR') {
    return {
        code,
        message,
        timestamp: getCurrentTimestamp(),
    };
}

/**
 * Format success response
 */
function formatSuccess(data, message = 'Success') {
    return {
        success: true,
        data,
        message,
        timestamp: getCurrentTimestamp(),
    };
}

module.exports = {
    generateUserId,
    generateMessageId,
    getCurrentTimestamp,
    formatError,
    formatSuccess,
};
