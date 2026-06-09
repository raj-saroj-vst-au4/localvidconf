# MeetClone — Architecture Document

> Self-hosted Google-Meet clone. Audience: newcomers to the codebase. Status as of `8449b04` (`Configure reverse-proxy deployment on /meet base path`).

---

## 1. Overview

MeetClone is a self-hosted video-conferencing platform: a **Next.js 14 (App Router) web app** (`packages/web`) and a standalone **mediasoup SFU media server** (`packages/media-server`) in a single monorepo sharing one **Prisma/MySQL** schema. Users register/sign in with email+password (NextAuth Credentials), create or schedule meetings addressed by a human-readable `code`, and join a WebRTC room where media is routed through the SFU (never peer-to-peer — every track is uploaded as a mediasoup *Producer* and re-fanned out to each peer as a *Consumer*). Real-time signaling and all in-meeting features (lobby, host controls, chat, Q&A, breakout rooms, reminders) run over a single authenticated **Socket.IO** connection. The whole stack is deployed as three **host-networked Docker containers** (web, media-server, **coturn** TURN/STUN) plus a host MySQL, fronted by a two-tier **nginx** reverse proxy that mounts the web app under `/meet` and the media server under `/media`. WebRTC UDP media bypasses nginx and reaches the host directly.

---

## 2. Tech Stack

- **Web**: Next.js 14 (App Router, `output: 'standalone'`, `basePath: '/meet'`), React, Chakra UI (dark theme, 5 breakpoints), NextAuth (JWT strategy, Credentials provider), `mediasoup-client`, `socket.io-client`.
- **Media**: Node.js + Express + Socket.IO 4.7 + **mediasoup 3.13** SFU (native C++ workers), `node-cron` reminder scheduler, Nodemailer SMTP.
- **Data**: MySQL via **Prisma 5.9** (single shared schema), `zod` validators at every input boundary, `bcryptjs` (cost 12), `jsonwebtoken` (HS256).
- **Infra**: Docker / docker-compose v3.8 (`network_mode: host`), **coturn** TURN/STUN, two-tier nginx reverse proxy, certbot/Let's Encrypt (referenced, not automated), Node 20 Alpine images.

---

## 3. System Topology

```
                          ┌─────────────────────────────────────────────┐
   Browser (WebRTC)       │                  THE HOST                    │
   ┌──────────┐           │  (all containers use network_mode: host)    │
   │ Next app │           │                                             │
   │  +       │  HTTPS    │  ┌────────────────┐    ┌──────────────────┐ │
   │ mediasoup├──443/80──▶│  │ public nginx   │    │  internal nginx  │ │
   │ -client  │           │  │ public-proxy   ├───▶│   default.conf   │ │
   └────┬─────┘           │  │ :80/:443       │    │   :80            │ │
        │                 │  └────────────────┘    └───┬──────────┬───┘ │
        │ signaling                                     │          │     │
        │ (Socket.IO /media/socket.io/ → :4000)         │/meet     │/media/
        │ + /meet (HTML/API → :3000)                    ▼          ▼     │
        │                                        ┌──────────┐ ┌─────────┐│
        │                                        │ web :3000│ │ media   ││
        │                                        │ Next.js  │ │ :4000   ││
        │                                        │ standalone│ │Express+ ││
        │                                        └────┬─────┘ │Socket.IO││
        │                                             │       │+mediasoup│
        │   ════ WebRTC UDP/TCP media (NOT via nginx) │       └──┬───┬──┘│
        ├─────────────────────────────────────────────┼─────────┘   │   │
        │   → MEDIASOUP_ANNOUNCED_IP : 40000-40100 ────┼─────────────┘   │
        │                                              ▼                 │
        │   ════ TURN relay (NOT via nginx) ────► ┌─────────┐    ┌──────┐│
        └────────────► coturn :3478/:5349 ───────►│ coturn  │    │MySQL ││
                       relay 49152-65535          └─────────┘    │:3306 ││
                                                                 └──────┘│
              web + media both → DATABASE_URL = localhost:3306 ──────────┘
```

- **nginx carries only signaling + HTTP**: `/meet` → `:3000` (path preserved, basePath expects it); `/media/socket.io/` → `:4000/socket.io/` (prefix stripped, WebSocket-upgraded); `/media/` → `:4000/` (`/media/health`, `/media/turn-credentials`).
- **WebRTC media is UDP and bypasses nginx entirely** — it flows directly browser ↔ `MEDIASOUP_ANNOUNCED_IP:40000-40100`. TURN relay flows to coturn on UDP 3478 / TLS 5349, relay ports 49152-65535. These ports must be opened at the firewall, not the proxy.
- Host networking is why `DATABASE_URL` and nginx upstreams all use `localhost`/`127.0.0.1`.

