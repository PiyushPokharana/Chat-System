# Chat System Project Checklist

Use this checklist to track progress from foundation to interview-ready deployment.

## 1) Final End-State Checklist (What the project should become)

### Frontend Experience
- [ ] Basic login/entry with username (no heavy auth initially)
- [ ] User can join instantly
- [ ] Main chat interface has room list (example: #general, #random, #project-x)
- [ ] Chat center shows scrollable message history
- [ ] Each message shows sender name and timestamp
- [ ] Online users list is visible (top or side panel)
- [ ] Typing indicator appears (example: "Rahul is typing...")
- [ ] Input box sends messages instantly

### Real-Time Behavior
- [ ] Sent message appears instantly for sender
- [ ] Other users receive message without page refresh

### Backend Data Flow
- [ ] Frontend sends message through WebSocket to backend
- [ ] Backend persists message to database
- [ ] Backend publishes message event to Redis
- [ ] Other server instances receive event from Redis
- [ ] Connected users receive broadcast in real time

### Final Feature Set
- [ ] Real-time messaging
- [ ] Multiple rooms/channels
- [ ] Message persistence
- [ ] Offline users receive pending messages later
- [ ] Online users update instantly
- [ ] Multi-server backend support
- [ ] Redis-based synchronization
- [ ] Typing indicators
- [ ] Read receipts (optional but strong signal)
- [ ] Delivery guarantees

---

## 2) Phase-Wise Build Checklist

## Phase 0 - Foundation (Day 1)

### Goal
Set up the base system and connectivity.

### Setup
- [x] Initialize backend with Node.js + Express
- [x] Add Socket.io for WebSocket communication
- [x] Configure database (PostgreSQL or MongoDB)
- [x] Configure Redis for Pub/Sub

### Project Structure
- [x] Create src/sockets
- [x] Create src/controllers
- [x] Create src/services
- [x] Create src/models
- [x] Create src/config

### Exit Criteria
- [x] HTTP server runs locally
- [x] WebSocket client can connect successfully

---

## Phase 1 - Basic Real-Time Chat (Day 2-3)

### Goal
Enable direct live chat between users.

### Checkpoints
- [x] Handle socket connection and disconnection
- [x] Assign and track user ID on connect
- [x] Implement send_message emit on client
- [x] Implement receive_message handler on client/server
- [x] Broadcast received message to intended participants

### Exit Criteria
- [x] Two users can exchange messages in real time

---

## Phase 2 - Rooms/Channels (Day 4)

### Goal
Support isolated conversation spaces.

### Checkpoints
- [x] Implement join room event
- [x] Implement leave room event
- [x] Use socket.join(roomId) on backend
- [x] Broadcast only to users in target room
- [x] Prevent cross-room message leakage

### Exit Criteria
- [x] Messages are isolated per room/channel

---

## Phase 3 - Message Persistence (Day 5-6)

### Goal
Store and retrieve message history.

### Data Model
- [x] Create messages schema/table with:
- [x] id
- [x] room_id
- [x] sender_id
- [x] content
- [x] timestamp

### Checkpoints
- [x] Save message before broadcast
- [x] Add API or socket event to fetch room history
- [x] Load old messages when room opens/reloads

### Exit Criteria
- [x] On reload, historical messages are visible

---

## Phase 4 - Redis Pub/Sub for Multi-Server Sync (Day 7-8)

### Goal
Make chat work across multiple backend instances.

### Checkpoints
- [x] Add Redis publisher on message ingest
- [x] Add Redis subscriber on all instances
- [x] Re-broadcast subscribed messages to local sockets
- [x] Avoid duplicate delivery loops

### Exit Criteria
- [ ] Users connected to different server instances still receive messages

---

## Phase 5 - Online/Offline System (Day 9)

### Goal
Handle disconnected users without losing messages.

### Checkpoints
- [ ] Track active users (for example, Redis set)
- [ ] Mark user status on connect/disconnect
- [ ] Store pending messages for offline users
- [ ] Deliver pending messages on reconnect
- [ ] Clear delivered pending queue safely

### Exit Criteria
- [ ] Offline users receive missed messages after reconnect

---

## Phase 6 - Typing Indicator (Day 10)

### Goal
Improve user experience.

### Checkpoints
- [ ] Add typing_start event
- [ ] Add typing_stop event
- [ ] Broadcast typing status in room
- [ ] Auto-clear indicator on timeout/disconnect

### Exit Criteria
- [ ] UI shows "user is typing" correctly

---

## Phase 7 - Delivery Guarantees (Day 11-12)

### Goal
Increase reliability under real-world failures.

### Checkpoints
- [ ] Add message acknowledgement from client
- [ ] Mark delivery state (sent, delivered, failed)
- [ ] Implement retry when ack not received
- [ ] Set retry limits/backoff policy
- [ ] Ensure idempotent handling for duplicate retries

### Concept Validation
- [ ] At-least-once delivery behavior is demonstrated

### Exit Criteria
- [ ] Messaging remains reliable under packet loss/reconnect scenarios

---

## Phase 8 - Scaling Discussion and Documentation (Day 13)

### Goal
Make architecture interview-ready.

### README Topics
- [ ] Sticky sessions vs stateless design
- [ ] Horizontal scaling strategy
- [ ] Message ordering challenges and trade-offs
- [ ] Failure handling and recovery path
- [ ] Why Redis Pub/Sub is used in this design

### Exit Criteria
- [ ] README clearly explains scale architecture decisions

---

## Phase 9 - Testing and Deployment (Day 14-15)

### Goal
Ship a working cloud-hosted system.

### Deployment Targets
- [ ] Deploy backend (Render or Railway)
- [ ] Provision Redis (Upstash or equivalent)
- [ ] Provision cloud database
- [ ] Configure environment variables securely

### Testing
- [ ] Multi-user real-time chat test
- [ ] Multi-room isolation test
- [ ] Persistence/reload test
- [ ] Multi-instance sync test
- [ ] Offline-to-online delivery test
- [ ] Retry/ack reliability test

### Exit Criteria
- [ ] Live chat app is accessible and stable

---

## 3) Quality Gate Checklist (Before calling it complete)

- [ ] End-to-end message path works (send -> persist -> publish -> fan-out)
- [ ] No silent message drops during reconnects
- [ ] Basic logs/metrics exist for debugging
- [ ] Important failure cases are tested
- [ ] README includes architecture diagram and trade-offs

---

## 4) Common Mistakes to Avoid

- [ ] Do not build frontend-only chat without backend architecture
- [ ] Do not skip Redis if claiming scalable multi-instance chat
- [ ] Do not skip persistence if claiming production readiness
- [ ] Do not skip scaling explanation in documentation/interviews

---

## 5) Final Interview Statements (Proof points)

- [ ] "Built a horizontally scalable chat system"
- [ ] "Used Redis Pub/Sub for multi-instance synchronization"
- [ ] "Handled offline message delivery"
- [ ] "Implemented at-least-once delivery guarantees"

---

## 6) Immediate Next Action

- [ ] Start today with Phase 0 + Phase 1
- [ ] Create initial backlog/issues from the checkboxes above
- [ ] Track daily progress against phase exit criteria
