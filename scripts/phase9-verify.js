const http = require('http');
const { io } = require('socket.io-client');

const args = process.argv.slice(2);

function getArgValue(name) {
    const key = `--${name}`;
    const index = args.indexOf(key);
    if (index === -1) {
        return null;
    }
    return args[index + 1] || null;
}

const baseUrl = getArgValue('baseUrl');
const requireRedisSync = args.includes('--requireRedisSync');

if (!baseUrl) {
    console.error('Usage: npm run phase9:verify -- --baseUrl https://<deployed-url> [--requireRedisSync]');
    process.exit(1);
}

const TEST_TIMEOUT_MS = 25000;
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
        req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
    });
}

function withTimeout(promise, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Timed out: ${label}`)), TEST_TIMEOUT_MS);
        }),
    ]);
}

function connectClient(username) {
    return new Promise((resolve, reject) => {
        const socket = io(baseUrl, {
            transports: ['websocket'],
            reconnection: false,
            timeout: 7000,
        });
        sockets.push(socket);

        socket.on('connect', () => {
            socket.emit('join', { username }, (ack) => {
                if (!ack?.ok) {
                    reject(new Error(`join failed for ${username}`));
                    return;
                }
                resolve({ socket, user: ack.user, username });
            });
        });

        socket.on('connect_error', reject);
    });
}

function joinRoom(client, roomId) {
    return new Promise((resolve, reject) => {
        client.socket.emit('join_room', { roomId }, (ack) => {
            if (!ack?.ok) {
                reject(new Error(`join_room failed for ${client.username}: ${ack?.error || 'unknown error'}`));
                return;
            }
            resolve();
        });
    });
}

function sendMessage(client, roomId, message, clientMessageId) {
    return new Promise((resolve, reject) => {
        client.socket.emit('send_message', { roomId, message, clientMessageId }, (ack) => {
            if (!ack?.ok) {
                reject(new Error(`send_message failed: ${ack?.error || 'unknown error'}`));
                return;
            }
            resolve(ack);
        });
    });
}

async function cleanup() {
    for (const socket of sockets) {
        try {
            socket.disconnect();
        } catch (_) {
            // no-op
        }
    }
}

async function main() {
    const results = [];
    try {
        const health = await withTimeout(httpGetJson(`${baseUrl}/health`), 'health');
        if (health.statusCode !== 200) {
            throw new Error(`Health check failed with status ${health.statusCode}`);
        }
        results.push('Health check passed');

        const status = await withTimeout(httpGetJson(`${baseUrl}/api/status`), 'status');
        if (status.statusCode !== 200) {
            throw new Error(`Status check failed with status ${status.statusCode}`);
        }
        results.push('Status endpoint passed');

        if (requireRedisSync && !status.body?.socketSync?.enabled) {
            throw new Error('Redis sync required but socketSync.enabled=false');
        }
        if (status.body?.socketSync?.enabled) {
            results.push('Multi-instance sync capability detected (socketSync.enabled=true)');
        } else {
            results.push('Multi-instance sync capability not active in this environment (socketSync.enabled=false)');
        }

        const alice = await withTimeout(connectClient('AliceP9'), 'connect alice');
        const bob = await withTimeout(connectClient('BobP9'), 'connect bob');
        const charlie = await withTimeout(connectClient('CharlieP9'), 'connect charlie');

        await joinRoom(alice, 'phase9-room-a');
        await joinRoom(bob, 'phase9-room-a');
        await joinRoom(charlie, 'phase9-room-b');

        // Multi-user real-time chat
        const textRealtime = `phase9-realtime-${Date.now()}`;
        const realtimeReceived = new Promise((resolve, reject) => {
            bob.socket.on('receive_message', function handler(payload) {
                if (payload.content !== textRealtime) {
                    return;
                }
                bob.socket.off('receive_message', handler);
                resolve();
            });
            setTimeout(() => reject(new Error('Realtime message not received by Bob')), 8000);
        });
        await sendMessage(alice, 'phase9-room-a', textRealtime, `p9rt-${Date.now()}-11111111`);
        await realtimeReceived;
        results.push('Multi-user real-time chat test passed');

        // Multi-room isolation
        const textIsolation = `phase9-isolation-${Date.now()}`;
        let leaked = false;
        charlie.socket.on('receive_message', function isolationLeak(payload) {
            if (payload.content === textIsolation) {
                leaked = true;
            }
        });
        await sendMessage(alice, 'phase9-room-a', textIsolation, `p9is-${Date.now()}-22222222`);
        await wait(800);
        if (leaked) {
            throw new Error('Cross-room leakage detected');
        }
        results.push('Multi-room isolation test passed');

        // Persistence/reload
        bob.socket.disconnect();
        await wait(400);
        const bobReloaded = await connectClient('BobP9');
        await joinRoom(bobReloaded, 'phase9-room-a');
        const historyPromise = new Promise((resolve, reject) => {
            bobReloaded.socket.on('room_history', function onHistory(payload) {
                if (payload.roomId !== 'phase9-room-a') {
                    return;
                }
                bobReloaded.socket.off('room_history', onHistory);
                resolve(payload);
            });
            setTimeout(() => reject(new Error('room_history not received on reload')), 8000);
        });
        bobReloaded.socket.emit('get_room_history', { roomId: 'phase9-room-a', limit: 50 });
        const history = await historyPromise;
        if (!history.messages.some((m) => m.content === textRealtime)) {
            throw new Error('Persistence/reload failed: expected message missing from history');
        }
        results.push('Persistence/reload test passed');

        // Offline-to-online delivery
        bobReloaded.socket.disconnect();
        await wait(300);
        const textOffline = `phase9-offline-${Date.now()}`;
        await sendMessage(alice, 'phase9-room-a', textOffline, `p9of-${Date.now()}-33333333`);
        const bobReconnected = await connectClient('BobP9');
        const pendingPromise = new Promise((resolve, reject) => {
            bobReconnected.socket.on('pending_messages', function onPending(payload, ack) {
                const has = (payload.messages || []).some((m) => m.content === textOffline);
                if (!has) {
                    return;
                }
                if (typeof ack === 'function') {
                    ack({ ok: true, deliveryId: payload.deliveryId });
                }
                bobReconnected.socket.off('pending_messages', onPending);
                resolve();
            });
            setTimeout(() => reject(new Error('Offline pending message not delivered on reconnect')), 10000);
        });
        await joinRoom(bobReconnected, 'phase9-room-a');
        await pendingPromise;
        results.push('Offline-to-online delivery test passed');

        // Retry/ack reliability (packet loss simulation)
        await joinRoom(charlie, 'phase9-room-a');
        const retryClientMessageId = `p9re-${Date.now()}-44444444`;
        const attemptsByMessage = new Map();
        bobReconnected.socket.on('deliver_message', (payload, ack) => {
            const messageId = payload?.message?.messageId;
            if (!messageId) {
                return;
            }
            const attempts = (attemptsByMessage.get(messageId) || 0) + 1;
            attemptsByMessage.set(messageId, attempts);
            // Simulate first ack drop
            if (attempts > 1 && typeof ack === 'function') {
                ack({ ok: true, deliveryId: payload.deliveryId });
            }
        });
        charlie.socket.on('deliver_message', () => {
            // no ack to trigger failed state
        });

        const deliveryResult = new Promise((resolve, reject) => {
            let targetMessageId = null;
            alice.socket.on('message_delivery_update', function onUpdate(update) {
                if (!targetMessageId) {
                    return;
                }
                if (update.messageId !== targetMessageId) {
                    return;
                }
                if (update.recipientId === bobReconnected.user.userId && update.status === 'delivered') {
                    resolve({ targetMessageId });
                }
            });
            setTimeout(() => reject(new Error('Retry/ack reliability did not reach delivered state')), 12000);

            sendMessage(alice, 'phase9-room-a', `phase9-retry-${Date.now()}`, retryClientMessageId)
                .then((ack) => {
                    targetMessageId = ack.messageId;
                })
                .catch(reject);
        });

        const { targetMessageId } = await deliveryResult;
        if ((attemptsByMessage.get(targetMessageId) || 0) < 2) {
            throw new Error('At-least-once retry not observed (no second attempt)');
        }

        // Idempotent duplicate retry
        const duplicateAck = await sendMessage(
            alice,
            'phase9-room-a',
            `phase9-retry-duplicate-${Date.now()}`,
            retryClientMessageId
        );
        if (!duplicateAck.duplicate) {
            throw new Error('Idempotent duplicate retry handling failed');
        }
        results.push('Retry/ack reliability test passed');

        console.log('PASS: Phase 9 deployed-environment verification succeeded.');
        for (const result of results) {
            console.log(`- ${result}`);
        }
        await cleanup();
        process.exit(0);
    } catch (error) {
        console.error(`FAIL: ${error.message}`);
        for (const result of results) {
            console.log(`- ${result}`);
        }
        await cleanup();
        process.exit(1);
    }
}

main();