---

## 4. Repository Layout

```
packages/web/src/
├── app/
│   ├── layout.tsx                         Root layout: SessionProvider > ChakraProvider
│   ├── page.tsx                           Dashboard: list/join/create meetings
│   ├── auth/signin/page.tsx               Tabbed sign-in / register (captcha)
│   ├── meeting/[id]/page.tsx              In-meeting room (orchestrates all hooks/components)
│   ├── meeting/schedule/page.tsx          Schedule-meeting form
│   ├── lobby/[id]/page.tsx                Lobby waiting room (reuses singleton socket)
│   └── api/                               Route handlers (see §6)
│       ├── auth/[...nextauth]/route.ts    NextAuth catch-all
│       ├── auth/register|captcha/route.ts Registration + math-captcha
│       ├── meetings/...                   Meeting lifecycle CRUD + invite + participants
│       ├── questions/...                  Q&A list/create/upvote
│       └── reminders/route.ts             Enqueue reminder rows
├── components/
│   ├── meeting/                           VideoGrid, VideoTile, ControlBar, ParticipantList, ChatPanel (+ dead: HostControls, LobbyManager, ScreenShare)
│   ├── breakout/                          BreakoutManager (+ dead: BreakoutRoomCard, BreakoutTimer)
│   ├── qa/                                QAPanel, QuestionCard, AskQuestionModal
│   ├── layout/Navbar.tsx                  Top nav (session-aware)
│   ├── common/ProtectedRoute.tsx          Client-only auth gate
│   └── providers/                         SessionProvider, ChakraProvider
├── hooks/
│   ├── useSocket.ts                       Binds singleton socket to React lifecycle
│   ├── useMediasoup.ts                    WebRTC engine (Device/transports/produce/consume)
│   ├── useMeeting.ts                      Orchestrator (join/lobby/roster/host controls)
│   ├── useQA.ts                           Q&A state + socket wiring
│   └── useBreakoutRooms.ts               Breakout state + socket wiring
├── lib/
│   ├── prisma.ts                          PrismaClient singleton (hot-reload-safe)
│   ├── auth.ts                            NextAuth authOptions + accessToken minting
│   ├── validators.ts                      Zod schemas (all input boundaries)
│   ├── socket.ts                          Singleton Socket.IO client factory
│   └── mailer.ts                          Nodemailer SMTP (invitation/reminder)
├── styles/theme.ts                        Chakra dark theme
└── types/index.ts                         Hand-written client types (mirror Prisma + media payloads)

packages/media-server/src/
├── index.ts                               Bootstrap: Express + Socket.IO + worker pool + room registry + cron
├── config/
│   ├── cors.ts                            Shared CORS_OPTIONS
│   └── mediasoup.ts                       Codecs, worker settings, transport options, simulcast
├── middleware/
│   ├── socketAuth.ts                      JWT handshake verification (NEXTAUTH_SECRET)
│   └── rateLimiter.ts                     Per-socket per-category sliding-window limiter
├── handlers/
│   ├── connectionHandler.ts               join-meeting / disconnect; joinMeetingRoom helper
│   ├── mediasoupHandler.ts                Transport/produce/consume/resume signaling
│   ├── meetingHandler.ts                  Host controls (lobby/kick/transfer/invite/end)
│   ├── chatHandler.ts                     send-chat / get-chat-history
│   ├── qaHandler.ts                       ask/upvote/mark-answered/pin
│   └── breakoutHandler.ts                 Breakout lifecycle + per-room routers
├── services/
│   ├── Room.ts                            SFU Room (one Router/meeting + breakout routers)
│   ├── Peer.ts                            Per-participant transports/producers/consumers
│   └── ReminderScheduler.ts               node-cron reminder delivery
└── utils/
    ├── logger.ts                          Scoped console logger
    └── networkOptimizer.ts                Adaptive bitrate helpers (DEAD CODE — never imported)
```

---

## 5. Data Model

Single shared `prisma/schema.prisma` (MySQL). External addressing is by `Meeting.code`, not the cuid primary key.

