const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = process.env.PHASE3_SMOKE_PORT || 3103;
const SERVER_URL = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT_MS = 20000;
const TEST_TIMEOUT_MS = 12000;

let serverProcess;
const sockets = [];

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                try {
                    resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
                } catch (error) {
                    reject(error);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('HTTP request timeout')));
    });
}

function waitForServerReady() {
    return new Promise(async (resolve, reject) => {
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;

        while (Date.now() < deadline) {
            try {
                const response = await httpGetJson(`${SERVER_URL}/health`);
                if (response.statusCode === 200) {
                    resolve();
                    return;
                }
            } catch (_) {
                await wait(400);
            }
        }

        reject(new Error('Server did not become ready in time'));
    });
}

function connectClient(username) {
    return new Promise((resolve, reject) => {
        const socket = io(SERVER_URL, {
            transports: ['websocket'],
            reconnection: false,
            timeout: 5000,
        });

        sockets.push(socket);

        const timeout = setTimeout(() => reject(new Error(`Connection timeout for ${username}`)), 7000);

        socket.on('connect', () => {
            socket.emit('join', { username });
        });

        socket.on('user_joined', (user) => {
            clearTimeout(timeout);
            resolve({ socket, user });
        });

        socket.on('connect_error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

function joinRoom(client, roomId) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`join_room timeout: ${roomId}`)), TEST_TIMEOUT_MS);

        client.socket.once('room_joined', (payload) => {
            if (payload.roomId !== roomId) {
                clearTimeout(timeout);
                reject(new Error(`Expected room ${roomId} but joined ${payload.roomId}`));
                return;
            }
        });

        client.socket.once('room_history', (history) => {
            clearTimeout(timeout);
            if (history.roomId !== roomId) {
                reject(new Error(`History received for wrong room ${history.roomId}`));
                return;
            }
            resolve(history);
        });

        client.socket.emit('join_room', { roomId });
    });
}

function waitForMessage(client, expectedContent) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for receive_message')), TEST_TIMEOUT_MS);
        client.socket.on('receive_message', function handler(payload) {
            if (payload.content !== expectedContent) {
                return;
            }
            clearTimeout(timeout);
            client.socket.off('receive_message', handler);
            resolve(payload);
        });
    });
}

async function cleanup(exitCode = 0) {
    for (const socket of sockets) {
        try {
            socket.disconnect();
        } catch (_) {
            // no-op
        }
    }

    if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGINT');
        await wait(300);
    }

    process.exit(exitCode);
}

async function main() {
    try {
        serverProcess = spawn('node', ['src/index.js'], {
            cwd: path.resolve(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT) },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        serverProcess.stderr.on('data', (chunk) => {
            process.stderr.write(chunk);
        });

        await waitForServerReady();

        const roomId = 'persistence-room';
        const firstUser = await connectClient('Alice');
        await joinRoom(firstUser, roomId);

        const content = `phase3-history-${Date.now()}`;
        const receivePromise = waitForMessage(firstUser, content);
        firstUser.socket.emit('send_message', { message: content, roomId });
        const deliveredMessage = await receivePromise;

        firstUser.socket.disconnect();
        await wait(300);

        const reloadedUser = await connectClient('AliceReloaded');
        const historyPayload = await joinRoom(reloadedUser, roomId);

        const foundInSocketHistory = historyPayload.messages.some((msg) => msg.messageId === deliveredMessage.messageId);
        if (!foundInSocketHistory) {
            throw new Error('Sent message missing from socket room_history payload after reload');
        }

        const apiResponse = await httpGetJson(`${SERVER_URL}/api/rooms/${encodeURIComponent(roomId)}/messages?limit=20`);
        if (apiResponse.statusCode !== 200) {
            throw new Error(`History API returned status ${apiResponse.statusCode}`);
        }

        const foundInApiHistory = apiResponse.body.messages.some((msg) => msg.messageId === deliveredMessage.messageId);
        if (!foundInApiHistory) {
            throw new Error('Sent message missing from API history response');
        }

        console.log('PASS: Message persistence/history flow works (save, fetch, reload-visible).');
        await cleanup(0);
    } catch (error) {
        console.error(`FAIL: ${error.message}`);
        await cleanup(1);
    }
}

main();
