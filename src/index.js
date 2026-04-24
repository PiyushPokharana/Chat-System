const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const path = require('path');
const config = require('./config/environment');
const { initializeSocket } = require('./sockets/socketHandler');
const messageService = require('./services/messageService');
const socketSyncService = require('./services/socketSyncService');
const presenceService = require('./services/presenceService');
const deliveryService = require('./services/deliveryService');

const app = express();
const httpServer = http.createServer(app);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const publicDir = path.resolve(__dirname, '..', 'public');
app.use(express.static(publicDir));

const io = initializeSocket(httpServer);
messageService.initializeSchema().catch((err) => {
    console.warn(`[Startup] Message schema initialization skipped: ${err.message}`);
});

const instanceId = process.env.INSTANCE_ID || `instance-${process.pid}`;
socketSyncService.initialize(io, instanceId).catch((err) => {
    console.warn(`[Startup] Socket sync initialization skipped: ${err.message}`);
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        message: 'Chat System Backend is running',
    });
});

app.get('/api/status', (req, res) => {
    res.json({
        server: 'running',
        instanceId,
        socketConnections: io.engine.clientsCount,
        messageStore: messageService.getStatus(),
        socketSync: socketSyncService.getStatus(),
        presence: presenceService.getStatus(),
        delivery: deliveryService.getStatus(),
    });
});

app.get('/api/rooms', async (req, res, next) => {
    try {
        const rooms = await messageService.getRecentRooms(req.query.limit || 20);
        res.json({
            rooms,
            totalRooms: rooms.length,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/rooms/:roomId/messages', async (req, res, next) => {
    try {
        const roomId = String(req.params.roomId || '').trim();
        if (!roomId) {
            res.status(400).json({ error: 'roomId is required' });
            return;
        }

        const history = await messageService.getRoomHistory(roomId, req.query.limit);
        res.json({
            roomId,
            messages: history,
            totalMessages: history.length,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((req, res) => {
    res.status(404).json({
        error: 'Route not found',
        path: req.path,
    });
});

app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: config.nodeEnv === 'development' ? err.message : 'Something went wrong',
    });
});

const PORT = config.port;
httpServer.listen(PORT, () => {
    console.log(`Chat System server running on port ${PORT} (${config.nodeEnv})`);
    console.log(`Frontend: http://localhost:${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`API Status: http://localhost:${PORT}/api/status`);
});

process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');
    Promise.resolve(socketSyncService.shutdown())
        .catch(() => undefined)
        .finally(() => {
            httpServer.close(() => {
                console.log('Server closed');
                process.exit(0);
            });
        });
});

module.exports = { app, httpServer, io };
