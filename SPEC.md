# Seat Booking Service – Build Spec

## 0. How to use this document

This file is the spec. `.cursor/rules/project.mdc` tells the agent: always read and follow `SPEC.md`. Do not add features, services, or dependencies that are not in `SPEC.md`.

Build one phase at a time (Section 16). Start a fresh chat per phase, paste the phase prompt, let the agent finish, run the checks, review the diff, then commit.

You must understand every file the agent writes. After each phase, read the code and be able to explain it.

## 1. Goal

A small, correct, deployable ticket-booking backend that demonstrates:

- explicit state machines (seat and booking lifecycles)
- no double-booking under heavy concurrency (atomic DB operations, not in-memory locks)
- a second service (worker) communicating through a Redis-backed queue
- idempotent APIs
- containerization, CI/CD, and cloud deployment

The backend is the point. The frontend is a minimal seat grid.

## 2. Scope

### In scope

- Create events with N seats; list events and seats
- Hold a seat for a limited time (default 5 minutes)
- Confirm a booking (mock payment processed asynchronously by the worker)
- Automatic hold expiry by the worker
- Cancel a confirmed booking
- Idempotent confirm endpoint
- Load test proving no double-booking
- Docker Compose, GitHub Actions, deployment to a GCP or AWS free-tier VM

### Out of scope (do not build)

- Real payments, emails, SMS
- User registration, passwords, OAuth (use a simple `x-user-id` header)
- Admin dashboards, microservices beyond the two listed, Kubernetes
- Anything not in this document

## 3. Tech stack (fixed)

- Language: TypeScript everywhere, Node.js 20
- API: NestJS (REST) with class-validator for DTO validation
- Database: MongoDB 7 via Mongoose (standalone instance; no multi-document transactions, use single-document atomic operations)
- Queue: BullMQ on Redis 7
- Worker: plain Node + BullMQ Worker (no NestJS needed; keep it small)
- Frontend: React + Vite + TypeScript, plain CSS
- Tests: Jest (unit and e2e with Supertest), k6 or autocannon for load testing
- Infra: Docker, Docker Compose, GitHub Actions
- Package manager: npm workspaces

## 4. Repository layout

```
SPEC.md
README.md
docker-compose.yml
.github/workflows/ci.yml
.github/workflows/deploy.yml
packages/shared/     # state machine tables, enums, shared types
services/api/        # NestJS booking API
services/worker/     # BullMQ worker
web/                 # React seat grid
loadtest/            # k6 or autocannon scripts + results
docs/                # diagrams (state machines, architecture)
```

`packages/shared` is imported by both api and worker so both use the exact same transition rules.

## 5. Data models (MongoDB)

### events

`_id`, `name`, `startsAt`, `totalSeats`, `createdAt`

### seats

`_id`, `eventId`, `seatNo` (e.g. `A1`), `status` (`AVAILABLE` | `HELD` | `BOOKED`), `heldBy` (userId or null), `holdExpiresAt` (Date or null), `bookingId` (or null), `version` (number, increment on every transition)

- Unique index: `(eventId, seatNo)`
- Index: `(status, holdExpiresAt)` for the expiry sweep

### bookings

`_id`, `eventId`, `seatId`, `userId`, `status` (`HELD` | `PAYMENT_PENDING` | `CONFIRMED` | `FAILED` | `EXPIRED` | `CANCELLED`), `idempotencyKey` (nullable), `holdExpiresAt`, `createdAt`, `updatedAt`, `history[]` (array of `{from, to, at, reason}` for audit)

- Unique sparse index on `idempotencyKey`
- Index: `(userId, status)`

## 6. State machines

Define both as plain transition tables in `packages/shared`, plus a `canTransition(from, to)` function and an `assertTransition(from, to)` that throws on illegal moves. Every status change in the codebase must go through these helpers.

### Seat

| From | To | Trigger |
| --- | --- | --- |
| AVAILABLE | HELD | user holds seat |
| HELD | AVAILABLE | hold expired, payment failed, or user released |
| HELD | BOOKED | payment succeeded |
| BOOKED | AVAILABLE | booking cancelled |

