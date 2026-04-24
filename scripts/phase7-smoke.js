const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = process.env.PHASE7_SMOKE_PORT || 3107;
const SERVER_URL = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT_MS = 20000;
const TEST_TIMEOUT_MS = 25000;

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
                        fail(new Error(`Health status ${res.statusCode}`));
                    });
                    req.on('error', fail);
                    req.setTimeout(2000, () => req.destroy(new Error('health timeout')));
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
                    reject(new Error(`Join failed for ${username}`));
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
        const timeout = setTimeout(() => reject(new Error(`join_room timeout: ${roomId}`)), 10000);
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

        const roomId = 'delivery-room';
        const alice = await connectClient('Alice');
        const bob = await connectClient('Bob');
        const charlie = await connectClient('Charlie');

        await joinRoom(alice, roomId);
        await joinRoom(bob, roomId);
        await joinRoom(charlie, roomId);

        const deliveredStatuses = new Map();
        let sentMessageId = null;
        const bobAttemptsByMessage = new Map();

        bob.socket.on('deliver_message', (payload, ack) => {
            const messageId = payload?.message?.messageId;
            if (!messageId) {
                return;
            }
            const attempts = (bobAttemptsByMessage.get(messageId) || 0) + 1;
            bobAttemptsByMessage.set(messageId, attempts);

            // Simulate first acknowledgement being lost.
            if (attempts === 1) {
                return;
            }

            if (typeof ack === 'function') {
                ack({ ok: true, messageId, deliveryId: payload.deliveryId });
            }
        });

        // Charlie never acknowledges => should become failed after retries.
        charlie.socket.on('deliver_message', () => {
            // intentionally no ack
        });

        const updatePromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out waiting for delivery outcomes')), TEST_TIMEOUT_MS);
            alice.socket.on('message_delivery_update', (update) => {
                if (!sentMessageId || update.messageId !== sentMessageId) {
                    return;
                }
                deliveredStatuses.set(update.recipientId, update.status);
                if (deliveredStatuses.get(bob.user.userId) === 'delivered'
                    && deliveredStatuses.get(charlie.user.userId) === 'failed') {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });

        const clientMessageId = `phase7-${Date.now()}-abc12345`;
        const sendAck = await new Promise((resolve, reject) => {
            alice.socket.emit('send_message', {
                roomId,
                message: `phase7 reliability ${Date.now()}`,
                clientMessageId,
            }, (ack) => {
                if (!ack?.ok) {
                    reject(new Error(`send_message failed: ${ack?.error || 'unknown error'}`));
                    return;
                }
                resolve(ack);
            });
        });
        sentMessageId = sendAck.messageId;

        await updatePromise;

        const bobAttempts = bobAttemptsByMessage.get(sentMessageId) || 0;
        if (bobAttempts < 2) {
            throw new Error('At-least-once behavior not observed (Bob did not receive retry)');
        }

        const duplicateAck = await new Promise((resolve, reject) => {
            alice.socket.emit('send_message', {
                roomId,
                message: `phase7 reliability duplicate ${Date.now()}`,
                clientMessageId,
            }, (ack) => {
                if (!ack?.ok) {
                    reject(new Error(`duplicate send failed: ${ack?.error || 'unknown error'}`));
                    return;
                }
                resolve(ack);
            });
        });

        if (!duplicateAck.duplicate || duplicateAck.messageId !== sentMessageId) {
            throw new Error('Idempotent duplicate handling failed for retried clientMessageId');
        }

        console.log('PASS: Delivery ack states, retries/backoff, and idempotent retry handling work (at-least-once demonstrated).');
        await cleanup(0);
    } catch (error) {
        console.error(`FAIL: ${error.message}`);
        await cleanup(1);
    }
}

main();