| Model | Purpose | Key relations |
|---|---|---|
| **User** | Authenticated user (email unique; `password` nullable bcrypt hash; `image`). | `hostedMeetings` (relation `host`), `participations`, `questions`, `upvotes`, `sentInvitations` |
| **Meeting** | Core conference session. `code` (unique join code `abc-defg-hij`), `status` (default SCHEDULED), `lobbyEnabled` (default true), `scheduledAt`/`startedAt`/`endedAt`. | `host`→User, `participants`, `breakoutRooms`, `questions`, `invitations`, `reminders`, `chatMessages` |
| **Participant** | Live User↔Meeting junction. `role` (default PARTICIPANT), `status` (default IN_LOBBY), `joinedAt`/`leftAt`. `@@unique([userId, meetingId])`. | `user`, `meeting` (Cascade), `breakoutRoom` (SetNull) |
| **BreakoutRoom** | Small-group sub-room (one mediasoup router each). `isActive`, `endsAt` (auto-close timer). | `meeting` (Cascade), `participants` |
| **Question** | Slido-style Q&A item. `content`, `isAnswered`, `isPinned`. `@@index([meetingId, createdAt])`. | `author`→User, `meeting` (Cascade), `upvotes` |
| **Upvote** | Records who upvoted a question. `@@unique([questionId, userId])` prevents dup votes. | `question` (Cascade), `user` |
| **Invitation** | Email invite to a meeting. `email`, `status` (default PENDING). | `meeting` (Cascade), `invitedBy`→User |
| **Reminder** | Scheduled reminder scanned by cron. `type`, `triggerAt`, `sent`. `@@index([triggerAt, sent])`. | `meeting` (Cascade) |
| **ChatMessage** | Persisted in-meeting chat. `senderEmail`/`senderName` are **denormalized strings, no User FK**. `@@index([meetingId, createdAt])`. | `meeting` (Cascade) |

**Enums**: `MeetingStatus{SCHEDULED,LIVE,ENDED}` · `ParticipantRole{HOST,CO_HOST,PARTICIPANT}` · `ParticipantStatus{IN_LOBBY,IN_MEETING,IN_BREAKOUT,REMOVED}` · `InvitationStatus{PENDING,ACCEPTED,DECLINED}` (DECLINED unused) · `ReminderType{EMAIL,IN_APP}`.

**Model gotchas**: child relations to `Meeting` are `onDelete: Cascade`, but `User`→child relations (host/author/upvote/invitedBy/participant) have **no onDelete rule** (RESTRICT) — a user who hosted/asked/voted **cannot be deleted** without first removing those rows. `Meeting.code` has a redundant `@@index` on top of `@unique`. No `@updatedAt` anywhere. `types/index.ts` is a **hand-written mirror** of these models (dates as `string`; `Question` adds computed `upvoteCount`/`hasUpvoted` not in the DB) and must be updated manually on schema change.

---

## 6. The Web App

**Pages**: `/` dashboard (list/join/create) · `/auth/signin` (tabbed login+register) · `/meeting/schedule` (form) · `/meeting/[id]` (room — `[id]` is the code) · `/lobby/[id]` (waiting room). Every page wraps in `ProtectedRoute` (client-only gate, no `middleware.ts`).

**API routes** (Next App Router; all session-gated via `getServerSession(authOptions)` unless noted; `[id]` = meeting **code**):

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET/POST | `/api/auth/[...nextauth]` | NextAuth (signin/callback/session/csrf/signout) | public |
| POST | `/api/auth/register` | Register: zod + captcha-JWT verify + bcrypt(12) + create User | public |
| GET | `/api/auth/captcha` | Math captcha + 5-min answer JWT | public |
| GET | `/api/meetings` | List user's meetings (hosted OR participating, take 50) | session |
| POST | `/api/meetings` | Create meeting + HOST Participant; +3 reminders if `scheduledAt` | session |
| GET | `/api/meetings/[id]` | Meeting by code w/ host+participants+breakouts | session ⚠️ **no membership check** |
| PATCH | `/api/meetings/[id]` | Host-only settings (title/lobbyEnabled/status LIVE\|ENDED) | host |
| POST | `/api/meetings/[id]/invite` | HOST/CO_HOST invites email; writes Invitation, fires SMTP | host/co-host |
| GET | `/api/meetings/[id]/participants` | List participants | participant ⚠️ returns REMOVED rows |
| GET | `/api/questions?meetingId=` | List questions, ranked (pinned then upvotes) | session ⚠️ **no membership check (IDOR)** |
| POST | `/api/questions` | Create question (participant-gated) | participant |
| POST | `/api/questions/[id]/upvote` | Toggle upvote, returns new count | participant |
| POST | `/api/reminders` | Compute `triggerAt`, persist Reminder row | session ⚠️ **no host/participant check** |

**Key client hooks**: `useSocket` (binds singleton socket, reads `session.accessToken`) → `useMediasoup` (WebRTC engine) → `useMeeting` (top-level orchestrator: join/lobby/roster/host controls + forwards media API) · `useQA` · `useBreakoutRooms`. The room page `meeting/[id]/page.tsx` is the integration hub wiring hook outputs into all feature components.

