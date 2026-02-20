# Confera

A self-hosted video conferencing platform with breakout rooms, Q&A, live chat, and lobby management. Built with Next.js, mediasoup (WebRTC SFU), and Socket.IO.

## Features

- **HD Video & Audio** — Simulcast video (100 / 300 / 900 kbps) with automatic quality adaptation per viewer
- **Screen Sharing** — Full-screen or window sharing at up to 1500 kbps / 15 fps
- **Breakout Rooms** — Isolated sub-rooms with independent media routing, optional timers, and auto-return
- **Lobby & Host Controls** — Admit / reject waiting participants; kick, mute, or transfer host role
- **Live Q&A** — Slido-style question board with upvoting, pinning, and answered status (host-only)
- **Persistent Chat** — In-meeting chat stored in the database for the meeting's lifetime
- **Meeting Scheduling** — Create instant or scheduled meetings; email + in-app reminders at 15 min and 5 min before
- **Email Invitations** — Send invite links directly from the meeting room
- **Math Captcha** — JWT-signed anti-bot protection on sign-up and sign-in
- **Automatic Cleanup** — Instant meetings with no activity for 30 minutes are deleted automatically

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), Chakra UI, NextAuth.js v4 |
| Media | mediasoup 3 (SFU), mediasoup-client, Socket.IO 4 |
| Backend | Node.js, Express, Prisma 5, MySQL |
| Auth | NextAuth credentials, bcrypt, JWT (shared secret) |
| TURN | Coturn (self-hosted) |
| Deployment | Docker Compose, host networking |

## Architecture

```
Browser ──WebSocket/WebRTC──► Nginx
                                ├── /meet        → Next.js  :3000
                                └── /media       → Media Server :4000
                                     └── Socket.IO signaling
                                     └── mediasoup SFU (UDP 40000-40100)

MySQL (host) ◄─── Prisma ─── both services
Coturn TURN server (UDP :3478) — NAT traversal for WebRTC
```

**Key patterns:**
- One mediasoup `Router` per meeting; each breakout room gets its own isolated `Router`
- NextAuth signs a JWT with `NEXTAUTH_SECRET`; the media server verifies the same token on every Socket.IO connection
- All Docker containers use `network_mode: host` to reach MySQL on the host and bind WebRTC UDP ports directly

## Getting Started

### Prerequisites

- Docker & Docker Compose
- MySQL running on the host machine
- A domain or server IP reachable by clients (for WebRTC ICE)

### 1. Clone & configure

```bash
git clone https://github.com/raj-saroj-vst-au4/localvidconf.git
cd localvidconf
cp .env.example .env
```

Edit `.env` with your values:

```env
DATABASE_URL="mysql://user:password@localhost:3306/confera"
NEXTAUTH_URL=https://yourdomain.com/meet
NEXTAUTH_SECRET=<run: openssl rand -base64 32>
MEDIASOUP_ANNOUNCED_IP=<your server's LAN or public IP>
TURN_SERVER_URL=turn:yourdomain.com:3478
TURN_SECRET=<shared secret matching turnserver.conf>
SMTP_HOST=smtp.gmail.com
SMTP_USER=you@gmail.com
SMTP_PASSWORD=<app password>
```

### 2. Set up the database

```bash
# Create the database
mysql -u root -p -e "CREATE DATABASE confera;"

# Run migrations
cd packages/web
npx prisma migrate deploy
```

### 3. Configure Nginx (reverse proxy)

```nginx
location /meet {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
}
location /media {
    proxy_pass http://localhost:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

### 4. Build and start

```bash
docker compose up --build -d
```

Check health:
```bash
docker compose ps
curl http://localhost:4000/health
```

## Project Structure

```
├── packages/
│   ├── web/                    # Next.js frontend
│   │   └── src/
│   │       ├── app/            # Pages + API routes
│   │       ├── components/     # UI components (meeting, breakout, Q&A)
│   │       ├── hooks/          # useMeeting, useMediasoup, useSocket, useQA
│   │       └── lib/            # auth, prisma, socket, validators
│   └── media-server/           # Node.js SFU
│       └── src/
│           ├── handlers/       # Socket.IO event handlers
│           ├── services/       # Room, Peer, ReminderScheduler
│           ├── middleware/      # JWT auth, rate limiting
│           └── config/         # mediasoup codecs, CORS
├── prisma/
│   └── schema.prisma           # Shared database schema
├── coturn/
│   └── turnserver.conf         # Coturn TURN server config
└── docker-compose.yml
```

## Environment Variables

See [.env.example](.env.example) for the full list with descriptions.

| Variable | Description |
|---|---|
| `DATABASE_URL` | MySQL connection string |
| `NEXTAUTH_SECRET` | Shared JWT secret (web + media server) |
| `NEXTAUTH_URL` | Public URL including `/meet` basePath |
| `MEDIASOUP_LISTEN_IP` | Always `0.0.0.0` |
| `MEDIASOUP_ANNOUNCED_IP` | IP clients use for WebRTC UDP (LAN or public) |
| `TURN_SERVER_URL` | `turn:yourdomain.com:3478` |
| `TURN_SECRET` | Shared HMAC secret for TURN credentials |
| `CORS_ORIGIN` | Public domain for browser CORS (no trailing slash) |
| `SMTP_*` | SMTP config for email reminders and invites |

## License

MIT
