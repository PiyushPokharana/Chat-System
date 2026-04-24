# PulseChat: Distributed Real-Time Chat

PulseChat is a full-stack, interview-ready chat system that demonstrates:
- Real-time messaging with Socket.io
- Room isolation and presence tracking
- Message persistence + room history loading
- Online/offline presence with pending message delivery
- Typing indicators with auto-timeout
- At-least-once delivery guarantees with retry and idempotency
- Multi-instance sync design with Redis Pub/Sub
- A polished web frontend served from the same Node backend

## Why This Stands Out

This project is intentionally built to show both product execution and systems thinking:
- A usable UI, not just raw socket logs
- Robust socket contracts (validation, acknowledgements, error paths)
- Message durability and replay semantics (history on room join/reload)
- Presence tracking with offline message queueing and delivery-on-reconnect
- At-least-once delivery with client acknowledgement, retry, and deduplication
- Horizontal scalability path with instance-to-instance fan-out

## Architecture

```text
Browser UI (public/index.html + app.js)
       |
       |  Socket.io + REST
       v
Node.js/Express Backend
  - Socket handlers (join, rooms, send, history, typing, presence, delivery)
  - Services (users, messages, sync, rate limiting, presence, delivery)
       |
       +--> PostgreSQL (message persistence)
       |
       +--> Redis Pub/Sub (cross-instance broadcast + presence sync)
```

## Key Features

### Frontend
- Responsive, modern chat UI with room-centric workflow
- Live message stream with typing indicators
- Room members panel and recent room browser
- Runtime diagnostics panel (instance, storage mode, sync status)
- History refresh and reconnect/disconnect controls

### Backend
- Input validation (username, room naming, message size)
- Rate-limited messaging to reduce spam bursts
- Socket acknowledgements for critical events (`join`, `join_room`, `send_message`)
- Room membership tracking + member broadcast updates
- Save-before-broadcast semantics for persisted messaging
- Room history via socket event (`get_room_history`) and REST API
- Redis Pub/Sub service with loop prevention (`sourceInstanceId` + dedupe cache)
- **Presence system** — tracks online/offline status, syncs to Redis, queues messages for offline users
- **Typing indicators** — broadcasts typing/stop-typing per room with auto-timeout on disconnect
- **Delivery guarantees** — client-message deduplication, delivery tracking (sent/delivered/failed), retry with backoff, acknowledgement-based confirmation

## Project Structure

```text
public/
  index.html           # Main frontend app
  styles.css           # Visual design system for UI
  app.js               # Frontend socket + API logic

src/
  index.js             # Express server + routes + startup
  sockets/
    socketHandler.js    # All socket event handlers
  services/
    userService.js      # User session management
    messageService.js   # Message persistence and retrieval
    presenceService.js  # Online/offline tracking + pending delivery
    deliveryService.js  # Delivery state, retries, idempotency
    socketSyncService.js# Redis Pub/Sub fan-out
    rateLimiterService.js # Rate limiting
  config/
    environment.js      # Environment variable loader
    database.js         # PostgreSQL connection pool
    redis.js            # Redis client setup
  utils/
    helpers.js          # Shared utility functions

scripts/
  phase1-smoke.js       # Basic messaging smoke test
  phase2-smoke.js       # Room isolation smoke test
  phase3-smoke.js       # Message persistence smoke test
  phase4-smoke.js       # Redis Pub/Sub sync smoke test
  phase5-smoke.js       # Presence + offline delivery smoke test
  phase6-smoke.js       # Typing indicator smoke test
  phase7-smoke.js       # Delivery guarantees smoke test

test-client.html        # Standalone socket test page
```

## Setup

### Prerequisites
- Node.js 18+
- PostgreSQL (recommended for true persistence)
- Redis (required for multi-instance phase verification)

### Install

```bash
npm install
```

### Configure `.env`

```env
PORT=3000
NODE_ENV=development

DB_HOST=localhost
DB_PORT=5432
DB_NAME=chat_system
DB_USER=postgres
DB_PASSWORD=postgres

REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

SOCKET_CORS=http://localhost:3000

# Optional multi-instance label
INSTANCE_ID=instance-local
```

## Run

```bash
npm run dev
```

Open:
- Frontend: `http://localhost:3000`
- Health: `http://localhost:3000/health`
- Status: `http://localhost:3000/api/status`

## API Endpoints

### `GET /api/status`
Returns runtime status including message store mode, socket sync status, presence stats, and delivery stats.

### `GET /api/rooms?limit=10`
Returns recent active rooms based on persisted messages.

### `GET /api/rooms/:roomId/messages?limit=50`
Returns message history for a room.

## Socket Event Highlights

### Client → Server
- `join` — register username
- `join_room` — enter a chat room
- `leave_room` — leave a chat room
- `send_message` — send a message (with `clientMessageId` for deduplication)
- `get_room_history` — fetch room message history
- `typing`, `stop_typing` — typing indicator signals
- `ack_pending_delivery` — confirm receipt of pending messages
- `ack_message_delivered` — confirm individual message delivery

### Server → Client
- `user_joined`, `active_users` — user lifecycle events
- `room_joined`, `room_left` — room membership events
- `room_user_joined`, `room_user_left`, `room_members` — room presence
- `receive_message` — incoming messages
- `room_history` — historical messages
- `user_typing`, `user_stopped_typing` — typing indicators
- `pending_messages` — queued messages delivered on reconnect
- `delivery_status` — delivery state updates (sent/delivered/failed)
- `error_message` — error notifications

## Smoke Tests

```bash
npm run phase1:smoke    # Basic messaging
npm run phase2:smoke    # Room isolation
npm run phase3:smoke    # Message persistence
npm run phase4:smoke    # Redis Pub/Sub sync
npm run phase5:smoke    # Presence + offline delivery
npm run phase6:smoke    # Typing indicators
npm run phase7:smoke    # Delivery guarantees
```

Notes:
- If PostgreSQL is unavailable, the app falls back to in-memory message storage.
- If Redis is unavailable, cross-instance sync is disabled (Phase 4 smoke will fail until Redis is up).
- Phases 5-7 test presence, typing, and delivery features that work with both in-memory and Redis modes.

## Recruiter Demo Script (5-7 minutes)

1. Show frontend UX: join room, send messages, history reload.
2. Show `/api/status` and explain storage/sync/presence mode.
3. Run Phase 1-3 smoke tests to prove baseline reliability.
4. Explain Redis fan-out path and run Phase 4 smoke with Redis enabled.
5. Demo offline delivery: disconnect user, send messages, reconnect to receive pending.
6. Demo typing indicators in multi-user session.
7. Discuss trade-offs: durability, rate limits, delivery semantics, idempotency, and scaling path.

## License

ISC
