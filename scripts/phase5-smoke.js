const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = process.env.PHASE5_SMOKE_PORT || 3105;
const SERVER_URL = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT_MS = 20000;
const TEST_TIMEOUT_MS = 12000;

let serverProcess;
const sockets = [];

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForServerReady() {
    return new Promise(async (resolve, reject) => {
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;

        while (Date.now() < deadline) {
            try {
                await new Promise((ok, fail) => {
                    const req = http.get(`${SERVER_URL}/health`, (res) => {
                        if (res.statusCode === 200) {
                            ok();
                            return;
                        }
                        fail(new Error(`Healthcheck status: ${res.statusCode}`));
                    });
                    req.on('error', fail);
                    req.setTimeout(2000, () => req.destroy(new Error('Healthcheck timeout')));
                });
                resolve();
                return;
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
            socket.emit('join', { username }, (ack) => {
                if (!ack?.ok) {
                    clearTimeout(timeout);
                    reject(new Error(`Join rejected for ${username}`));
                    return;
                }
                clearTimeout(timeout);
                resolve({ socket, user: ack.user });
            });
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
        client.socket.emit('join_room', { roomId }, (ack) => {
            clearTimeout(timeout);
            if (!ack?.ok) {
                reject(new Error(`join_room failed: ${ack?.error || 'unknown error'}`));
                return;
            }
            resolve();
        });
    });
}

function waitForPendingMessages(client, expectedContent) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for pending_messages')), TEST_TIMEOUT_MS);

        client.socket.on('pending_messages', function handler(payload, ack) {
            const matched = (payload?.messages || []).some((m) => m.content === expectedContent);
            if (!matched) {
                return;
            }

            if (typeof ack === 'function') {
                ack({ ok: true, deliveryId: payload.deliveryId });
            }

            clearTimeout(timeout);
            client.socket.off('pending_messages', handler);
            resolve(payload);
        });
    });
}

function ensureNoPendingReplay(client, durationMs = 2500) {
    return new Promise((resolve, reject) => {
        let sawReplay = false;

        const handler = (payload) => {
            if ((payload?.messages || []).length > 0) {
                sawReplay = true;
            }
        };

        client.socket.on('pending_messages', handler);
        setTimeout(() => {
            client.socket.off('pending_messages', handler);
            if (sawReplay) {
                reject(new Error('Pending queue replayed after acknowledgement'));
                return;
            }
            resolve();
        }, durationMs);
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

        serverProcess.stderr.on('data', (chunk) => process.stderr.write(chunk));
        await waitForServerReady();

        const roomId = 'offline-room';
        const alice = await connectClient('Alice');
        const bob = await connectClient('Bob');

        await joinRoom(alice, roomId);
        await joinRoom(bob, roomId);

        bob.socket.disconnect();
        await wait(300);

        const content = `phase5-offline-${Date.now()}`;
        await new Promise((resolve, reject) => {
            alice.socket.emit('send_message', { roomId, message: content }, (ack) => {
                if (!ack?.ok) {
                    reject(new Error(`send_message failed: ${ack?.error || 'unknown error'}`));
                    return;
                }
                resolve();
            });
        });

        const bobReconnect = await connectClient('Bob');
        const pendingPromise = waitForPendingMessages(bobReconnect, content);
        await joinRoom(bobReconnect, roomId);
        const pendingPayload = await pendingPromise;

        if ((pendingPayload.messages || []).length < 1) {
            throw new Error('No pending messages delivered after reconnect');
        }

        bobReconnect.socket.disconnect();
        await wait(300);

        const bobReconnectAgain = await connectClient('Bob');
        await joinRoom(bobReconnectAgain, roomId);
        await ensureNoPendingReplay(bobReconnectAgain);

        console.log('PASS: Offline queue stores missed messages, delivers on reconnect, and clears after ack.');
        await cleanup(0);
    } catch (error) {
        console.error(`FAIL: ${error.message}`);
        await cleanup(1);
    }
}

main();
