<p align="center">
  <h1 align="center">🛡️ TiltGuard</h1>
  <p align="center">
    <strong>Real-Time Mental State & Tilt Management Engine for Competitive Gamers</strong>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/.NET-10.0-512BD4?style=flat-square&logo=dotnet&logoColor=white" alt=".NET 10" />
  <img src="https://img.shields.io/badge/C%23-13-239120?style=flat-square&logo=csharp&logoColor=white" alt="C# 13" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL 16" />
  <img src="https://img.shields.io/badge/SignalR-WebSocket-512BD4?style=flat-square&logo=dotnet&logoColor=white" alt="SignalR" />
  <img src="https://img.shields.io/badge/Expo-57-000020?style=flat-square&logo=expo&logoColor=white" alt="Expo 57" />
  <img src="https://img.shields.io/badge/React_Native-0.86-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React Native" />
  <img src="https://img.shields.io/badge/TypeScript-6.0-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/GitHub_Actions-CI%2FCD-2088FF?style=flat-square&logo=githubactions&logoColor=white" alt="GitHub Actions" />
</p>

---

TiltGuard is a **server-authoritative tilt detection and cooldown coaching platform** designed to interrupt tilt spirals in competitive gaming before they cascade into prolonged loss streaks. The system combines a **recency-weighted multi-factor tilt algorithm** with a **non-bypassable server-enforced lock-out state machine**, delivered through a dual-plane architecture (REST + SignalR WebSocket push) that ensures the mobile client can never dismiss, circumvent, or desync from the authoritative game state.

The backend is built as a single deployable .NET 10 Minimal API with zero-allocation-path optimizations on the tilt evaluation hot path, backed by PostgreSQL 16 with native enum mapping, covering indexes for sub-millisecond time-series queries, and `xmin`-based optimistic concurrency for idempotent webhook processing. The mobile client is an Expo React Native application using Zustand for deterministic state hydration, `@microsoft/signalr` for real-time event consumption, and RevenueCat for cross-platform subscription management.

---

## System Architecture & Topology

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│                           MOBILE CLIENT (Expo React Native)                        │
│                                                                                    │
│  Expo Router v4 (file-based routing)  ·  Zustand 5 (state management)              │
│  @microsoft/signalr 10 (WebSocket)    ·  NativeWind 4 (Tailwind CSS)               │
│  expo-secure-store (token storage)    ·  react-native-purchases (RevenueCat SDK)   │
│                                                                                    │
│  Route Groups:  (auth)/ login | register                                           │
│                 (app)/  dashboard | history | settings | session/active | cooldown │
│                         paywall                                                    │
└────────────────┬──────────────────────────────────────┬────────────────────────────┘
                 │ HTTPS (REST, JSON)                   │ WSS (SignalR, MessagePack)
                 │ Authorization: Bearer <JWT>          │ access_token query param
                 ▼                                      ▼
