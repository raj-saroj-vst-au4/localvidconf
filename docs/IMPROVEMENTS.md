# Meet-Clone Improvement Roadmap

> **Editor's correction (verified against the live host):** Several reviewer/verifier agents ran on the dev box (.23, 8 cores) and wrongly "disproved" the worker sizing. On the **actual deployment host 10.127.1.70 the measured reality is 512 cores / 1 TB RAM, and the media-server reports 256 mediasoup workers** (`nproc`=512; `/health` → `workers:256`). So §12's "8 cores → 4 workers" claim is wrong, and the **RTC port-range issue (#7) is real and arguably higher than "medium"**: 256 workers share the 101-port `40000-40100` range, so under host networking the whole server caps at roughly 50–100 concurrent peers regardless of the 512 cores. Everything else stands.

---


## 1. TL;DR

This is a competent, feature-rich mediasoup SFU + Next.js app that works end-to-end on a single host but is not yet safe for broader/multi-tenant or off-LAN use. The dominant theme is **missing authorization scoping**: socket admin handlers and several REST routes trust client-supplied IDs, enabling cross-meeting IDOR (including host-role hijack) and PII/Q&A leakage to any authenticated user. The second theme is **media plumbing that is silently incomplete**: TURN/ICE servers are never sent to clients (restrictive-NAT users hang on a black screen), there is no ICE/transport reconnection, and the entire breakout-media path plus the adaptive-bitrate optimizer are dead code. The third theme is **operational fragility**: live production secrets sit in plaintext on a group-readable shared host, MySQL is exposed to 0.0.0.0 with a wildcard grant, there are zero tests, no CI, a broken lint script, no migrations, and no DB backups. The biggest, cheapest levers are: lock down the IDOR/auth gaps, wire up TURN credentials, rotate/scope the on-disk secrets and MySQL firewall, and stand up a minimal test+CI+lint baseline — most of these are S/M effort with outsized payoff.

## 2. Top 10 improvements

| # | Improvement | Category | Severity | Effort | Why it matters |
|---|-------------|----------|----------|--------|----------------|
| 1 | Scope all socket admin handlers + Q&A reads to the host's own meeting (fix cross-meeting IDOR & host-hijack) | Security | Critical | M | Authenticated host of meeting A can kick/promote/read participants of any other live meeting |
| 2 | Rotate + relocate plaintext production secrets; lock MySQL to the app host only | Security/Infra | Critical | S–M | Live DB/SMTP/NextAuth/TURN creds in group-readable files; MySQL open to 0.0.0.0 with wildcard grant |
| 3 | Fetch `/turn-credentials` and pass `iceServers` to both transports | Correctness | High | M | Without it, every restrictive-NAT/firewalled user silently fails to connect |
| 4 | Add membership/host authz to GET /api/questions, GET /api/meetings/[id], POST /api/reminders | Security | High | S | Any logged-in user can read rosters+emails, Q&A graphs, and spam reminders/SMTP |
| 5 | Always answer rate-limited media acks + add client ack timeouts/retry | Reliability | High | M | A single dropped ack permanently, silently wedges the media join |
| 6 | Stand up CI + fix the broken lint + first test suite (validators, auth, Room state) | Testing/DX | High | M–L | Zero tests, non-functional lint, no CI — broken socket/type contracts reach prod undetected |
| 7 | Decouple RTC port range from worker count; right-size workers; fix port exhaustion | Scalability | Medium* | M | Shared 101-port range caps concurrency far below host capacity |
| 8 | Add ICE/transport reconnection + connectionstatechange + reconnecting banner | Reliability/UX | High | L | Any Wi-Fi blip kills the call until full page reload, with no user feedback |
| 9 | Surface getUserMedia/connection/kick errors in the UI | UX | Critical (UX) | M | The most common real-world failures (mic blocked, kicked, disconnected) give zero feedback |
| 10 | Adopt versioned Prisma migrations + nightly MySQL backups | Infra | High | M | No migration history, no rollback, no backup of all user/meeting data |

\* Severity reflects verification: the "512-core/256-worker" framing was disproven (host has 8 cores → 4 workers); the residual shared-narrow-port-range issue is real and corrected to **medium**.

## 3. Critical / must-fix (verified/standing only)

1. **Cross-meeting IDOR in socket admin handlers** — `security-authz#0` (confirmed, critical).
   - Where: `packages/media-server/src/handlers/meetingHandler.ts:30-44` (`verifyHostRole`) and callers (lobby-admit:85, lobby-reject:144, move-to-lobby:182/196, kick:321/330, transfer-host:252/274); `qaHandler.ts:199/239`; `breakoutHandler.ts:59,102-110`.
   - Fix: have `verifyHostRole` return the host's `meetingId`; in every handler fetch the target row constrained to that meeting (`findFirst({ where: { id, meetingId }})`) or use `updateMany({ where: { id, meetingId }})` and treat `count===0` as forbidden. Validate IDs with `z.string().cuid()` at the boundary. `transfer-host` is highest priority (forced cross-meeting HOST promotion).

2. **Live production secrets in plaintext on a shared host** — `infra-deploy#0` (confirmed critical; the "committed to git" framing was partially rejected — only a placeholder is tracked, so no git-history scrub is needed).
   - Where: `.env`, `deploy/.env.media70`, `deploy/.env.web70` (mode 0664, group `raj`); `deploy/turnserver.conf:19`.
   - Fix: rotate DB password, `NEXTAUTH_SECRET`, `SMTP_PASSWORD` (live IITB mail cred), `TURN_SECRET`, `TURN_SERVER_PASSWORD` now. `chmod 0600`, owner = deploy user. Template `turnserver.conf`'s `static-auth-secret` and render at deploy. Move to Docker secrets/SOPS long term.

3. **MySQL exposed to 0.0.0.0 with wildcard grant + open firewall** — `infra-deploy#1` (confirmed critical).
   - Where: `setup-mysql-lan.sh:7-33`.
   - Fix: `bind-address=10.127.1.23`, create `meetuser'@'10.127.1.70'` (not `'%'`), replace `ufw allow 3306/tcp` with `ufw allow from 10.127.1.70 to any port 3306`. Source password from env/secret, grant least privilege, drop the trailing password echo.

4. **getUserMedia / kicked / disconnect failures are silent** — `ux-mobile-a11y#0` (UX-critical).
   - Where: `useMediasoup.ts:108-120`; dashboard never reads `?kicked`/`?ended` flags.
   - Fix: branch on `err.name` (NotAllowed/NotFound/NotReadable) with actionable toasts; set `isVideoEnabled=false` on audio-only fallback; surface kick/ended reasons on the dashboard.

> Note: the original list also flagged `webrtc-sfu-core#0/#1`, `scalability-multiinstance#0/#1`, `reliability-observability#0`, and `breakout-feature#0/#1` as "critical." After verification, several were **downgraded** (see §12 and the corrected severities used throughout). The genuinely critical-and-standing items are #1 and the two infra secrets/DB items above; the breakout-media items (`breakout-feature#0/#1`, both still **critical**) are correctness-critical but the feature is unused today, so they belong in Phase 3 product work rather than "before broader use."

## 4. Scalability & performance

- **RTC port range vs workers** (`webrtc-sfu-core#0` confirmed; `scalability-multiinstance#1` and `infra-deploy#2` corrected to medium — host is 8-core, not 512): all workers share `40000-40100` (101 ports), capping concurrent transports. Fix: give each worker a disjoint `portRange`, **or** adopt mediasoup `WebRtcServer` single-port mode (preferred behind a firewall), **or** widen the shared range (e.g. 40000-49999, not overlapping coturn's 49152-65535). Make `NUM_WORKERS` env-driven (`config/mediasoup.ts:23-30`). Sync Dockerfile `EXPOSE` and firewall.
- **Multi-instance path** (`scalability-multiinstance#0`, confirmed but corrected to **high/latent** — currently single-instance): room/worker state is in-process and Socket.IO uses the default adapter. To ever run a 2nd replica you need (a) `@socket.io/redis-adapter` and adapter-aware `io.in(socketId)` instead of `io.sockets.sockets.get()`, and (b) media affinity via a Redis room-directory + HAProxy stick-table pinning a meeting to one instance. **Recommendation: stay single-process** for now and just right-size workers; do not invest in the XL multi-instance path until traffic demands it.
- **Bitrate config** (`webrtc-sfu-core#9`): lower per-sender `setMaxIncomingBitrate` (10 Mbps → ~3-4 Mbps) to bound abuse; raise recv `initialAvailableOutgoingBitrate` (1 → 2-3 Mbps) so high simulcast layers appear faster on join (`Room.ts:143`, `config:97`).
- **DB/query improvements**:
  - Denormalize an `upvoteCount Int @default(0)` counter maintained in-transaction; drop the full `upvotes` include and sort in SQL; add `@@index([meetingId, isPinned, upvoteCount])` (`data-model-prisma#4`, `web-api-quality#6`).
  - Add cursor pagination to GET /api/questions (currently unbounded), get-chat-history (caps the wrong end — late joiners get the *oldest* 100), and GET /api/meetings (silent take:50) (`data-model-prisma#7`, `web-api-quality#7`).
  - Stop driving socket fan-out with per-event breakout DB queries; track active breakout IDs in memory or use a shared meeting room (`data-model-prisma#8`).
  - Configure Prisma `connection_limit`/`pool_timeout`/`connect_timeout` for the remote MySQL on both processes; add slow-query logging (`data-model-prisma#11`, `reliability-observability#7`).
- **Adaptive media is dead code** (`webrtc-sfu-core#5`, confirmed high): `networkOptimizer.ts` is never called and the client never emits `set-preferred-layers`, so the "audio > screen > video" strategy doesn't exist. Either wire it end-to-end (periodic `getStats()` → `assessNetworkQuality` → `set-preferred-layers`) or delete the module.

## 5. Architecture & maintainability

- **Dead code to delete or wire up** (`maintainability-product#0`): `HostControls.tsx`, `LobbyManager.tsx`, `ScreenShare.tsx`, `AskQuestionModal.tsx`, `networkOptimizer.ts`, plus `BreakoutTimer.tsx`/`BreakoutRoomCard.tsx`, `Room.movePeerToMain`/`getBreakoutPeers` (`breakout-feature#6`). Make a keep/cut decision per file — `LobbyManager` and `AskQuestionModal` close real gaps cheaply; `ScreenShare`/`HostControls` are superseded.
- **Type/validator duplication** (`data-model-prisma#1`, `testing-tooling#3/#4`, `maintainability-product#5/#6`): hand-written `types/index.ts` already drifts from Prisma (missing `leftAt`, `invitedById`; dates typed `string`). 91 `any` casts sit on the auth/session/signaling boundaries; socket acks are typed bare `Function`. Introduce a shared `packages/shared` (or `packages/types`) workspace exporting the socket event map + DTOs, type the Socket.IO server/client with `ServerToClientEvents`/`ClientToServerEvents`, add a NextAuth module augmentation for `session.user.id`/`accessToken`, and derive client types from Prisma payload helpers.
- **Error handling** (`web-api-quality#1`, confirmed high): none of the 7 REST routes have try/catch; bad JSON bodies and Prisma P2002/P2025 surface as opaque 500s. Add a shared `withApi(handler)` wrapper: safe JSON parse → 400, P2002 → 409, P2025 → 404, ZodError → 400, else 500 + requestId. Standardize one response envelope (`web-api-quality#8`).
- **Inconsistent identifiers / validation** (`web-api-quality#9`): `params.id` is a meeting *code* in some routes and a cuid in others; PATCH meeting hand-rolls validation. Pick one external identifier and validate `params.id` before querying.
- **Single `requireHost` helper**: `verifyHostRole` is reimplemented in `qaHandler` and `breakoutHandler`; extract one definition typed `Promise<Participant | null>` (`maintainability-product#6`).
- **Stale Google-OAuth framing** (`maintainability-product#7`): schema/page/email copy claim Google OAuth though auth is credentials+bcrypt — the invite email even tells users they need a Google account. Fix the copy.

## 6. Frontend / UX / accessibility (highest-impact)

- **Pre-join "green room" + device picker** (`ux-mobile-a11y#1`, `maintainability-product#8`): no self-preview, no mic/cam/speaker selection (`enumerateDevices`/`setSinkId` unused). Table-stakes; prevents wrong-device/hot-mic joins.
- **Connection/reconnect feedback** (`ux-mobile-a11y#2`, ties to `webrtc-sfu-core#7`): persistent "Reconnecting…" banner (`aria-live`), success toast on reconnect, and an actual rejoin path.
- **Kicked/meeting-ended messaging** (`ux-mobile-a11y#3`): dashboard reads `?kicked`/`?ended` and shows a toast.
- **Stale-closure correctness bugs** (high): `host-changed` reads stale `participants` so host transfer mis-resolves `isHost` (`frontend-react#0`); `participant-left` field mismatch (`p.id` vs `socketId`) leaves ghost tiles/roster entries (`frontend-react#1`). Fix via refs/functional updaters and one canonical payload type.
- **Single socket source of truth** (`frontend-react#2`, dup of `breakout-feature#13`): the page calls `useSocket()` twice → duplicate listeners and drifting `isConnected`. Lift to context or return from `useMeeting`; fix `getSocket` to reuse the instance whenever non-null.
- **React error boundary** (`frontend-react#3`): add `app/meeting/[id]/error.tsx` and wrap `VideoGrid` so one bad tile can't white-screen the call.
- **Memoization / immutable peer updates** (`frontend-react#4`): `VideoTile`/`VideoGrid` aren't memoized and `PeerMedia` is mutated in place — re-renders/re-attach all srcObjects on every per-peer event. Memoize + create new peer objects.
- **Audio continuity** (`frontend-react#9`, `ux-mobile-a11y#8`): render `<AudioPlayer>` outside the layout-switching branches so screen-share doesn't tear down everyone's audio; handle blocked autoplay with a "tap to enable audio" prompt.
- **Optimistic upvote desync** (`frontend-react#8`): server never echoes `hasUpvoted`; disable button in-flight, reconcile on ack.
- **Shareable join link** (`ux-mobile-a11y#7`): show a full join URL + "Copy link" + `navigator.share()`, not just the bare code.
- **Accessibility quick wins** (S effort): closable/announced error toasts (`#4`); `aria-pressed` + live region on control-bar toggles and fix the inverted camera label (`#5`); labelled video tiles + join/leave announcements + keyboard shortcuts (`#6`); refresh-captcha as a real `Button` (`#14`); fix disabled-MenuItem identity row (`#11`); contrast bumps (`#12`).

## 7. Reliability & observability

- **Process crash safety** (`reliability-observability#1`, high): no `unhandledRejection`/`uncaughtException` handlers; the worker-replacement `.then()` has no `.catch()` (`index.ts:157`). On Node 20 an unhandled rejection exits → Docker flaps, dropping all calls.
- **Real health/readiness** (`reliability-observability#3`, `infra-deploy#5`): `/health` always returns ok. Add `/readyz` (timeboxed `SELECT 1` + `workers.length>0`) for HAProxy/LB and `/livez` (process up) for the container restart probe; web should ping Prisma, not `/auth/session`.
- **SFU metrics** (`reliability-observability#4`): add `prom-client` + `/metrics` for active rooms/peers/producers/consumers, transport-create failures, ICE failures, per-worker `getResourceUsage()`, reminder backlog, DB latency. Today operators are blind.
- **ICE/DTLS failure detection** (`reliability-observability#2`): only `routerclose` is handled; dead peers leak transports/producers/ports. Listen for `icestatechange`/`dtlsstatechange`, reap on `failed`, broadcast cleanup.
- **Producer transportclose broadcast** (`webrtc-sfu-core#3`, corrected to medium): the producer `transportclose` handler doesn't emit `producer-closed`, leaving frozen remote tiles on ICE-failure/abrupt teardown.
- **Dead-worker recovery** (`scalability-multiinstance#2`, high): worker death orphans its Rooms; the cached dead Room is reused on rejoin with no client reconnect signal. Track worker→rooms, emit `reconnect-required`, and `.catch` the replacement spawn.
- **Graceful shutdown** (`reliability-observability#8`, `scalability-multiinstance#5`): `process.exit(0)` fires before `httpServer.close()` drains and never calls `io.close()`; SIGTERM black-holes live calls and leaves participants marked active. Sequence: fail health → broadcast shutdown → `io.close()` → close workers → flush `leftAt` in one query → `await` close → exit, all under a hard timeout.
- **Structured logging** (`reliability-observability#5`): adopt pino, JSON in prod, child loggers bound to socketId/meetingCode/requestId, safe serializer.
- **Reminder robustness** (`reliability-observability#6`, plus `scalability-multiinstance#3` corrected to low and `#4` confirmed high): mark `sent` only on real success (today total SMTP failure looks like success), add attempt cap + backoff + dead-letter, pool the transporter, and **fix `io.emit` global broadcast** of in-app reminders → target `io.to('user:'+userId)` (privacy leak + O(P×S) fanout).
- **Backups** (`infra-deploy#8`): nightly `mysqldump`/PITR off-host with retention and a restore test — currently zero backup of all user/meeting data.

## 8. Testing & tooling

First test suite (highest value/hour first) — `testing-tooling#0`:
1. **Unit (Vitest, no infra):** every Zod validator (incl. code regex `^[a-z]{3}-[a-z]{4}-[a-z]{3}$`, cuid/datetime); `socketAuthMiddleware` (missing/tampered/expired token, missing secret); `auth.authorize()` captcha+bcrypt branches; `Room` state machine with mocked Router/Peer (peer-count across main+breakout, `movePeerToBreakout`/`closeAllBreakouts` map invariants, `removePeer` sweeps breakout maps); the `shouldLobby` decision in `connectionHandler.ts:83-102`.
2. **Integration (Vitest + socket.io-client + sqlite/testcontainers):** join → lobby-waiting vs meeting-joined, admit, disconnect cleanup, ask-question/upvote.
3. **E2E (Playwright, `--use-fake-device-for-media-stream`):** two browsers join, see tiles, leave.

Tooling:
- **Fix lint** (`testing-tooling#1`, high): install/pin `eslint`+`eslint-config-next`, add `.eslintrc.json` (`next/core-web-vitals` + `@typescript-eslint/recommended`); add a standalone ESLint setup + `lint` script to media-server with `no-floating-promises`/`no-misused-promises`/`no-explicit-any`.
- **CI** (`testing-tooling#2`, high): GitHub Actions per package — `npm ci`, `prisma generate`, `tsc --noEmit`, `lint`, `test`; required for merge. Add `typecheck` scripts.
- **TS strictness plan** (`testing-tooling#8`): both tsconfigs are `strict:true`; add `noUnusedLocals`/`noUnusedParameters`/`noImplicitOverride` now, introduce `noUncheckedIndexedAccess` last (fix the handful of `workers[i]`/Map index accesses), and ratchet `no-explicit-any` warn→error to burn down the 91 `any`s.
- **Monorepo + deps** (`testing-tooling#6/#7/#5`): add `workspaces`, one root install/lockfile, align skewed dep ranges (nodemailer ^7 vs ^6.9.8, @prisma/client ^5.9 vs ^5.22), use `npm ci` in Dockerfiles, add Prettier/.editorconfig/husky, add Renovate + `npm audit` in CI.

## 9. Infra & deployment hardening (split topology: app+SFU+coturn on .70, MySQL on .23, Apache+HAProxy edge)

- **MySQL lockdown** (`infra-deploy#1`) — see §3.
- **Secrets** (`infra-deploy#0`) — see §3; give media-server only the key it needs once the secret is split (`security-authz#7/#11`).
- **External-user media path** (`infra-deploy#6`, high): `MEDIASOUP_ANNOUNCED_IP=10.127.1.70` is LAN-only and coturn `external-ip` is commented out, so off-LAN users have no direct path *and* no working relay (Apache/HAProxy can't proxy UDP). Decide: if external users are required, give coturn a routable IP, set `external-ip`, and UDP-forward 3478/5349 + relay range from the edge at the firewall; otherwise document LAN-only and remove the misleading public-proxy guidance. Gate go-live on an off-LAN Trickle-ICE test.
- **coturn hardening** (`infra-deploy#7`, `security-authz#10`): add `total-quota`/`user-quota`/`max-bps`; deny `127.0.0.0/8`, `169.254.0.0/16`, `0.0.0.0/8` (+IPv6) to close TURN SSRF; enable `no-tcp` if unused; drop `verbose` in prod; shorten the 24h credential TTL to 1-2h; **require auth on `/turn-credentials`** (currently unauthenticated open relay vector).
- **Resource/ulimit/log limits** (`infra-deploy#4`, high): host-networked containers have no CPU/mem/`nofile`/`pids` limits and no log rotation; a leak can exhaust the host. Add `ulimits.nofile`, `pids_limit`, `deploy.resources`, and `json-file` log rotation.
- **Image hygiene** (`infra-deploy#3`): media-server ships full dev `node_modules`; prune to prod-only, `npm ci`, add `.dockerignore`.
- **Migrations** (`data-model-prisma#0`, high): no `prisma/migrations` but deploy runs `migrate deploy` (no-op). Baseline with `migrate dev --name init`, `migrate resolve --applied` against the existing prod DB, and add a drift-check step.
- **CI/CD + registry + rollback** (`infra-deploy#8`): replace `docker save | ssh load` `:latest` with SHA-pinned tags (pin coturn by digest too) so rollback is possible.
- **Go-live checklist** (`infra-deploy#9`): enforce HTTPS end-to-end + HSTS/CSP at the Apache edge, set real-IP trust + Express `trust proxy` (so rate-limit keys on real client IP), gated `migrate deploy`, tuned Apache `ProxyTimeout`/WebSocket upgrade for long-lived Socket.IO.
- **CORS fail-fast** (`reliability-observability#9`): require `CORS_ORIGIN` in prod (don't default to localhost), log the resolved list, reject unknown origins.

## 10. Product gaps & polish

- **Breakout rooms are fundamentally non-functional** (`breakout-feature#0` and `#1`, both confirmed **critical**): signaling always targets the main router and the client never re-initializes media on `breakout-joined`. Also: `breakout-joined` omits `existingProducers` (`#2`), `participantIds` aren't meeting-scoped (`#4`, high security), the auto-close `setTimeout` leaks/double-fires (`#5`, high), participant assignment isn't transactional (`#9`), and `BreakoutRoom.participants` is never populated so counts show 0 (`#8`). Treat breakout as a **rebuild** (router-aware `routerForSocket` + client `reinitializeMedia`) or hide it until rebuilt. (`#3` worker-pinning was corrected to **low** — current isolated design works.)
- **Lobby flow gaps**: host joining after people are waiting sees an empty lobby and can never admit them (`maintainability-product#2`, high); `move-to-lobby` makes the user vanish from the host's list with no re-admit (`#3`, high); lobby toggle UI has no backend (`#1`); lobby arrivals broadcast to all participants, leaking who's waiting (`#4`). Seed lobby on join, emit `lobby-participant` on demote, add `toggle-lobby`, and route lobby events to a hosts-only room.
- **Unused Recording table / no recording** (`maintainability-product#9`, `data-model-prisma#10`): there is no Recording model at all (the schema comment also falsely claims nanoid codes). If recording is in scope, add the model + a PlainTransport→ffmpeg pipeline; otherwise mark it a non-goal.
- **Meeting-code generation** (`web-api-quality#0`/`data-model-prisma#10`, high): uses `Math.random()` (not the imported nanoid) and has no P2002 retry → collisions 500. Switch to nanoid + retry loop.
- **Invitations** (`web-api-quality#4`): not idempotent — add `@@unique([meetingId,email])` + upsert and update `status` on send.
- **Post-call summary** (`maintainability-product#10`): cheap win — duration/attendees/persisted Q&A+chat already in the DB.
- **HTML email injection** (`web-api-quality#2`, corrected to **medium**): escape `meetingTitle`/`inviterName` in mailer; add a text/plain part.
- **Schema polish**: add `@updatedAt` to mutable models (`data-model-prisma#6`); remove redundant `@@index([code])` (`#5`); decide `onDelete` policy for the 5 User relations (`#2`, corrected to **low** — no delete path exists yet); give ChatMessage a real `senderId` FK (`#9`).

## 11. Suggested sequencing

**Phase 1 — quick wins (days).** Mostly S effort, mostly security/correctness:
- Critical: IDOR scoping (`security-authz#0`), rotate+chmod secrets (`infra-deploy#0`), MySQL lockdown (`infra-deploy#1`).
- REST authz gaps (`security-authz#1/#2/#3`), wrap routes in `withApi` (`web-api-quality#1`), meeting-code nanoid+retry (`web-api-quality#0`).
- Always-answer rate-limited acks (`webrtc-sfu-core#2`), getUserMedia/kick/disconnect toasts (`ux-mobile-a11y#0/#3`).
- Fix lint (`testing-tooling#1`) + CI skeleton (`testing-tooling#2`) + the validator/auth unit tests (`testing-tooling#0` tier 1).
- coturn deny-peer/quotas + auth `/turn-credentials` (`infra-deploy#7`, `security-authz#10`), `unhandledRejection` handlers (`reliability-observability#1`), real `/readyz` (`infra-deploy#5`), accessibility S-wins (`ux-mobile-a11y#4/#5/#14`).

**Phase 2 — correctness + scale (weeks).**
- TURN iceServers wired to both transports (`webrtc-sfu-core#1`) + ICE reconnection/banner (`webrtc-sfu-core#7`, `ux-mobile-a11y#2`).
- Right-size workers + de-contend ports / WebRtcServer mode (`webrtc-sfu-core#0`).
- Frontend correctness: single socket source (`frontend-react#2`), host-changed/participant-left fixes (`frontend-react#0/#1`), error boundary + memoization (`frontend-react#3/#4`), audio-mixer extraction (`frontend-react#9`).
- DB: versioned migrations (`data-model-prisma#0`), upvote-counter + pagination (`data-model-prisma#4/#7`), Prisma pool config (`data-model-prisma#11`), nightly backups (`infra-deploy#8`).
- Observability: metrics, ICE-failure reaping, dead-worker recovery, graceful shutdown, structured logging, reminder claim-before-send + targeted in-app emit (`reliability-observability#2/#4/#5/#6`, `scalability-multiinstance#2/#4/#5`).
- Shared types package + NextAuth augmentation + typed socket events (`testing-tooling#3/#4`, `maintainability-product#5`); integration tests (`testing-tooling#0` tier 2).
- Infra hardening: resource/ulimit limits, image prune, HTTPS/HSTS/real-IP checklist (`infra-deploy#3/#4/#9`).

**Phase 3 — product + hardening (later).**
- Pre-join device-preview + picker (`ux-mobile-a11y#1`, `maintainability-product#8`); shareable links (`ux-mobile-a11y#7`); post-call summary (`maintainability-product#10`).
- Lobby flow fixes (`maintainability-product#1/#2/#3/#4`), invitation idempotency (`web-api-quality#4`).
- Breakout rebuild (`breakout-feature#0/#1/#2/#4/#5/#8`) — or formally drop it.
- Recording feature if in scope (`maintainability-product#9`); dead-code cull (`maintainability-product#0`); E2E tests; `noUncheckedIndexedAccess` ratchet.
- Multi-instance (Redis adapter + media pinning) **only if traffic demands it** (`scalability-multiinstance#0`) — currently overkill.

## 12. Non-issues (verification REJECTED or materially disproven)

- **`reliability-observability#0` — "256 workers share 101 ports → guaranteed exhaustion": REJECTED.** Host has 8 CPUs (not 512), so `NUM_WORKERS=4`. Also: `rtcMin/MaxPort` are per-worker, the Dockerfile *does* `EXPOSE 40000-40100/udp`, and coturn's relay range (49152-65535) is deliberately separate. Real residual = a narrow hardcoded range worth parameterizing (low/medium) — covered in §4.
- **The "512-core / 256-worker / massive over-provisioning" framing** in `scalability-multiinstance#1` and `infra-deploy#2` is fabricated for the same reason; the standing port-range concern is corrected to **medium**.
- **`breakout-feature#3` — "breakout on different worker breaks return-to-main": partial/low.** Isolated-breakout design is intentional and works; `closeAllBreakouts` correctly tears down and re-creates on the main router. "Returning to main impossible" is false. Low-severity design nit only.
- **`scalability-multiinstance#3` — reminder cron duplicate emails: corrected to low.** The N-instance scenario is unreachable (single pinned container); only a single-instance >60s re-entrancy corner case remains.
- **Severities corrected downward (still real, just not their original tier):** `webrtc-sfu-core#1` critical→high; `#3` high→medium; `#4` high→medium; `scalability-multiinstance#0` critical→high; `#1` critical→medium; `data-model-prisma#2` high→low; `#3` high→medium; `web-api-quality#2` high→medium. `infra-deploy#0`'s "secrets committed to git / scrub history" claim is **disproven** (only a placeholder is tracked) — the on-disk plaintext exposure remains critical, but no git-history rewrite is needed.