### Booking

| From | To | Trigger |
| --- | --- | --- |
| HELD | PAYMENT_PENDING | user calls confirm |
| HELD | EXPIRED | hold timer ran out |
| HELD | CANCELLED | user released the hold |
| PAYMENT_PENDING | CONFIRMED | worker: payment succeeded |
| PAYMENT_PENDING | FAILED | worker: payment failed |
| CONFIRMED | CANCELLED | user cancels |

Terminal states: `EXPIRED`, `FAILED`, `CANCELLED`. Anything not in the table is illegal and must return HTTP 409.

Create Mermaid diagrams of both machines in `docs/state-machines.md` and embed them in the README.

## 7. API (booking service)

All write endpoints require header `x-user-id` (any non-empty string). Base path `/api`.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/events` | Create event `{name, startsAt, rows, seatsPerRow}`; bulk-creates seats |
| GET | `/events` | List events with available-seat counts |
| GET | `/events/:id/seats` | List seats with status |
| POST | `/seats/:seatId/hold` | Hold a seat. Creates a booking in `HELD`. 409 if not available |
| POST | `/bookings/:id/confirm` | Header `Idempotency-Key` required. Moves booking to `PAYMENT_PENDING` and enqueues a payment job |
| POST | `/bookings/:id/release` | Release an active hold |
| POST | `/bookings/:id/cancel` | Cancel a `CONFIRMED` booking |
| GET | `/bookings/:id` | Get booking status (client polls this after confirm) |
| GET | `/health` | Liveness check (Mongo and Redis connectivity) |

Error format: `{ statusCode, error, message }`. Use proper codes: 400 validation, 404 not found, 409 illegal state or seat taken, 403 booking belongs to another user.

## 8. Worker service

BullMQ queues on Redis:

### 1. payments queue

Job payload: `{ bookingId }`

- Mock payment: wait 1–2 seconds; succeed with probability `PAYMENT_SUCCESS_RATE` (default 0.9)
- On success: seat `HELD` to `BOOKED`, booking `PAYMENT_PENDING` to `CONFIRMED`
- On failure: seat `HELD` to `AVAILABLE`, booking `PAYMENT_PENDING` to `FAILED`
- The job must be idempotent: if the booking is already `CONFIRMED` or `FAILED`, do nothing and complete
- Retries: 3 attempts with exponential backoff for infrastructure errors only (not for a payment decline)

### 2. hold-expiry queue

- When a hold is created, the API enqueues a delayed job `{ bookingId }` with delay = hold duration
- On run: if the booking is still `HELD`, move booking to `EXPIRED` and seat to `AVAILABLE`; otherwise do nothing

### 3. Safety-net sweep (repeatable job every 60 s)

- Find seats with `status = HELD` and `holdExpiresAt < now` and release them (covers lost delayed jobs, Redis restarts)

Graceful shutdown: on `SIGTERM`, close the workers and let in-flight jobs finish.

## 9. Concurrency and correctness rules

1. Hold = one atomic `findOneAndUpdate`:
   - filter: `{ _id: seatId, $or: [ { status: 'AVAILABLE' }, { status: 'HELD', holdExpiresAt: { $lt: now } } ] }`
   - update: set `status: 'HELD'`, `heldBy`, `holdExpiresAt`, `$inc: { version: 1 }`
   - If it returns null, respond 409 (seat taken). No read-then-write. No in-process locks, because the API may run as multiple instances.
2. Confirm must verify booking ownership, that the booking is `HELD` and the hold has not expired, then update booking status with a filter on the current status (compare-and-set): `findOneAndUpdate({ _id, status: 'HELD', userId, holdExpiresAt: { $gt: now } }, ...)`.
3. Every transition is a compare-and-set with the expected current status in the filter. If it matches nothing, treat it as a lost race and return 409 or no-op, never overwrite.
4. Idempotency: `POST /bookings/:id/confirm` with the same `Idempotency-Key` returns the same booking and enqueues at most one payment job. Use the sparse unique index on `idempotencyKey`; on a duplicate-key error, load and return the existing booking. Also set the BullMQ `jobId` to `payment:<bookingId>` so duplicate enqueues are ignored.
5. Time source: use server time (`new Date()`) in the API and worker, never client time.
6. Never trust the queue for correctness. The queue is an optimization; the sweep and compare-and-set updates keep the data right even if jobs are lost or duplicated.
7. Seat and booking updates are two documents without a transaction. Always update the seat first (it is the contended resource), then the booking. If the booking update fails, log it and let the sweep repair it. Document this trade-off in the README.

## 10. Configuration (env vars)

```
MONGO_URL=mongodb://mongo:27017/seatbooking
REDIS_URL=redis://redis:6379
HOLD_DURATION_SECONDS=300
PAYMENT_SUCCESS_RATE=0.9
PORT=3000
```

Provide `.env.example`. Never commit real secrets.

## 11. Docker Compose

Services: `mongo`, `redis`, `api`, `worker`, `web` (nginx serving the Vite build, proxying `/api` to `api`). Multi-stage Dockerfiles for `api`, `worker`, and `web`; run as a non-root user. Add healthchecks and `depends_on` with `condition: service_healthy`. `docker compose up --build` must bring the whole system up with no manual steps.

## 12. Testing

Unit: state machine helpers (every legal and illegal transition).

E2E (Jest + Supertest, real Mongo and Redis through Docker or testcontainers):

- hold, confirm, payment success flow
- two users hold the same seat: exactly one succeeds
- confirm twice with the same idempotency key: one booking, one payment job
- hold expires and the seat becomes available again
- cancel a confirmed booking frees the seat
- illegal transitions return 409

CI must run unit and e2e tests.

## 13. Load test

In `loadtest/`:

- Scenario A: 200 concurrent users try to hold the same seat. Expect exactly 1 success and 199 conflicts. Verify in Mongo that exactly one seat holder exists.
- Scenario B: 500 concurrent users each pick a random seat among 100 seats for 30 seconds. Expect zero seats with two active bookings; report requests per second, p95 latency, and conflict rate.
- Optional: generate demand with Poisson arrivals and report the conflict rate versus arrival rate.

Save the output in `loadtest/results.md` and paste the key numbers into the README.

## 14. CI/CD and deployment

- `ci.yml` (on every push and PR): install, lint, build, unit tests, e2e tests.
- `deploy.yml` (on push to `main`): build Docker images, push to GitHub Container Registry, SSH to the VM and run `docker compose pull && docker compose up -d`. Secrets (`SSH_HOST`, `SSH_KEY`, etc.) live in GitHub Actions secrets.

Hosting: one free-tier VM (GCP e2-micro or AWS t2/t3.micro) running Docker Compose. Open only ports 80 and 22. Do not expose Mongo or Redis publicly.

## 15. README requirements

The README is part of the deliverable. It must contain:

1. One-paragraph description and a live demo link
2. Architecture diagram (api, worker, mongo, redis, web)
3. Both state-machine diagrams
4. Quick start (`docker compose up --build`)
5. API table
6. Design decisions: why atomic updates over locks, why compare-and-set, why a sweep job exists, why idempotency keys, the seat-then-booking ordering trade-off
7. Failure scenarios: what happens if the worker crashes mid-payment, if Redis restarts, if the API retries a confirm
8. Load-test results
9. What I would change at 100x scale (sharding seats by event, Mongo replica set and transactions, outbox pattern, rate limiting, observability)

## 16. Phased build plan

### Phase 1 – Skeleton and shared state machines

Read `SPEC.md`. Create the npm-workspaces monorepo exactly as in Section 4. Implement `packages/shared` with the seat and booking transition tables, `canTransition` and `assertTransition`, plus Jest unit tests covering every legal and illegal transition. Do not create any other code yet.

### Phase 2 – API core

Read `SPEC.md` Sections 5, 7, 9. In `services/api`, implement the NestJS app with Mongoose schemas, indexes, and the endpoints POST/GET events, GET seats, POST seat hold, GET booking, and `/health`. The hold must be a single atomic `findOneAndUpdate` as described in Section 9. Use DTO validation and the error format from Section 7. Add e2e tests for the hold race (two users, one seat).

### Phase 3 – Confirm, release, cancel and idempotency

Read `SPEC.md` Sections 6, 7, 9. Add confirm, release and cancel endpoints using compare-and-set transitions via the shared helpers. Implement idempotency with the `Idempotency-Key` header and the sparse unique index. Enqueue the payment job on confirm with `jobId = payment:<bookingId>`. Enqueue the delayed hold-expiry job on hold. Add e2e tests for idempotent confirm and illegal transitions.

### Phase 4 – Worker

Read `SPEC.md` Section 8. Implement `services/worker` with the payments worker, hold-expiry worker and the 60-second sweep. All handlers must be idempotent and use compare-and-set updates through the shared helpers. Add graceful shutdown. Add an e2e test: hold a seat, wait for expiry (use a short `HOLD_DURATION_SECONDS`), verify the seat is `AVAILABLE` again.

### Phase 5 – Docker Compose

Read `SPEC.md` Section 11. Write multi-stage Dockerfiles for api, worker and web, `docker-compose.yml` with healthchecks, and `.env.example`. Verify that `docker compose up --build` runs the full flow end to end.

### Phase 6 – Minimal frontend

Read `SPEC.md` Sections 3 and 7. Build a minimal React + Vite page in `web/`: pick a user id, choose an event, show the seat grid colored by status, hold a seat, show a countdown, confirm (generate a UUID idempotency key), and poll the booking until it is `CONFIRMED` or `FAILED`. No extra libraries beyond React. Keep the CSS simple.

### Phase 7 – Load tests

Read `SPEC.md` Section 13. Write the k6 (or autocannon) scripts for Scenarios A and B and a small verification script that queries Mongo to confirm no seat has more than one active booking. Document how to run them.

### Phase 8 – CI/CD and deployment

Read `SPEC.md` Section 14. Write `ci.yml` and `deploy.yml`. Explain which secrets need to be configured. Do not hard-code any secrets.

### Phase 9 – README and diagrams

Read `SPEC.md` Section 15. Write the README with all required sections, using the real load-test numbers. Create the Mermaid diagrams in `docs/state-machines.md`.

## 17. Rules for the agent

1. Follow `SPEC.md`. If something is ambiguous, ask instead of guessing.
2. Do not add libraries, services, endpoints, or features that are not in the spec.
3. All status changes go through the shared state-machine helpers.
4. All concurrent-sensitive updates use compare-and-set in a single Mongo operation.
5. No `any` in TypeScript unless justified in a comment. Enable strict mode.
6. Small, readable functions. Short comments only where the reason is non-obvious.
7. Write tests with each feature, not afterwards.
8. After each phase, list what was built, how to run it, and anything left undone.

## 18. Definition of done

- `docker compose up --build` starts everything; the full hold, confirm, paid flow works from the UI
- Two users cannot book the same seat (e2e test and load test prove it)
- Confirm is idempotent (test proves one booking and one payment job)
- Expired holds are released automatically
- CI is green; deploys to the cloud VM on push to `main`
- Live demo URL works
- README includes diagrams, design decisions, failure scenarios, and load-test numbers
- You can explain every file and every design decision without looking at the code

## 19. Interview prep checklist

Be ready to answer:

- Why can two users never hold the same seat? (single atomic update, compare-and-set)
- What if the worker crashes after payment but before updating the seat? (idempotent job plus retries plus sweep)
- What if Redis loses all jobs? (sweep job repairs expired holds)
- What if the client double-clicks confirm? (idempotency key and unique index)
- Why no Mongo transactions here, and when would you add them? (replica set, outbox pattern at scale)
- What would break first at 100x traffic, and how would you fix it?