---

## 7. The Media Server

**Bootstrap (`index.ts → start()`)**: `prisma.$connect()` → `createWorkers()` (round-robin pool, `NUM_WORKERS = ceil(cpus/2)`) → `new ReminderScheduler(prisma, io).start()` → `httpServer.listen(PORT||4000, '0.0.0.0')`. Express adds helmet, CORS, `express-rate-limit`, `GET /health`, and `GET /turn-credentials` (HMAC-SHA1, 24h TTL). `io.use(socketAuthMiddleware)` runs before any connection. SIGINT/SIGTERM → graceful `shutdown()`.

**Per-connection handler registration** — `io.on('connection')` fans out to all 6 registrars, each attaching `socket.on` listeners. Incoming **socket-event routing table**:

| Registrar | Events handled |
|---|---|
| `connectionHandler` | `join-meeting`, `disconnect` |
| `mediasoupHandler` | `create-transport`, `connect-transport`, `produce`, `consume`, `resume-consumer`, `set-preferred-layers`, `pause-producer`, `resume-producer`, `close-producer` |
| `meetingHandler` | `lobby-admit`, `lobby-reject`, `move-to-lobby`, `transfer-host`, `kick-participant`, `invite-participant`, `end-meeting` |
| `breakoutHandler` | `create-breakout`, `broadcast-to-breakouts`, `close-breakouts` |
| `qaHandler` | `ask-question`, `upvote-question`, `mark-answered`, `pin-question` |
| `chatHandler` | `send-chat`, `get-chat-history` |

**Notable server-emitted**: `meeting-joined`, `lobby-waiting`, `lobby-participant`, `participant-joined`, `participant-left`, `producer-closed`, `new-producer`, `error`, plus per-feature events.

**Room/Peer SFU model**: a `Room` (keyed by `meetingCode` in the global `rooms` Map) wraps one mediasoup **Router** per meeting (plus an isolated Router per breakout room) and a `peers` Map keyed by `socket.id`. A `Peer` holds `sendTransport`/`recvTransport` and `producers`/`consumers` maps. Media is **never P2P**: each track → server `Producer` → re-fanned to each peer as a `Consumer`. Router RTP capabilities ride inside the `meeting-joined` payload — there is **no dedicated `getRouterRtpCapabilities` event**. `getOrCreateRoom` lazily creates the Router on the next worker.

**Feature handlers** re-verify HOST/CO_HOST from the DB (`verifyHostRole`) before privileged actions, mutate MySQL via Prisma, then fan out over Socket.IO rooms (`meeting:<code>`, `breakout:<id>`, `lobby:<code>`). `checkRateLimit(socket, event)` is called **manually inside each handler** (categories media/chat/admin/default) — not centrally.

**Reminder cron** (`ReminderScheduler`): `cron.schedule('* * * * *')` → query `Reminder` where `{sent:false, triggerAt:{lte:now}}` (take 50, include non-REMOVED participants) → EMAIL (Nodemailer) or IN_APP (`io.emit('reminder')`) → set `sent:true`. Per-reminder try/catch; failures leave `sent=false` and retry next minute (no backoff/max-retry).

---

## 8. Realtime & WebRTC

**Socket auth handshake** — the web app and media server bridge on a **single shared `NEXTAUTH_SECRET`**:
1. NextAuth `session()` callback mints a **separate plain HS256 JWT** (`session.accessToken = jwt.sign({userId,email,name,picture}, NEXTAUTH_SECRET, {expiresIn:'30d'})`). This is **not** the NextAuth encrypted-JWE cookie.
2. `useSocket` reads `(session as any).accessToken` → `getSocket(token)` sets `socket.handshake.auth.token` (path `/media/socket.io/`, `autoConnect:false`).
3. Media server `io.use(socketAuthMiddleware)` runs `jwt.verify(token, NEXTAUTH_SECRET)` and attaches `socket.data.user = {userId, email, name, image}`. The flow works **only** because auth.ts mints this custom HS256 token; a raw verify against the NextAuth JWE cookie would fail.

