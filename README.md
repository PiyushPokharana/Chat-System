# PulseChat: Distributed Real-Time Chat

PulseChat is a full-stack, interview-ready chat system that demonstrates:
- Real-time messaging with Socket.io
- Room isolation and presence tracking
- Message persistence + room history loading
- Multi-instance sync design with Redis Pub/Sub
- A polished web frontend served from the same Node backend

## Why This Stands Out

This project is intentionally built to show both product execution and systems thinking:
- A usable UI, not just raw socket logs
- Robust socket contracts (validation, acknowledgements, error paths)
- Message durability and replay semantics (history on room join/reload)
- Horizontal scalability path with instance-to-instance fan-out

## Architecture

```text
Browser UI (public/index.html + app.js)
       |
       |  Socket.io + REST
       v
Node.js/Express Backend
  - Socket handlers (join, rooms, send, history)
  - Services (users, messages, sync, rate limiting)
       |
       +--> PostgreSQL (message persistence)
       |
       +--> Redis Pub/Sub (cross-instance broadcast)
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

## Project Structure

```text
public/
  index.html       # Main frontend app
  styles.css       # Visual design system for UI
  app.js           # Frontend socket + API logic

src/
  index.js         # Express server + routes + startup
  sockets/
    socketHandler.js
  services/
    userService.js
    messageService.js
    socketSyncService.js
    rateLimiterService.js
  config/
    environment.js
    database.js
    redis.js

scripts/
  phase1-smoke.js
  phase2-smoke.js
  phase3-smoke.js
  phase4-smoke.js
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
Returns runtime status including message store mode and socket sync status.

### `GET /api/rooms?limit=10`
Returns recent active rooms based on persisted messages.

### `GET /api/rooms/:roomId/messages?limit=50`
Returns message history for a room.

## Socket Event Highlights

### Client -> Server
- `join`
- `join_room`
- `leave_room`
- `send_message`
- `get_room_history`
- `typing`, `stop_typing`

### Server -> Client
- `user_joined`, `active_users`
- `room_joined`, `room_left`
- `room_user_joined`, `room_user_left`, `room_members`
- `receive_message`
- `room_history`
- `user_typing`, `user_stopped_typing`
- `error_message`

## Smoke Tests

```bash
npm run phase1:smoke
npm run phase2:smoke
npm run phase3:smoke
npm run phase4:smoke
```

Notes:
- If PostgreSQL is unavailable, the app falls back to in-memory message storage.
- If Redis is unavailable, cross-instance sync is disabled (Phase 4 smoke will fail until Redis is up).

## Recruiter Demo Script (5-7 minutes)

1. Show frontend UX: join room, send messages, history reload.
2. Show `/api/status` and explain storage/sync mode.
3. Run Phase 1-3 smoke tests to prove baseline reliability.
4. Explain Redis fan-out path and run Phase 4 smoke with Redis enabled.
5. Discuss trade-offs: durability, rate limits, delivery semantics, and scaling path.

## License

ISC
