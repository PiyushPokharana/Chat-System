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
- Presence tracking with offline queueing and delivery-on-reconnect
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

## Scaling Decisions (Interview Focus)

### 1) Sticky sessions vs stateless design

WebSockets are stateful, so production deployment usually requires sticky sessions at the load balancer when a connection must keep hitting the same app instance.

In PulseChat:
- Client socket affinity (sticky sessions) is recommended for transport stability.
- Message fan-out correctness does not depend on sticky sessions because Redis Pub/Sub propagates messages across all instances.
- Presence and pending delivery logic is designed so each node can still cooperate via shared infrastructure, reducing dependence on any single process.

Trade-off:
- Sticky sessions simplify real-time transport behavior.
- Stateless event propagation (via Redis + durable store) simplifies scaling and recovery.
- Practical architecture uses both: sticky transport + stateless data/event path.

### 2) Horizontal scaling strategy

Current scale-out plan:
1. Run multiple Node/Socket.io instances behind a load balancer.
2. Persist messages in PostgreSQL.
3. Publish new messages to Redis channel.
4. Every instance subscribes and re-broadcasts to its local sockets.

Why this scales:
- Each app instance handles only its local socket connections.
- Cross-instance message propagation is delegated to Redis.
- Durable state remains in PostgreSQL, so app nodes can be replaced without data loss.

### 3) Message ordering challenges and trade-offs

Ordering is easy within a single sender + single room on a single process, but gets harder across:
- multiple senders,
- multiple instances,
- retries/reconnect paths.

Current approach:
- Messages include timestamps and message IDs.
- At-least-once delivery can cause duplicates; client dedupes by message ID.
- Cross-instance propagation prioritizes availability and delivery over perfect global ordering.

Trade-off:
- We guarantee high delivery reliability and replay support.
- We do not claim strict total order under all distributed failure scenarios.

### 4) Failure handling and recovery path

Failure modes and behavior:
- PostgreSQL unavailable: fallback to in-memory message store (demo mode).
- Redis unavailable: app still works single-instance, but cross-instance sync is disabled.
- Client disconnects: presence flips offline and pending messages are queued.
- Client reconnects: pending queue is delivered and cleared only after acknowledgement.
- Missing delivery ack: server retries with backoff until max attempts, then marks failed.

Recovery path:
- Reconnect client -> rejoin room -> load history + receive pending.
- Restart instance -> rebuild in-memory runtime state from active traffic + persisted history.

### 5) Why Redis Pub/Sub is used in this design

Redis Pub/Sub solves the fan-out gap in multi-instance Socket.io deployments:
- Without Redis, an instance can only broadcast to sockets connected to itself.
- With Redis, one ingest event becomes a cluster-wide event.

Benefits:
- Low latency cross-instance propagation.
- Simple mental model for distributed broadcasts.
- Good fit for event-driven chat systems.

Trade-off:
- Pub/Sub is ephemeral (not a durable queue), so PostgreSQL remains the source of truth for message history.

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
- Save-before-broadcast semantics for persisted messaging
- Room history via socket event (`get_room_history`) and REST API
- Redis Pub/Sub service with loop prevention (`sourceInstanceId` + dedupe cache)
- Presence system with reconnect delivery of pending messages
- Typing indicators with timeout/disconnect cleanup
- Delivery tracking (`sent`, `delivered`, `failed`) with retry/backoff
- Idempotent duplicate handling using `clientMessageId`

## Project Structure

```text
public/
  index.html            # Main frontend app
  styles.css            # Visual design system for UI
  app.js                # Frontend socket + API logic

src/
  index.js              # Express server + routes + startup
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

scripts/
  phase1-smoke.js
  phase2-smoke.js
  phase3-smoke.js
  phase4-smoke.js
  phase5-smoke.js
  phase6-smoke.js
  phase7-smoke.js
```

## Setup

### Prerequisites
- Node.js 18+
- PostgreSQL (recommended for true persistence)
- Redis (required for full multi-instance verification)

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
Returns room history.

## Socket Event Highlights

### Client -> Server
- `join`
- `join_room`
- `leave_room`
- `send_message` (supports `clientMessageId`)
- `get_room_history`
- `typing_start`, `typing_stop`

### Server -> Client
- `user_joined`, `active_users`, `user_disconnected`
- `room_joined`, `room_left`, `room_user_joined`, `room_user_left`, `room_members`
- `receive_message`, `deliver_message`, `room_history`, `pending_messages`
- `typing_start`, `typing_stop`, `typing_status`
- `message_delivery_update`, `message_delivery_summary`
- `error_message`

## Smoke Tests

```bash
npm run phase1:smoke
npm run phase2:smoke
npm run phase3:smoke
npm run phase4:smoke
npm run phase5:smoke
npm run phase6:smoke
npm run phase7:smoke
```

Notes:
- If PostgreSQL is unavailable, the app falls back to in-memory message storage.
- If Redis is unavailable, cross-instance sync is disabled (Phase 4 smoke fails until Redis is up).

## Cloud Deployment (Phase 9)

- Provider blueprint file: [render.yaml](/c:/Users/piyus/New Volumne (P)/Work/Project_Desc/Chat-System/render.yaml)
- Step-by-step deployment runbook: [DEPLOYMENT.md](/c:/Users/piyus/New Volumne (P)/Work/Project_Desc/Chat-System/DEPLOYMENT.md)

After deployment, verify the live environment:

```bash
npm run phase9:verify -- --baseUrl https://<your-deployed-url>
```

For strict Redis-sync validation:

```bash
npm run phase9:verify -- --baseUrl https://<your-deployed-url> --requireRedisSync
```

## Recruiter Demo Script (5-7 minutes)

1. Show frontend UX: join room, send messages, reload history.
2. Show `/api/status` and explain storage/sync/presence/delivery modes.
3. Run smoke tests (phases 1-3) for core reliability.
4. Demonstrate offline queue and reconnect (phase 5 behavior).
5. Demonstrate typing + delivery guarantees (phases 6-7).
6. Explain scaling decisions from the section above.

## License

ISC