**Produce/consume lifecycle** (condensed):
- **Join**: client emits `join-meeting` → server `joinMeetingRoom` creates Peer, joins `meeting:<code>`, emits `meeting-joined` `{meeting, participants, routerCapabilities, existingProducers}`.
- **Setup**: `Device.load(routerCapabilities)` → `getUserMedia` → `create-transport{direction:'send'}` and `{recv}` (server `router.createWebRtcTransport` → returns ICE/DTLS params) → on `transport.on('connect')` emit `connect-transport` (DTLS handshake, once per transport).
- **Produce**: `produce(audio)` then `produce(video)` (3 simulcast layers r0/r1/r2; screen single 1.5 Mbps@15fps) → `transport.on('produce')` emits `produce` → server `createProducer` → broadcasts `new-producer` to other peers → ack returns `producerId`.
- **Consume**: each peer answers `new-producer` (or loops `existingProducers` at join) with `consume{producerId, rtpCapabilities}` → server `createConsumer` (`router.canConsume`, `paused:true`) → client builds consumer → **must emit `resume-consumer`** or no RTP flows.
- **Attach**: video → `<video>` in `VideoTile` (`new MediaStream([consumer.track])`); remote **audio** → hidden `<audio>` `AudioPlayer` elements in `VideoGrid` (never VideoTile).
- **Control/teardown**: `pause/resume-producer` → broadcast `producer-paused/resumed`; `close-producer` → `producer-closed`; disconnect → `Peer.close()` tears down transports/producers/consumers, broadcasts `participant-left` + `producer-closed`, deletes empty Room, sets `Participant.leftAt`.

⚠️ Both transports pass `iceServers: []` (**no TURN/STUN wired into the client** despite coturn existing) — fails across symmetric NAT. Consumers/producers start **paused**; a missing `resume-consumer` is a silent no-video bug.

---

## 9. Key End-to-End Flows

### A. Authentication & session
1. Client `GET /meet/api/auth/captcha` → math question + 5-min JWT embedding the answer.
2. `POST /meet/api/auth/register` → zod + captcha verify + bcrypt(12) + `prisma.user.create` (no session issued; 409 reveals existing emails — user enumeration).
3. `signIn('credentials', {redirect:false, ...})` → NextAuth `authorize()` re-verifies captcha JWT, `bcrypt.compare`.
4. `jwt()` callback stamps `token.userId/email/name/picture` (DB-fetched, **only at sign-in**).
5. `session()` callback projects onto `session.user.id` **and** mints `session.accessToken` (re-minted every call → effectively non-revocable for 30d, no logout/blacklist server-side).
6. `ProtectedRoute` gates pages client-side; `useSocket` carries `accessToken` in the handshake; `socketAuthMiddleware` verifies with the same secret.

### B. Joining a meeting
1. `POST /api/meetings` creates the Meeting + HOST Participant (`IN_MEETING`); host never enters the lobby.
2. Joiner opens `/meeting/<code>` → `useMeeting` emits `join-meeting`.
3. `connectionHandler` upserts Participant. If `lobbyEnabled && hostId !== userId` → `socket.join('lobby:<code>')`, emit `lobby-waiting` to joiner + `lobby-participant` to host.
4. Meeting page detects `isInLobby` → routes to `/lobby/<code>` (reuses singleton socket).
5. Host clicks Admit → `lobby-admit` → `verifyHostRole`, flip status `IN_MEETING`, `joinMeetingRoom` for the waiting socket, emit `admitted` + `participant-joined`.
6. Lobby redirects to `/meeting/<code>`; `useMeeting` re-emits `join-meeting` → `meeting-joined` with roster + `routerCapabilities` + `existingProducers`. The first non-lobby joiner flips meeting `SCHEDULED → LIVE`.
   ⚠️ **Double-join quirk**: `admitted` is handled in both the lobby page (redirect) and `useMeeting` (re-emit) — relies on the participant already being `IN_MEETING` so it doesn't re-lobby.

### C. WebRTC media pipeline
See §8 — publish (getUserMedia → Device.load → send transport → produce → server Producer → `new-producer`) and subscribe (`new-producer` → consume → recv Consumer → `resume-consumer` → track attached). Remote audio routed to hidden `<audio>` players.

### D. Breakout rooms
1. Host configures rooms in `BreakoutManager` (manual/random round-robin, keyed on `Participant.id`) → `create-breakout {rooms, duration}`.
2. Server re-verifies host, validates, per room: creates `BreakoutRoom` row → `Room.createBreakoutRouter` (isolated Router) → flips assigned Participants to `IN_BREAKOUT`.
3. `movePeerToBreakout` **closes the old Peer** and builds a fresh empty Peer on the breakout router; socket leaves `meeting:<code>`, joins `breakout:<id>`, receives `breakout-joined {breakoutRoom, routerCapabilities}`. Whole meeting gets `breakout-created`.
4. Optional server `setTimeout(duration)` auto-calls `closeBreakoutRooms`; host can emit `close-breakouts`.
5. `closeBreakoutRooms` marks rooms inactive, resets participants to `IN_MEETING`, `closeAllBreakouts` rebuilds Peers in main, moves sockets back, emits `breakout-ended` (movers) + `breakout-closed` (all).
   ⚠️ **CRITICAL: media never follows the peer.** `mediasoupHandler` always uses the main Router (the `routerOverride` param is never passed) and `consume` only scans main-room peers. No client code re-runs `initializeMedia` against the new router. **Breakout participants are reassigned in DB + socket namespace but are black/silent**, and remain medialess even after returning until a full re-join.

