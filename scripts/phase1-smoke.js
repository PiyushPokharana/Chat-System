const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = process.env.PHASE1_SMOKE_PORT || 3101;
const SERVER_URL = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT_MS = 20000;
const TEST_TIMEOUT_MS = 15000;

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
                    req.setTimeout(2000, () => {
                        req.destroy(new Error('Healthcheck timeout'));
                    });
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

        const timeout = setTimeout(() => {
            reject(new Error(`Connection timeout for ${username}`));
        }, 7000);

        socket.on('connect', () => {
            socket.emit('join', { username });
        });

        socket.on('user_joined', (data) => {
            clearTimeout(timeout);
            resolve({ socket, user: data });
        });

        socket.on('connect_error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

async function runSmokeTest() {
    const alice = await connectClient('Alice');
    const bob = await connectClient('Bob');
    const roomId = 'general';

    await Promise.all([
        new Promise((resolve) => {
            alice.socket.once('room_joined', resolve);
            alice.socket.emit('join_room', { roomId });
        }),
        new Promise((resolve) => {
            bob.socket.once('room_joined', resolve);
            bob.socket.emit('join_room', { roomId });
        }),
    ]);

    const messageText = `phase1-smoke-${Date.now()}`;

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Timed out waiting for Bob to receive message'));
        }, TEST_TIMEOUT_MS);

        bob.socket.on('receive_message', (payload) => {
            if (payload.content !== messageText) {
                return;
            }

            if (payload.senderId !== alice.user.userId) {
                clearTimeout(timeout);
                reject(new Error('Sender ID mismatch in received message'));
                return;
            }

            clearTimeout(timeout);
            resolve();
        });

        alice.socket.emit('send_message', { message: messageText, roomId });
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
        await runSmokeTest();

        console.log('PASS: Two users exchanged messages in real time.');
        await cleanup(0);
    } catch (error) {
        console.error(`FAIL: ${error.message}`);
        await cleanup(1);
    }
}

main();
