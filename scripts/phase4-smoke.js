const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT_A = process.env.PHASE4_PORT_A || 3201;
const PORT_B = process.env.PHASE4_PORT_B || 3202;
const SERVER_A = `http://localhost:${PORT_A}`;
const SERVER_B = `http://localhost:${PORT_B}`;
const STARTUP_TIMEOUT_MS = 25000;
const TEST_TIMEOUT_MS = 12000;

const serverProcesses = [];
const sockets = [];

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForHealth(url) {
    return new Promise(async (resolve, reject) => {
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;
        while (Date.now() < deadline) {
            try {
                await new Promise((ok, fail) => {
                    const req = http.get(`${url}/health`, (res) => {
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
        reject(new Error(`Server ${url} did not become ready in time`));
    });
}

function startServer(port, instanceId) {
    const child = spawn('node', ['src/index.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PORT: String(port), INSTANCE_ID: instanceId },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    serverProcesses.push(child);
    return child;
}

function connectClient(serverUrl, username) {
    return new Promise((resolve, reject) => {
        const socket = io(serverUrl, {
            transports: ['websocket'],
            reconnection: false,
            timeout: 5000,
        });
        sockets.push(socket);

        const timeout = setTimeout(() => reject(new Error(`Connection timeout for ${username} on ${serverUrl}`)), 7000);

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
        const timeout = setTimeout(() => reject(new Error(`join_room timeout for ${roomId}`)), TEST_TIMEOUT_MS);

        client.socket.once('room_joined', (payload) => {
            if (payload.roomId !== roomId) {
                clearTimeout(timeout);
                reject(new Error(`Expected ${roomId} but joined ${payload.roomId}`));
                return;
            }
        });

        client.socket.once('room_history', (payload) => {
            clearTimeout(timeout);
            if (payload.roomId !== roomId) {
                reject(new Error(`History for wrong room ${payload.roomId}`));
                return;
            }
            resolve();
        });

        client.socket.emit('join_room', { roomId });
    });
}

function waitForReceivedMessage(client, expectedContent, expectedRoomId) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for cross-instance message')), TEST_TIMEOUT_MS);

        client.socket.on('receive_message', function handler(payload) {
            if (payload.content !== expectedContent) {
                return;
            }
            if (payload.roomId !== expectedRoomId) {
                clearTimeout(timeout);
                client.socket.off('receive_message', handler);
                reject(new Error(`Message delivered to wrong room ${payload.roomId}`));
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

    for (const child of serverProcesses) {
        if (child && !child.killed) {
            child.kill('SIGINT');
        }
    }

    await wait(400);
    process.exit(exitCode);
}

async function main() {
    try {
        startServer(PORT_A, 'phase4-a');
        startServer(PORT_B, 'phase4-b');

        await Promise.all([waitForHealth(SERVER_A), waitForHealth(SERVER_B)]);

        const roomId = 'multi-instance-room';
        const alice = await connectClient(SERVER_A, 'Alice-A');
        const bob = await connectClient(SERVER_B, 'Bob-B');

        await joinRoom(alice, roomId);
        await joinRoom(bob, roomId);

        const content = `phase4-cross-instance-${Date.now()}`;
        const receivePromise = waitForReceivedMessage(bob, content, roomId);
        alice.socket.emit('send_message', { message: content, roomId });
        await receivePromise;

        console.log('PASS: Cross-instance delivery works via Redis pub/sub.');
        await cleanup(0);
    } catch (error) {
        console.error(`FAIL: ${error.message}`);
        await cleanup(1);
    }
}

main();