### E. Q&A, chat, reminders
- **Q&A**: one REST bootstrap `GET /meet/api/questions?meetingId=` then all live over sockets — `ask-question`/`upvote-question`/`mark-answered`/`pin-question` → `qaHandler` persists (Question/Upvote) and broadcasts `new-question`/`question-upvoted`/`question-answered`/`question-pinned` to `meeting:<code>` (ask/upvote also to active breakouts). Upvote is optimistic; server echoes only canonical `upvoteCount`, never `hasUpvoted`.
- **Chat**: `send-chat` → `chatHandler` persists a `ChatMessage` (denormalized sender) and relays `new-chat` to the breakout room (if socket is in one) else `meeting:<code>`. `get-chat-history` acks last 100 **whole-meeting** messages (breakout chat leaks into main history).
- **Reminders**: `ReminderScheduler` cron polls Reminder rows; EMAIL via Nodemailer; IN_APP via **global** `io.emit('reminder', {...targetEmail})` once per participant, filtered client-side.

---

## 10. Feature Inventory

- **Lobby**: `lobbyEnabled` per meeting; non-hosts held in `lobby:<code>`, admitted/rejected by host via `ParticipantList` (the `HostControls` lobby toggle and `LobbyManager` "Admit All" UIs are **dead code** — no backing in `useMeeting`).
- **Host controls** (`meetingHandler`): admit/reject, move-to-lobby, kick, transfer-host, invite (SMTP), end-meeting; each re-verifies HOST/CO_HOST in the DB.
- **Chat** (`chatHandler`): persistent, breakout-scoped broadcast, last-100 history.
- **Q&A** (`qaHandler` + `useQA`): ask, optimistic upvote (toggle), host mark-answered/pin, ranked pinned-then-upvotes.
- **Breakout rooms** (`breakoutHandler` + `useBreakoutRooms`): per-room isolated routers, manual/random assignment, auto-close timer, broadcast — **media path broken** (see §9D).
- **Screen share**: `getDisplayMedia` → single-layer `screen` producer (`appData.type:'screen'`), rendered inline by `VideoGrid` (standalone `ScreenShare.tsx` is dead code).
- **Scheduling / reminders**: scheduled meetings create 3 reminder rows (EMAIL@-15, EMAIL@-5, IN_APP@-5); delivered by media-server cron.
- **Network optimization**: `set-preferred-layers` simulcast adaptation is wired; the `networkOptimizer.ts` adaptive-bitrate strategy is **exported but never imported (dead code)**.

---

## 11. Deployment & Config

**Services / ports** (all on the host via `network_mode: host`): web `:3000` (Next standalone `server.js`), media-server `:4000` (Express+Socket.IO), MySQL `:3306` (host service), mediasoup RTC `40000-40100` UDP+TCP, coturn `3478` (STUN/TURN) + `5349` (TLS) + relay `49152-65535`. Public nginx `:80/:443`; internal nginx `:80`. Healthchecks: web → `/meet/api/auth/session`, media → `/health`. Media-server container gets `SYS_NICE` for worker thread priority.

**Env-var surface** (`.env.example`):

| Var | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | web + media | MySQL; `localhost:3306` under host networking |
| `NEXTAUTH_SECRET` | web + media | **Linchpin** — signs captcha JWT, accessToken, NextAuth cookie; verified by socketAuth |
| `NEXTAUTH_URL` | web + media | Mailer/reminder join links, NextAuth callbacks |
| `GOOGLE_CLIENT_ID/SECRET` | (web) | **Defined but unused** — no Google provider exists (see §12) |
| `MEDIASOUP_LISTEN_IP` / `MEDIASOUP_ANNOUNCED_IP` | media | `announcedIp` defaults to `127.0.0.1` — **must be client-reachable in prod or media silently fails** |
| `TURN_SERVER_URL/USERNAME/PASSWORD/SECRET` | media + coturn | Only `TURN_SECRET` (= coturn `static-auth-secret`) is used by the HMAC flow; URL/USERNAME/PASSWORD are **dead config** |
| `SMTP_HOST/PORT/USER/PASSWORD/FROM` | web + media | Invites/reminders; missing creds fail silently (logged only) |
| `CORS_ORIGIN` | media | Comma-split; must equal public domain, **no trailing slash/path** |
| `NODE_ENV`, `LOG_LEVEL` | both | Gate Prisma logging, singleton caching, logger level |

