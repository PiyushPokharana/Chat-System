const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = process.env.PHASE2_SMOKE_PORT || 3102;
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

        const timeout = setTimeout(() => {
            reject(new Error(`Connection timeout for ${username}`));
        }, 7000);

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
            clearTimeout(timeout);
            if (payload.roomId !== roomId) {
                reject(new Error(`Expected room ${roomId} but joined ${payload.roomId}`));
                return;
            }
            resolve();
        });

        client.socket.emit('join_room', { roomId });
    });
}

async function verifyIsolation(sender, receiverInSameRoom, receiverOtherRoom, roomId, text) {
    await new Promise((resolve, reject) => {
        let sameRoomReceived = false;
        let otherRoomReceived = false;

        const cleanup = () => {
            receiverInSameRoom.socket.off('receive_message', onSameRoom);
            receiverOtherRoom.socket.off('receive_message', onOtherRoom);
        };

        const onSameRoom = (payload) => {
            if (payload.content !== text) {
                return;
            }
            if (payload.roomId !== roomId) {
                cleanup();
                reject(new Error(`Message arrived with wrong roomId ${payload.roomId}`));
                return;
            }
            sameRoomReceived = true;
            maybeDone();
        };

        const onOtherRoom = (payload) => {
            if (payload.content !== text) {
                return;
            }
            otherRoomReceived = true;
        };

        const maybeDone = () => {
            setTimeout(() => {
                cleanup();
                if (!sameRoomReceived) {
                    reject(new Error('Expected same-room receiver did not receive message'));
                    return;
                }
                if (otherRoomReceived) {
                    reject(new Error('Cross-room leakage detected'));
                    return;
                }
                resolve();
            }, 600);
        };

        receiverInSameRoom.socket.on('receive_message', onSameRoom);
        receiverOtherRoom.socket.on('receive_message', onOtherRoom);
        sender.socket.emit('send_message', { message: text, roomId });
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

        const alice = await connectClient('Alice');
        const bob = await connectClient('Bob');
        const charlie = await connectClient('Charlie');

        await joinRoom(alice, 'room-a');
        await joinRoom(bob, 'room-a');
        await joinRoom(charlie, 'room-b');

        await verifyIsolation(alice, bob, charlie, 'room-a', `phase2-a-${Date.now()}`);
        await verifyIsolation(charlie, charlie, alice, 'room-b', `phase2-b-${Date.now()}`);

        console.log('PASS: Room isolation works. No cross-room leakage detected.');
        await cleanup(0);
    } catch (error) {
        console.error(`FAIL: ${error.message}`);
        await cleanup(1);
    }
}

main();
