const redis = require('redis');
const config = require('./environment');

const client = redis.createClient({
    socket: {
        host: config.redis.host,
        port: config.redis.port,
        reconnectStrategy: () => false,
    },
    password: config.redis.password,
    legacyMode: false,
});

client.on('error', (err) => {
    if (err && err.code === 'ECONNREFUSED') {
        console.warn('Redis not available - running in demo mode');
    } else {
        console.warn('Redis Client Error:', err?.message || 'Unknown error');
    }
});

client.on('connect', () => {
    console.log('Connected to Redis');
});

client.on('ready', () => {
    console.log('Redis client ready');
});

client.connect().catch((err) => {
    console.warn('Could not connect to Redis:', err?.message || 'Connection failed');
});

module.exports = client;