**Reverse-proxy notes**: public nginx → internal nginx → `:3000`/`:4000`. `$connection_upgrade` map handles WebSocket upgrade (Socket.IO + Next HMR); `$real_proto` preserves `X-Forwarded-Proto` for NextAuth HTTPS callbacks. Public proxy ships as **plain HTTP** — camera/mic need a secure context, so media is non-functional until the commented HTTPS/certbot block is enabled. nginx **cannot proxy UDP**: mediasoup + TURN ports must be firewall-opened directly to the host.

**TURN notes**: coturn uses `use-auth-secret` (HMAC REST). `/turn-credentials` mints `username = "<now+24h>:meetuser"`, `credential = base64(HMAC-SHA1(TURN_SECRET, username))`. coturn **denies RFC1918 peer ranges by default** — with a LAN `MEDIASOUP_ANNOUNCED_IP`, relay fails unless the commented `allowed-peer-ip` line is uncommented.

---

## 12. Notable Findings

**Security — critical**
- **`setup-mysql-lan.sh` exposes MySQL on `0.0.0.0:3306` to any IP** (`ufw allow 3306` no source restriction) with a **hardcoded password `Meet@Pass2026`** that doesn't match `.env.example`. Opens the DB to the LAN/internet.
- **Committed placeholder secrets** must be rotated: `static-auth-secret=your_turn_shared_secret_here`, `NEXTAUTH_SECRET`/`TURN_SECRET`/`SMTP_PASSWORD` placeholders. As-shipped, TURN HMAC and NextAuth JWTs are trivially forgeable.
- **Secret overloading**: `NEXTAUTH_SECRET` guards three trust domains (captcha, accessToken, NextAuth cookie). Leak → forge captcha tokens **and** mint an accessToken for any `userId` (media server trusts the payload with no DB re-verification).
- **accessToken effectively non-revocable for 30 days** — re-minted each `session()` call, no logout/blacklist server-side; a deleted user keeps a working socket token.
- **Captcha is security theater** — the answer is embedded in the JWT handed to the client, reusable for its 5-min TTL, no nonce/single-use/rate-limit.
- **`jwt.verify` with no algorithm allowlist** in socketAuth (alg-confusion/`none` risk if token format were attacker-controlled).

