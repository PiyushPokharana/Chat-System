const { Pool } = require('pg');
const config = require('./environment');

const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    password: config.database.password,
});

pool.on('error', (err) => {
    console.warn('⚠ Database connection error:', err.message);
    // Don't exit - allow server to run without database for now
});

pool.on('connect', () => {
    console.log('✓ Connected to PostgreSQL');
});

pool.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
        console.warn('⚠ PostgreSQL not available - running in demo mode');
    }
});

module.exports = pool;