┌────────────────────────────────┐   ┌───────────────────────────────────────────────┐
│  .NET 10 Minimal API Gateway   │   │  SignalR Hub Layer                            │
│                                │   │  Endpoint: /hubs/tilt                         │
│  Route Groups:                 │   │  TiltHub : Hub<ITiltClient>                   │
│  /api/v1/auth/*  (anonymous)   │   │                                               │
│  /api/v1/*       (JWT Bearer)  │   │  Client→Server:                               │
│                                │   │    JoinSession · LeaveSession                 │
│  Middleware Pipeline:          │   │    SendLiveTelemetry                          │
│  ExceptionHandler              │   │    ConfirmCooldownCompliance                  │
│  → HttpsRedirection            │   │    RequestTiltSnapshot                        │
│  → RateLimiter (fixed-window)  │   │                                               │
│  → Authentication (JWT HS256)  │   │  Server→Client (strong-typed):                │
│  → Authorization               │   │    ReceiveTiltAlert                           │
│  → Route Handlers              │   │    CooldownLockEngaged / Released             │
│                                │   │    ReceiveSessionState                        │
│  Health: /health (anonymous)   │   │    ReceiveTelemetryAck                        │
└──────────┬───────────┬─────────┘   └───────┬──────────────────────┬────────────────┘
           │           │                     │                      │
           │           ▼                     ▼                      │
           │   ┌──────────────────────────────────────────────┐     │
           │   │  Application Services (DI, Scoped)           │◄────┘
           │   │                                              │
           │   │  AuthService ·············· JWT issuance, BCrypt verify,
           │   │                             SHA-256 refresh rotation,
           │   │                             reuse-detection nuclear logout
           │   │  SessionService ··········· Session state machine,
           │   │                             match logging, tilt evaluation
           │   │                             trigger, 423 lock enforcement
           │   │  TiltCalculationEngine ···· 4-factor weighted algorithm,
           │   │                             hard override rules, cold-start
           │   │                             cap (pure math, no I/O)
           │   │  EntitlementService ······· Webhook idempotency ledger,
           │   │                             xmin optimistic concurrency,
           │   │                             premium status state map
           │   │  CooldownWatchdog ········· BackgroundService,
           │   │                             PeriodicTimer (30s sweep),
           │   │                             auto-release with grace period
           │   └──────────────────────┬──────────────────────────────┘
           │                          │ EF Core 10 (Npgsql, pooled DbContextFactory)
           ▼                          ▼
┌──────────────────────────────────────────────────┐   ┌────────────────────────────┐
│  PostgreSQL 16                                   │   │  RevenueCat Cloud          │
│                                                  │   │                            │
│  Tables:                                         │◄──┤  Webhooks →                │
│    users · gaming_sessions · match_logs          │   │  POST /api/v1/webhooks/    │
│    cooldown_protocols · processed_webhook_events │   │       revenuecat           │
│                                                  │   │                            │
│  Native Enums: premium_status · game_type        │   │  Events: INITIAL_PURCHASE  │
│    match_outcome · strategy_type                 │   │  RENEWAL · EXPIRATION      │
│                                                  │   │  BILLING_ISSUE · etc.      │
│  Indexes: DESC covering w/ INCLUDE (index-only)  │   │                            │
│  Concurrency: xmin system column (row versioning)│   │  Stripe under the hood     │
│  Constraints: partial unique, check constraints  │   └────────────────────────────┘
└──────────────────────────────────────────────────┘
```

---

## Key Engineering Highlights & Design Decisions

### 🧮 Moving-Window Tilt Algorithm

The tilt calculation engine evaluates the player's last **5 matches** through a **4-factor weighted composite** — not a simple loss counter. Each factor captures a distinct dimension of tilt onset:

| Factor | Weight | What It Measures |
|---|---|---|
| **Progressive Loss Streak** | 0.35 | Consecutive losses from the most recent match backward, mapped through a non-linear curve (`[0.00, 0.10, 0.35, 0.70, 0.90, 1.00]`) so a single loss barely registers while 3+ losses escalate aggressively |
| **Tilt Trajectory** | 0.30 | Recency-weighted sum of positive `(post_tilt − pre_tilt)` deltas across the window — detects active emotional escalation between matches |
| **Absolute Tilt Level** | 0.20 | Recency-weighted post-match tilt levels normalized against the 1–5 scale — captures sustained high-tilt states even without sharp spikes |
| **Performance Decay** | 0.15 | Least-squares regression slope over the match window's performance scores — a falling skill output under rising emotional distress is the canonical tilt spiral signature |

**Recency weights** (`[0.35, 0.25, 0.20, 0.12, 0.08]`) ensure the newest match dominates the evaluation. When fewer than 5 matches exist, weights are renormalized over the available window, and the maximum risk flag is **capped at `Elevated`** to prevent locking out a brand-new user off two data points.

**Hard override rules** fire unconditionally *after* the composite calculation:
- **Override A:** 3+ consecutive losses *and* 2 of the last 3 matches have `post_tilt ≥ 4`
- **Override B:** Most recent match has `post_tilt == 5` *and* a delta `≥ 2` (single-match rage spike)

Either override floors the coefficient at `0.85`, guaranteeing a `LockRequired` state.

### 🔐 Defensive Auth & Single-Flight Refresh

Token security follows a **rotate-on-use** pattern with **SHA-256 reuse detection**:

- **Refresh tokens** are 64-byte cryptorandom values. Only the SHA-256 hash is stored in `users.refresh_token` — the raw token is returned to the client exactly once and never persisted server-side.
- **Token rotation** is atomic: a successful refresh issues a new token pair and overwrites the stored hash in a single `UPDATE`, invalidating the previous token instantly.
- **Reuse detection (nuclear invalidation):** If a refresh token's hash doesn't match the stored hash but the user is identified via the expired access token's `sub` claim, the server **nulls both `refresh_token` and `refresh_token_expiry`** (global logout). This defends against stolen-token replay — if an attacker uses a leaked refresh token after the legitimate client has already rotated, both parties are logged out.
- **Constant-time comparison** via `CryptographicOperations.FixedTimeEquals` for all token comparisons — no timing oracle.
- The mobile client queues concurrent 401 responses behind a single in-flight refresh to prevent token rotation races.

### 🚫 Authoritative Lock-Out State Machine

The cooldown enforcement is **server-authoritative and non-bypassable**:

1. When `TiltCalculationEngine` returns `RiskFlag.LockRequired`, the server atomically inserts a `cooldown_protocols` row, transitions the session to `CooldownLocked`, and pushes `CooldownLockEngaged` via SignalR.
2. **HTTP 423 enforcement:** Any `POST /api/v1/matches/log` or `POST /api/v1/sessions/end` while locked returns `423 COOLDOWN_LOCK_ACTIVE`. The lock is not a UI suggestion — the API refuses writes.
3. **Non-dismissible mobile overlay:** The client routes to `/session/cooldown` via `router.replace()` (no back-stack entry) and blocks Android back navigation with `usePreventRemove`. No dismiss affordance is rendered until `CooldownLockReleased` arrives.
4. **Anti-tap-through:** `ConfirmCooldownCompliance` is accepted only when `now − started_at ≥ 0.8 × duration_seconds` — a server-side wall-clock check that prevents instant dismissal.
5. **Watchdog auto-release:** The `CooldownWatchdog` `BackgroundService` sweeps every 30 seconds via `PeriodicTimer`, releasing unresolved locks at `started_at + duration + 120s` grace period with `ComplianceVerified = false`. This nullable-timestamp design ensures **loop-free releasing** — the watchdog never re-releases an already-released cooldown.

### 💰 Idempotent Payments & Concurrency

RevenueCat webhook processing handles two distinct failure modes:

- **Webhook redelivery:** An `INSERT ... ON CONFLICT DO NOTHING` idempotency ledger (`processed_webhook_events`) ensures duplicate event IDs are silently absorbed — the handler returns `200 OK` to stop retries.
- **Concurrent writers:** The `User.Version` property maps to PostgreSQL's `xmin` system column via `.IsRowVersion()`. EF Core appends `WHERE xmin = @original` to every `UPDATE`, converting a lost-update race into a `DbUpdateConcurrencyException`. The handler retries up to 3 times with progressive backoff, reloading the entity fresh each attempt.
- **Constant-time webhook verification:** The `Authorization` header is compared against the configured secret using `CryptographicOperations.FixedTimeEquals` — no early-exit byte comparison, no timing oracle. A missing or empty configuration **fails closed** with `503`, not open with a vacuous match.

### ⚡ Index-Only Time-Series Queries

The tilt engine's hot path — "last 5 matches for user X, newest first" — executes as an **index-only scan** with zero heap fetches:

```sql
CREATE INDEX ix_match_logs_user_logged_desc
    ON match_logs (user_id, logged_at DESC)
    INCLUDE (match_outcome, performance_score, pre_match_tilt_level, post_match_tilt_level);
```

The `INCLUDE` clause covers every column the tilt engine reads, so PostgreSQL satisfies the query entirely from the index B-tree without touching the table heap. Combined with `LIMIT 5` and the `DESC` ordering built into the index, the scan terminates after exactly 5 index tuples. Additional partial indexes (`ix_cooldowns_pending WHERE compliance_verified = false`) keep background sweeps O(pending) rather than O(history).

---

## Tech Stack Breakdown

### Backend

| Component | Technology | Version | Package / Notes |
|---|---|---|---|
| Runtime | .NET | 10.0 | `net10.0` TFM |
| Language | C# | 13 | Nullable enabled, implicit usings |
| Web Framework | ASP.NET Core Minimal APIs | 10.0.9 | No controllers, no MVC |
| ORM | Entity Framework Core | 10.0.2 | `Npgsql.EntityFrameworkCore.PostgreSQL` |
| Database | PostgreSQL | 16 | Native enums, `xmin` concurrency, covering indexes |
| Naming Convention | snake_case | — | `EFCore.NamingConventions` 10.0.1 |
| Real-Time | ASP.NET Core SignalR | 10.0.9 | MessagePack + JSON fallback |
| Authentication | JWT Bearer (HS256) | 10.0.9 | `Microsoft.AspNetCore.Authentication.JwtBearer` |
| Password Hashing | BCrypt | 4.2.0 | `BCrypt.Net-Next`, work factor 12 |
| Rate Limiting | Built-in ASP.NET Core | — | Fixed-window: 10 req/min (auth), 120 req/min (default) |
| API Documentation | OpenAPI | 10.0.9 + 2.7.5 | `Microsoft.AspNetCore.OpenApi` + `Microsoft.OpenApi` |
| Container | Docker | Multi-stage | `mcr.microsoft.com/dotnet/sdk:10.0` → `aspnet:10.0`, non-root |
| Orchestration | Docker Compose | v2 | Dev + production configurations |

### Mobile

| Component | Technology | Version | Package / Notes |
|---|---|---|---|
| Framework | Expo | 57.0.15 | Managed workflow with dev client |
| UI Runtime | React Native | 0.86.2 | New Architecture |
| Language | TypeScript | 6.0.3 | Strict mode |
| Navigation | Expo Router | 57.0.15 | File-based routing with route groups |
| State Management | Zustand | 5.0.15 | Lightweight stores with `expo-secure-store` hydration |
| Styling | NativeWind | 4.2.6 | Tailwind CSS 3.4 compiled to React Native styles |
| Real-Time | `@microsoft/signalr` | 10.0.0 | Typed hub events, auto-reconnect with backoff |
| Secure Storage | `expo-secure-store` | 57.0.1 | Keychain (iOS) / EncryptedSharedPrefs (Android) |
| Payments | `react-native-purchases` | 10.4.2 | RevenueCat SDK (requires dev build, no Expo Go) |
| Animations | `react-native-reanimated` | 4.5.1 | UI thread animations |
| Build Service | EAS Build | ≥ 12.0.0 CLI | `development` · `preview` · `production` profiles |

---

## Local Development & Getting Started

### Prerequisites

| Tool | Required Version | Install |
|---|---|---|
| .NET SDK | 10.0+ | [dotnet.microsoft.com/download](https://dotnet.microsoft.com/download) |
| Node.js | 22 LTS | [nodejs.org](https://nodejs.org) |
| Docker Desktop | Latest | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop) |
| EF Core CLI | Latest | `dotnet tool restore` (configured in `dotnet-tools.json`) |

### 1. Clone the Repository

```bash
git clone https://github.com/bykeny/TiltGuard.git
cd TiltGuard
```

### 2. Start PostgreSQL via Docker Compose

```bash
cd backend
docker compose up -d
```

This starts a PostgreSQL 16 container on `localhost:5433` (host port 5433 avoids clashing with a native Postgres on 5432) with the credentials configured in `docker-compose.yml` (`postgres`/`postgres`, database `tiltguard_dev`).

### 3. Apply Database Migrations

```bash
# From the backend/ directory
dotnet tool restore
dotnet ef database update --project TiltGuard.API
```

This applies all EF Core migrations, creating the schema with native PostgreSQL enums, covering indexes, partial unique constraints, and check constraints.

### 4. Launch the .NET API

```bash
cd TiltGuard.API
dotnet run
```

The API starts on `http://localhost:5191` (HTTP) by default. Health check: `GET http://localhost:5191/health`. The SignalR hub is available at `ws://localhost:5191/hubs/tilt`.

### 5. Start the Expo Mobile Development Server

```bash
cd mobile
npm install
npx expo start
```

> **Note:** `react-native-purchases` (RevenueCat SDK) contains native code and **does not run in Expo Go**. You need a development build via `eas build --profile development` for full functionality. Auth, sessions, match logging, and tilt evaluation work without it.

To point the mobile app at your local API (e.g., from an Android emulator):

```bash
EXPO_PUBLIC_API_URL=http://10.0.2.2:5191 npx expo start
```

For a physical device on the same network:

```bash
EXPO_PUBLIC_API_URL=http://192.168.x.x:5191 npx expo start
```

---

## Environment Configuration & Variables

### Backend — `appsettings.Development.json`

```jsonc
{
  "ConnectionStrings": {
    // Matches the Docker Compose dev service credentials
    "TiltGuard": "Host=localhost;Port=5433;Database=tiltguard_dev;Username=postgres;Password=postgres"
  },

  "Jwt": {
    // Base64-encoded, ≥32 bytes for HS256. Generate: openssl rand -base64 32
    "Secret": "<base64-encoded-32-byte-key>",
    "Issuer": "https://api.tiltguard.app",
    "Audience": "tiltguard-mobile",
    "AccessTokenLifetimeMinutes": 15,  // Short-lived access tokens
    "RefreshTokenLifetimeDays": 7      // Dev-friendly; production uses 45
  },

  "RevenueCat": {
    // Must match the Authorization header configured in RevenueCat dashboard
    "WebhookAuthHeader": "dev-revenuecat-webhook-secret",
    "EntitlementId": "tiltguard_pro"
  }
}
```

### Backend — Production (`.env.prod`)

For production, environment variables override `appsettings.json`. ASP.NET Core reads `__` as a section separator:

| Variable | Description | Example |
|---|---|---|
| `ConnectionStrings__TiltGuard` | PostgreSQL connection string (host = compose service name) | `Host=db;Port=5432;Database=tiltguard;Username=tiltguard;Password=<strong>` |
| `Jwt__Secret` | HS256 signing key, Base64, ≥32 bytes | `openssl rand -base64 32` |
| `Jwt__Issuer` | Token issuer claim | `https://api.tiltguard.app` |
| `Jwt__Audience` | Token audience claim | `tiltguard-mobile` |
| `Jwt__AccessTokenLifetimeMinutes` | Access token TTL | `15` |
| `Jwt__RefreshTokenLifetimeDays` | Refresh token TTL (spec: 45 days) | `45` |
| `RevenueCat__WebhookAuthHeader` | Webhook secret (fails closed with 503 if unset) | `Bearer rc_whsec_...` |
| `RevenueCat__EntitlementId` | RevenueCat entitlement identifier | `tiltguard_pro` |

Database credentials are isolated in `.env.prod.db` to prevent leaking API secrets into the PostgreSQL container:

| Variable | Description |
|---|---|
| `POSTGRES_USER` | Database user |
| `POSTGRES_PASSWORD` | Database password (must match connection string) |
| `POSTGRES_DB` | Database name |

### Mobile — `app.config.ts` & Environment Variables

All mobile configuration flows through Expo's `extra` config, read at runtime via `expo-constants`:

| Variable | Description | Default |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | Backend API base URL | (none — must be set) |
| `EXPO_PUBLIC_RC_IOS_KEY` | RevenueCat public iOS SDK key | `''` (mock mode) |
| `EXPO_PUBLIC_RC_ANDROID_KEY` | RevenueCat public Android SDK key | `''` (mock mode) |

EAS build profiles (`eas.json`) set `EXPO_PUBLIC_API_URL` per environment:

| Profile | Distribution | API URL | Notes |
|---|---|---|---|
| `development` | Internal | `http://10.0.2.2:5191` | Dev client, APK + iOS simulator |
| `preview` | Internal | `https://api.tiltguard.app` | Internal testing APK |
| `production` | Store | `https://api.tiltguard.app` | AAB + iOS archive, auto-increment |

---

## CI/CD & Production Deployment

### GitHub Actions Pipeline

The CI/CD pipeline (`.github/workflows/ci-cd.yml`) runs on every push to `main` and every pull request, with **concurrency grouping** that cancels superseded runs to prevent deployment races.

```
┌──────────────────┐     ┌──────────────────┐
│  backend         │     │  mobile          │
│  ────────────    │     │  ────────────    │
│  • Restore       │     │  • npm ci        │
│  • Build Release │     │  • tsc --noEmit  │
│    -warnaserror  │     │  • expo lint     │
│  • Test (if any) │     │                  │
└────────┬─────────┘     └────────┬─────────┘
         │                        │
         ▼                        │
┌──────────────────┐              │
│  docker          │              │
│  ────────────    │              │
│  • Buildx setup  │              │
│  • Image build   │              │
│  • Smoke test:   │              │
│    /health check │              │
│    non-root UID  │              │
│    port 8080     │              │
└────────┬─────────┘              │
         │                        │
         ▼                        ▼
┌──────────────────────────────────────────┐
│  deploy (main only)                      │
│  ──────────────────                      │
│  Environment: production                 │
│  Guard: skips if DEPLOY_HOST unset       │
│  • SSH with pinned host key (no TOFU)    │
│  • git fetch --all && reset --hard       │
│  • docker compose -f prod.yml up --build │
│  • docker image prune                    │
│  • Post-deploy /health verification      │
│  • Deploy key scrubbed on completion     │
└──────────────────────────────────────────┘
```

#### Pipeline Jobs

| Job | Trigger | What It Validates |
|---|---|---|
| **Backend** | Push & PR | `dotnet build -c Release -warnaserror` — warnings are failures. Runs `dotnet test` if test projects exist. |
| **Mobile** | Push & PR | TypeScript type-checking (`tsc --noEmit`) and Expo linting (`expo lint`). |
| **Docker** | After Backend passes | Builds the multi-stage Dockerfile, then smoke-tests: boots the container with dummy env vars, asserts `/health` responds, confirms the process runs as **non-root** (UID ≠ 0). |
| **Deploy** | `main` push only | SSH deployment gated by the `production` GitHub Environment. Uses a **pinned known-hosts key** (not `StrictHostKeyChecking=no`) to prevent MITM. Post-deploy health check verifies the new version is serving. Deploy key is scrubbed in an `always()` step. |

#### Required Secrets for Deployment

| Secret | Purpose |
|---|---|
| `DEPLOY_HOST` | Production server hostname |
| `DEPLOY_USER` | SSH user |
| `DEPLOY_SSH_KEY` | Private key for deployment |
| `DEPLOY_KNOWN_HOSTS` | Pinned server host key |
| `DEPLOY_PATH` | Absolute path to the repository on the server |

### EAS Build Profiles (Mobile)

| Profile | Build Type | Distribution | Channel |
|---|---|---|---|
| `development` | APK (Android) / Simulator (iOS) | Internal | `development` |
| `preview` | APK | Internal | `preview` |
| `production` | AAB (Android) / Archive (iOS) | Store | `production` |

Production builds use `autoIncrement: true` for automatic version bumping on each build submission.

---

## Project Structure

```
TiltGuard/
├── .github/workflows/
│   └── ci-cd.yml                      # GitHub Actions: build, lint, Docker smoke, deploy
├── backend/
│   ├── docker-compose.yml             # Dev: PostgreSQL 16 on localhost:5433
│   ├── docker-compose.prod.yml        # Prod: API + DB, health checks, non-root
│   ├── .env.prod.example              # Production env template (API secrets)
│   ├── .env.prod.db.example           # Production env template (DB credentials)
│   └── TiltGuard.API/
│       ├── Program.cs                 # Composition root: DI, middleware, route map
│       ├── Domain/                    # Entities & enums (User, GamingSession, MatchLog, etc.)
│       ├── Infrastructure/            # TiltGuardDbContext — EF Core config, native enums
│       ├── Services/                  # Business logic (Auth, Session, TiltEngine, Entitlements)
│       ├── Hubs/                      # TiltHub, ITiltClient, Payloads, SubClaimUserIdProvider
│       ├── BackgroundServices/        # CooldownWatchdog (PeriodicTimer-based sweep)
│       ├── Contracts/                 # Request/response DTOs (Auth, Session, Webhook, Entitlement)
│       ├── Migrations/                # EF Core migrations (PostgreSQL DDL)
│       └── Dockerfile                 # Multi-stage: SDK build → aspnet runtime, non-root
├── mobile/
│   ├── app/                           # Expo Router file-based routes
│   │   ├── (auth)/                    # Login, Register (unauthenticated)
│   │   └── (app)/                     # Main app (authenticated)
│   │       ├── (tabs)/                # Dashboard, History, Settings
│   │       ├── session/               # Active session, Cooldown overlay
│   │       └── paywall.tsx            # RevenueCat subscription gate
│   ├── src/
│   │   ├── api/                       # HTTP client, JWT refresh queue, secure store
│   │   ├── realtime/                  # SignalR hub connection, typed payloads
│   │   ├── stores/                    # Zustand: auth, session, entitlement state
│   │   └── purchases/                # RevenueCat SDK integration
│   ├── components/                    # Shared UI components (NativeWind-styled)
│   ├── app.config.ts                  # Dynamic Expo config (API URL, RC keys)
│   └── eas.json                       # EAS Build profiles (dev, preview, prod)
└── docs/
    └── TILTGUARD_SPEC.md              # Full system specification (47KB)
```

---

## License

See [LICENSE](mobile/LICENSE) for details.
