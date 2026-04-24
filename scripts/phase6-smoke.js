const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = process.env.PHASE6_SMOKE_PORT || 3106;
const SERVER_URL = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT_MS = 20000;
const TEST_TIMEOUT_MS = 10000;

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

function waitForTypingStatus(client, matcher, description) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for typing_status (${description})`)), TEST_TIMEOUT_MS);

        client.socket.on('typing_status', function handler(payload) {
            if (!matcher(payload)) {
                return;
            }
            clearTimeout(timeout);
            client.socket.off('typing_status', handler);
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
        serverProcess.stderr.on('data', (chunk) => process.stderr.write(chunk));

        await waitForServerReady();

        const roomId = 'typing-room';
        const alice = await connectClient('Alice');
        const bob = await connectClient('Bob');
        await joinRoom(alice, roomId);
        await joinRoom(bob, roomId);

        const hasAlice = (payload) => payload.roomId === roomId
            && (payload.users || []).some((u) => u.userId === alice.user.userId);
        const noAlice = (payload) => payload.roomId === roomId
            && !(payload.users || []).some((u) => u.userId === alice.user.userId);

        const startPromise = waitForTypingStatus(bob, hasAlice, 'alice start');
        alice.socket.emit('typing_start');
        await startPromise;

        const stopPromise = waitForTypingStatus(bob, noAlice, 'alice manual stop');
        alice.socket.emit('typing_stop');
        await stopPromise;

        const startAgainPromise = waitForTypingStatus(bob, hasAlice, 'alice start again');
        alice.socket.emit('typing_start');
        await startAgainPromise;

        const timeoutStopPromise = waitForTypingStatus(bob, noAlice, 'auto timeout clear');
        await timeoutStopPromise;

        const startForDisconnect = waitForTypingStatus(bob, hasAlice, 'alice start before disconnect');
        alice.socket.emit('typing_start');
        await startForDisconnect;

        const disconnectStopPromise = waitForTypingStatus(bob, noAlice, 'disconnect clear');
        alice.socket.disconnect();
        await disconnectStopPromise;

        console.log('PASS: Typing start/stop, room broadcast, and timeout/disconnect auto-clear all work.');
        await cleanup(0);
    } catch (error) {
        console.error(`FAIL: ${error.message}`);
        await cleanup(1);
    }
}

main();