**Security — authz gaps**
- `GET /api/meetings/[id]` has **no membership check** — any authed user with the code reads the full participant roster (emails). Compounded by `generateMeetingCode` using `Math.random()` (predictable codes) despite a comment claiming nanoid.
- `GET /api/questions` (**IDOR**) and `ask-question` socket path have no participant check.
- `POST /api/reminders` has **no host/participant check** — any user can schedule reminders (SMTP + broadcast) for any meeting → spam/amplification.
- **Client-only host gating**: host buttons are hidden by `isHost` but emitted events carry no proof of role — relies entirely on server `verifyHostRole` (which exists for meeting controls, but **breakout `create-breakout` never validates `participantIds` belong to the meeting**, and `mark-answered`/`pin-question` don't scope by `meetingId` → cross-meeting actions).
- **`ProtectedRoute` is 100% client-side** (no `middleware.ts`) — page JS still ships to unauthenticated users.

**Privacy / correctness**
- **IN_APP reminder leak**: `io.emit('reminder', {...targetEmail})` global-broadcasts, once per participant — every connected client (all meetings) receives every participant's email; O(N) duplicate broadcasts.
- **Breakout chat/Q&A leak**: persisted with `meetingId` only; `get-chat-history` returns whole-meeting last-100, exposing breakout chat in main history.
- **Email/HTML injection**: `mailer.ts` and invite/reminder handlers interpolate `meeting.title`/`user.name` **unescaped** into email HTML.

**Functional bugs**
- **Breakout media is broken end-to-end** (§9D) — participants reassigned but black/silent; never restored without re-join.
- **No TURN/STUN in the client** (`iceServers: []`) — fails across symmetric NAT despite coturn being deployed.
- **`participant-left` field mismatch**: server emits `{participantId, socketId}`; `useMediasoup` keys on `socketId`, `useMeeting` on `participantId` — easy to break one consumer.
- **Silent producer death**: `producer.on('transportclose')` does not emit `producer-closed` → ghost tiles on transport/ICE failure.
- **Breakout timer leaks**: `setInterval` cleanup is returned from the socket callback, not the effect → intervals stack; no client auto-return at 0.
- **`generateMeetingCode` no uniqueness retry** → unhandled Prisma P2002 → 500.
- **Upvote toggle not transactional** (findUnique→create/delete→count) → concurrent toggles can throw on `@@unique`, only logged.
- **`MEDIASOUP_ANNOUNCED_IP` defaults to loopback** → remote media silently fails if unset.
- **RTC port range 40000-40100 (~101 ports) shared across all workers** — a hard capacity ceiling at scale.

**Gaps / dead code / TODOs**
- **No Google OAuth despite framing** — only `CredentialsProvider`; no Google client, adapter, or Account/Session models. The `lh3.googleusercontent.com` image allowlist and `GOOGLE_CLIENT_*` env vars are vestigial.
- **Horizontal scaling broken**: `rooms`/`workers` are in-process Maps, no Redis/Socket.IO adapter — two users on different media replicas for the same code get different Rooms and can't see each other.
- **Worker `died` recovery** re-creates a bare worker but not its Routers/Rooms — meetings on a dead worker silently break.
- **Reminder scheduler single-instance** — multiple replicas double-send; failed sends retry forever (no backoff).
- **`networkOptimizer.ts`, `HostControls`, `LobbyManager`, `ScreenShare`, `BreakoutRoomCard`, `BreakoutTimer`, `ResponsiveContainer`** are all dead/orphaned.
- `close-producer` and `pin-question` have **no rate-limit guard**; `mark-answered` reuses the upvote bucket. `checkRateLimit` returning false silently returns with no ack → clients can hang.

---

## 13. "Where do I change X?" Guide

| Task | Files |
|---|---|
| **Add/change a DB field or model** | `prisma/schema.prisma` → migrate → update the hand-written mirror `packages/web/src/types/index.ts` → update relevant `packages/web/src/lib/validators.ts` Zod schema |
| **Change auth / session / the media-server token** | `packages/web/src/lib/auth.ts` (authOptions, `jwt()`/`session()` callbacks, accessToken minting) + `packages/media-server/src/middleware/socketAuth.ts` (must verify with the same `NEXTAUTH_SECRET`) |
| **Add a REST API route** | `packages/web/src/app/api/.../route.ts` (gate with `getServerSession(authOptions)`, validate via `lib/validators.ts`, query via `lib/prisma.ts`) |
| **Add a real-time (socket) event** | server: new handler in `packages/media-server/src/handlers/`, register it in `index.ts` `io.on('connection')`, add `checkRateLimit`; client: emit/listen in the relevant hook (`useMeeting`/`useQA`/`useBreakoutRooms`) |
| **Change WebRTC produce/consume behavior** | client `packages/web/src/hooks/useMediasoup.ts`; server `packages/media-server/src/handlers/mediasoupHandler.ts` + `services/Room.ts`/`Peer.ts` |
| **Tune codecs, simulcast, transport, ports, workers** | `packages/media-server/src/config/mediasoup.ts` (MEDIA_CODECS, SIMULCAST_ENCODINGS, WEBRTC_TRANSPORT_OPTIONS, WORKER_SETTINGS, NUM_WORKERS) — keep RTC port range in sync with the media-server Dockerfile UDP EXPOSE |
| **Add TURN/STUN to clients** (currently missing) | `packages/web/src/hooks/useMediasoup.ts` (`iceServers` in `createSend/RecvTransport`); fetch creds from `GET /media/turn-credentials` (`packages/media-server/src/index.ts`); coturn `coturn/turnserver.conf` |
| **Change host controls / lobby logic** | server `packages/media-server/src/handlers/meetingHandler.ts` + `connectionHandler.ts`; client `useMeeting.ts` + `components/meeting/ParticipantList.tsx` |
| **Change chat / Q&A behavior** | chat: `handlers/chatHandler.ts` + `components/meeting/ChatPanel.tsx`; Q&A: `handlers/qaHandler.ts` + `hooks/useQA.ts` + `components/qa/*` |
| **Change breakout rooms** | `handlers/breakoutHandler.ts` + `services/Room.ts` (router/peer migration) + `hooks/useBreakoutRooms.ts` + `components/breakout/BreakoutManager.tsx` |
| **Change emails / reminders / scheduling** | `packages/web/src/lib/mailer.ts`, `app/api/reminders/route.ts`, `app/api/meetings/route.ts` (reminder rows on create); delivery in `packages/media-server/src/services/ReminderScheduler.ts` |
| **Change deployment, ports, proxy, base path, TURN** | `docker-compose.yml`, `packages/*/Dockerfile`, `nginx/default.conf` + `nginx/public-proxy.conf`, `coturn/turnserver.conf`, `.env.example`, and `packages/web/next.config.js` (`basePath: '/meet'`) — note fetch URLs are hardcoded with `/meet` |