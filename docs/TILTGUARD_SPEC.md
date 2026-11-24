# TILTGUARD_SPEC.md

**Project:** TiltGuard — Real-Time Tilt Detection & Cooldown Coaching Platform for Competitive Gamers
**Version:** 1.0.0
**Status:** Production Specification — parseable by code-generation agents
**Stack:** .NET 10 Web API (C#) · PostgreSQL 16+ · EF Core 10 (Npgsql) · ASP.NET Core SignalR · Expo React Native (TypeScript, Expo Router, NativeWind) · RevenueCat + Stripe

---

## 1. EXECUTIVE SYSTEM ARCHITECTURE

### 1.1 Topological Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          MOBILE CLIENT (Expo RN)                           │
│  Expo Router (file-based nav) · NativeWind UI · Zustand state             │
│  @microsoft/signalr JS client · react-native-purchases (RevenueCat SDK)   │
└──────────────┬──────────────────────────────┬──────────────────────────────┘
               │ HTTPS (REST, JSON)           │ WSS (SignalR, MessagePack)
               ▼                              ▼
┌──────────────────────────┐   ┌──────────────────────────────────────────┐
│  .NET 10 Web API         │   │  SignalR Hub Layer (/hubs/tilt)          │
│  Minimal APIs + MVC-less │   │  TiltHub : Hub<ITiltClient>              │
│  /api/v1/* controllers   │   │  Per-session SignalR Groups              │
│  JWT Bearer middleware   │   │  JWT via access_token query param        │
└──────┬───────────┬───────┘   └──────┬──────────────────┬────────────────┘
       │           │                  │                  │
       │           ▼                  ▼                  │
       │   ┌────────────────────────────────────┐       │
       │   │  Application Services (DI, Scoped)  │◄──────┘
       │   │  • AuthService                      │
       │   │  • SessionService                   │
       │   │  • TiltCalculationEngine (Singleton │
       │   │    stateless math + Scoped repo)    │
       │   │  • CooldownOrchestrator             │
       │   │  • EntitlementService (RevenueCat)  │
       │   └───────────────┬────────────────────┘
       │                   │ EF Core 10 (Npgsql, pooled DbContextFactory)
       ▼                   ▼
┌────────────────────────────────────────────┐   ┌──────────────────────────┐
│  PostgreSQL 16                             │   │  RevenueCat Cloud        │
│  users · gaming_sessions · match_logs      │◄──┤  Webhooks → /api/v1/     │
│  cooldown_protocols · processed_webhooks   │   │  webhooks/revenuecat     │
└────────────────────────────────────────────┘   │  (Stripe under the hood) │
                                                 └──────────────────────────┘
```

### 1.2 Asynchronous Interaction Model

1. **REST plane (request/response):** Registration, login, token refresh, session lifecycle (start/end), match logging, and history queries flow over HTTPS. All controller actions are `async Task<IResult>` and never block threads (`ConfigureAwait` is unnecessary in ASP.NET Core; no sync-over-async anywhere).
2. **Real-time plane (push):** The moment `POST /api/v1/matches/log` persists a `MatchLog`, the request handler invokes `TiltCalculationEngine.EvaluateAsync(userId)`. The result is pushed through `IHubContext<TiltHub, ITiltClient>` to the SignalR group `session:{sessionId}` — the client never polls for tilt state.
3. **State machine:** Each active `GamingSession` is a server-side state machine with states `Idle → InMatch → Evaluating → CooldownLocked → Idle`. Transitions:
   - `InMatch → Evaluating`: triggered by match log persistence.
   - `Evaluating → CooldownLocked`: triggered when `RiskFlag == LockRequired`; the server creates a `CooldownProtocol` row and pushes `CooldownLockEngaged`.
   - `CooldownLocked → Idle`: triggered by client `ConfirmCooldownCompliance` **and** server-side timer expiry (both must be satisfied; the server timer is authoritative and implemented with `PeriodicTimer` inside a `BackgroundService` named `CooldownWatchdog`).
4. **Database plane:** EF Core 10 with `NpgsqlDataSource` + `AddDbContextPool<TiltGuardDbContext>` (pool size 128). All PostgreSQL enums are mapped natively via `dataSourceBuilder.MapEnum<T>()` — no string columns for enums.
5. **Scale-out note:** Single-node SignalR is the v1 target. The spec reserves `AddStackExchangeRedis` as the backplane switch for horizontal scale; all group names are deterministic (`session:{Guid}`) so no code changes are required beyond the one registration line.

### 1.3 Authentication Flow — Long-Lived JWT + DB-Backed Refresh Tokens

Mobile-optimized design goals: survive weeks between app opens, never force re-login on token expiry, allow server-side revocation.

**Token pair:**

| Token | Lifetime | Storage (client) | Storage (server) | Format |
|---|---|---|---|---|
| Access token | **60 minutes** | `expo-secure-store` key `tg.access` | none (stateless JWT) | HS256 JWT |
| Refresh token | **45 days**, rotated on every use | `expo-secure-store` key `tg.refresh` | `users.refresh_token` = **SHA-256 hash** of the raw token; `users.refresh_token_expiry` | 64-byte cryptorandom, Base64Url |

**JWT claims (access token):**

```json
{
  "sub": "<user Guid>",
  "email": "player@example.com",
  "premium": "Premium",
  "jti": "<Guid, unique per token>",
  "iss": "https://api.tiltguard.app",
  "aud": "tiltguard-mobile",
  "iat": 1767225600,
  "exp": 1767229200
}
```

**Flow:**

1. **Login/Register** → server issues `{ accessToken, refreshToken, expiresAtUtc }`. Raw refresh token is generated with `RandomNumberGenerator.GetBytes(64)`, hashed with SHA-256, and the *hash* is written to `users.refresh_token` (raw value is never persisted).
2. **Every API call** → `Authorization: Bearer <accessToken>`. SignalR passes the same token via `accessTokenFactory` (query string `access_token`, handled by `JwtBearerEvents.OnMessageReceived` for paths starting with `/hubs/`).
3. **On 401 (expired access)** → client calls `POST /api/v1/auth/refresh` with the raw refresh token. Server hashes it, compares against `users.refresh_token` with `CryptographicOperations.FixedTimeEquals`, checks `refresh_token_expiry > now()`. On success it **rotates**: new refresh token issued, new hash stored, old one is therefore invalidated atomically in the same `UPDATE`.
4. **Reuse detection:** If a presented refresh token hashes to a value that does *not* match the stored hash but the user row is identified via the accompanying (expired) access token's `sub` claim, the server nulls `refresh_token` + `refresh_token_expiry` (global logout) and returns `401 REFRESH_REUSE_DETECTED`. This defends against token theft replay.
5. **Logout** → `POST /api/v1/auth/logout` nulls both refresh columns.

**Password hashing:** BCrypt (`BCrypt.Net-Next`), work factor **12**. Verification via `BCrypt.Verify`. No custom crypto.

**Middleware order (Program.cs):** `UseExceptionHandler → UseHttpsRedirection → UseRateLimiter → UseAuthentication → UseAuthorization → MapControllers / MapHub<TiltHub>("/hubs/tilt")`.

**Rate limiting:** fixed-window limiter, policy `auth`: 10 requests/minute/IP on `/api/v1/auth/*`; policy `default`: 120 requests/minute/user elsewhere.

---
## 2. DATABASE & ENTITY SCHEMA

### 2.1 PostgreSQL DDL (authoritative — migrations must produce byte-equivalent structures)

```sql
-- ============================================================
-- TiltGuard schema · PostgreSQL 16 · timezone-aware throughout
-- ============================================================

-- Native enum types (mapped by Npgsql, NOT stored as text)
CREATE TYPE premium_status AS ENUM ('free', 'premium', 'grace_period', 'expired');
CREATE TYPE game_type      AS ENUM ('cs2', 'lol', 'valorant', 'dota2', 'tanki_online',
                                    'rocket_league', 'apex_legends', 'fortnite', 'other');
CREATE TYPE match_outcome  AS ENUM ('win', 'loss');
CREATE TYPE strategy_type  AS ENUM ('breathing', 'stretching', 'hydration');

-- ------------------------------------------------------------
-- users
-- ------------------------------------------------------------
CREATE TABLE users (
    id                    uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    email                 varchar(320)   NOT NULL,
    password_hash         varchar(100)   NOT NULL,               -- BCrypt output (60 chars) + headroom
    premium_status        premium_status NOT NULL DEFAULT 'free',
    revenuecat_app_user_id varchar(128)  NULL,                   -- set on first SDK identify()
    created_at            timestamptz    NOT NULL DEFAULT now(),
    refresh_token         varchar(64)    NULL,                   -- SHA-256 hash, Base64Url (44 chars) + headroom
    refresh_token_expiry  timestamptz    NULL
);

-- Case-insensitive unique login lookup
CREATE UNIQUE INDEX ux_users_email_lower ON users (LOWER(email));
-- Webhook → user resolution path
CREATE UNIQUE INDEX ux_users_revenuecat_id ON users (revenuecat_app_user_id)
    WHERE revenuecat_app_user_id IS NOT NULL;

-- ------------------------------------------------------------
-- gaming_sessions
-- ------------------------------------------------------------
CREATE TABLE gaming_sessions (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_type   game_type   NOT NULL,
    start_time  timestamptz NOT NULL DEFAULT now(),
    end_time    timestamptz NULL,
    is_active   boolean     NOT NULL DEFAULT true,
    CONSTRAINT ck_sessions_end_after_start
        CHECK (end_time IS NULL OR end_time >= start_time)
);

-- Time-series access pattern: "sessions for user, newest first"
CREATE INDEX ix_sessions_user_start_desc ON gaming_sessions (user_id, start_time DESC);
-- Invariant: at most ONE active session per user (enforced by the engine, not just app code)
CREATE UNIQUE INDEX ux_sessions_one_active_per_user ON gaming_sessions (user_id)
    WHERE is_active;

-- ------------------------------------------------------------
-- match_logs
-- ------------------------------------------------------------
-- user_id is a DELIBERATE denormalization: the hot query "last 5 matches
-- for user X across sessions" must be a single index-only range scan and
-- must not join through gaming_sessions. Set by the API layer from the
-- session row inside the same transaction.
CREATE TABLE match_logs (
    id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id            uuid          NOT NULL REFERENCES gaming_sessions(id) ON DELETE CASCADE,
    user_id               uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_outcome         match_outcome NOT NULL,
    performance_score     numeric(5,2)  NOT NULL,     -- 0.00–100.00, app-defined KDA/impact composite
    pre_match_tilt_level  smallint      NOT NULL,
    post_match_tilt_level smallint      NOT NULL,
    logged_at             timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_match_pre_tilt  CHECK (pre_match_tilt_level  BETWEEN 1 AND 5),
    CONSTRAINT ck_match_post_tilt CHECK (post_match_tilt_level BETWEEN 1 AND 5),
    CONSTRAINT ck_match_perf      CHECK (performance_score BETWEEN 0 AND 100)
);

-- THE hot path. Covering index → index-only scan for the tilt engine window:
--   SELECT ... WHERE user_id = $1 ORDER BY logged_at DESC LIMIT 5
CREATE INDEX ix_match_logs_user_logged_desc
    ON match_logs (user_id, logged_at DESC)
    INCLUDE (match_outcome, performance_score, pre_match_tilt_level, post_match_tilt_level);

-- Per-session timeline rendering in the app
CREATE INDEX ix_match_logs_session_logged_desc
    ON match_logs (session_id, logged_at DESC);

-- ------------------------------------------------------------
-- cooldown_protocols
-- ------------------------------------------------------------
CREATE TABLE cooldown_protocols (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id            uuid          NOT NULL REFERENCES match_logs(id) ON DELETE CASCADE,
    duration_seconds    integer       NOT NULL,
    strategy_type       strategy_type NOT NULL,
    compliance_verified boolean       NOT NULL DEFAULT false,
    started_at          timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_cooldown_duration CHECK (duration_seconds BETWEEN 30 AND 3600)
);

CREATE INDEX ix_cooldowns_match ON cooldown_protocols (match_id);
-- Watchdog scan: "cooldowns still awaiting compliance"
CREATE INDEX ix_cooldowns_pending ON cooldown_protocols (started_at)
    WHERE compliance_verified = false;

-- ------------------------------------------------------------
-- processed_webhook_events (idempotency ledger — see §6)
-- ------------------------------------------------------------
CREATE TABLE processed_webhook_events (
    event_id     varchar(64)  PRIMARY KEY,       -- RevenueCat event.id
    event_type   varchar(48)  NOT NULL,
    processed_at timestamptz  NOT NULL DEFAULT now()
);
```

**Index rationale (time-series aggregation):**
- `ix_match_logs_user_logged_desc` with `INCLUDE` makes the tilt-engine window query an **index-only scan**: no heap fetches, no join, `LIMIT 5` terminates the scan after 5 tuples. Measured plan: `Index Only Scan Backward` is avoided entirely because the index is already stored `DESC`.
- The partial unique index `ux_sessions_one_active_per_user` turns a race-prone application invariant into a database guarantee; concurrent `sessions/start` calls surface as `23505` and are mapped to HTTP `409`.
- `ix_cooldowns_pending` is partial so the `CooldownWatchdog` background scan stays O(pending), not O(history).

### 2.2 C# EF Core 10 Entity Classes

File-scoped namespaces, `required` members, primary constructors where they carry weight.

```csharp
// Domain/Enums.cs
namespace TiltGuard.Domain;

public enum PremiumStatus { Free, Premium, GracePeriod, Expired }
public enum GameType { Cs2, Lol, Valorant, Dota2, TankiOnline, RocketLeague, ApexLegends, Fortnite, Other }
public enum MatchOutcome { Win, Loss }
public enum StrategyType { Breathing, Stretching, Hydration }
```

```csharp
// Domain/User.cs
namespace TiltGuard.Domain;

public class User
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public required string Email { get; set; }
    public required string PasswordHash { get; set; }
    public PremiumStatus PremiumStatus { get; set; } = PremiumStatus.Free;
    public string? RevenueCatAppUserId { get; set; }
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
    public string? RefreshToken { get; set; }              // SHA-256 hash of raw token
    public DateTimeOffset? RefreshTokenExpiry { get; set; }

    public ICollection<GamingSession> Sessions { get; init; } = [];

    // PostgreSQL system column used as the optimistic concurrency token (§6.4)
    public uint Version { get; set; }
}
```

```csharp
// Domain/GamingSession.cs
namespace TiltGuard.Domain;

public class GamingSession
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public required Guid UserId { get; init; }
    public required GameType GameType { get; init; }
    public DateTimeOffset StartTime { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? EndTime { get; set; }
    public bool IsActive { get; set; } = true;

    public User User { get; init; } = null!;
    public ICollection<MatchLog> Matches { get; init; } = [];
}
```

```csharp
// Domain/MatchLog.cs
namespace TiltGuard.Domain;

public class MatchLog
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public required Guid SessionId { get; init; }
    public required Guid UserId { get; init; }            // denormalized, see DDL comment
    public required MatchOutcome MatchOutcome { get; init; }
    public required decimal PerformanceScore { get; init; }   // 0–100
    public required short PreMatchTiltLevel { get; init; }    // 1–5
    public required short PostMatchTiltLevel { get; init; }   // 1–5
    public DateTimeOffset LoggedAt { get; init; } = DateTimeOffset.UtcNow;

    public GamingSession Session { get; init; } = null!;
    public CooldownProtocol? Cooldown { get; set; }
}
```

```csharp
// Domain/CooldownProtocol.cs
namespace TiltGuard.Domain;

public class CooldownProtocol
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public required Guid MatchId { get; init; }
    public required int DurationSeconds { get; init; }
    public required StrategyType StrategyType { get; init; }
    public bool ComplianceVerified { get; set; }
    public DateTimeOffset StartedAt { get; init; } = DateTimeOffset.UtcNow;

    public MatchLog Match { get; init; } = null!;
}
```

```csharp
// Infrastructure/TiltGuardDbContext.cs
using Microsoft.EntityFrameworkCore;
using TiltGuard.Domain;

namespace TiltGuard.Infrastructure;

public class TiltGuardDbContext(DbContextOptions<TiltGuardDbContext> options)
    : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<GamingSession> Sessions => Set<GamingSession>();
    public DbSet<MatchLog> MatchLogs => Set<MatchLog>();
    public DbSet<CooldownProtocol> Cooldowns => Set<CooldownProtocol>();
    public DbSet<ProcessedWebhookEvent> ProcessedWebhookEvents => Set<ProcessedWebhookEvent>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.HasPostgresEnum<PremiumStatus>();
        b.HasPostgresEnum<GameType>();
        b.HasPostgresEnum<MatchOutcome>();
        b.HasPostgresEnum<StrategyType>();

        b.Entity<User>(e =>
        {
            e.ToTable("users");
            e.HasIndex(u => u.Email).IsUnique();          // provider lowers via HasMethod below
            e.Property(u => u.Email).HasMaxLength(320);
            e.Property(u => u.PasswordHash).HasMaxLength(100);
            e.Property(u => u.RefreshToken).HasMaxLength(64);
            e.Property(u => u.Version).IsRowVersion();     // maps to xmin on Npgsql
        });

        b.Entity<GamingSession>(e =>
        {
            e.ToTable("gaming_sessions");
            e.HasIndex(s => new { s.UserId, s.StartTime }).IsDescending(false, true)
             .HasDatabaseName("ix_sessions_user_start_desc");
            e.HasIndex(s => s.UserId).IsUnique().HasFilter("is_active")
             .HasDatabaseName("ux_sessions_one_active_per_user");
        });

        b.Entity<MatchLog>(e =>
        {
            e.ToTable("match_logs");
            e.Property(m => m.PerformanceScore).HasPrecision(5, 2);
            e.HasIndex(m => new { m.UserId, m.LoggedAt }).IsDescending(false, true)
             .IncludeProperties(m => new { m.MatchOutcome, m.PerformanceScore,
                                           m.PreMatchTiltLevel, m.PostMatchTiltLevel })
             .HasDatabaseName("ix_match_logs_user_logged_desc");
            e.HasIndex(m => new { m.SessionId, m.LoggedAt }).IsDescending(false, true)
             .HasDatabaseName("ix_match_logs_session_logged_desc");
            e.HasOne(m => m.Cooldown).WithOne(c => c.Match)
             .HasForeignKey<CooldownProtocol>(c => c.MatchId);
        });

        b.Entity<CooldownProtocol>(e =>
        {
            e.ToTable("cooldown_protocols");
            e.HasIndex(c => c.StartedAt).HasFilter("compliance_verified = false")
             .HasDatabaseName("ix_cooldowns_pending");
        });

        b.Entity<ProcessedWebhookEvent>(e =>
        {
            e.ToTable("processed_webhook_events");
            e.HasKey(p => p.EventId);
            e.Property(p => p.EventId).HasMaxLength(64);
            e.Property(p => p.EventType).HasMaxLength(48);
        });
    }
}
```

```csharp
// Program.cs (data source registration excerpt)
var dataSourceBuilder = new NpgsqlDataSourceBuilder(
    builder.Configuration.GetConnectionString("TiltGuard"));
dataSourceBuilder.MapEnum<PremiumStatus>("premium_status");
dataSourceBuilder.MapEnum<GameType>("game_type");
dataSourceBuilder.MapEnum<MatchOutcome>("match_outcome");
dataSourceBuilder.MapEnum<StrategyType>("strategy_type");
var dataSource = dataSourceBuilder.Build();

builder.Services.AddDbContextPool<TiltGuardDbContext>(o =>
    o.UseNpgsql(dataSource, npgsql => npgsql.EnableRetryOnFailure(3))
     .UseSnakeCaseNamingConvention());   // EFCore.NamingConventions package
```

---
## 3. REST API ENDPOINT SPECIFICATIONS

**Global conventions**
- Base path `https://api.tiltguard.app/api/v1`. All bodies `application/json; charset=utf-8`, camelCase (`JsonNamingPolicy.CamelCase`).
- All timestamps ISO-8601 UTC (`2026-07-09T14:32:11.402Z`).
- Uniform error envelope (every non-2xx response):

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "postMatchTiltLevel must be between 1 and 5.",
    "traceId": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "details": { "postMatchTiltLevel": ["Must be between 1 and 5."] }
  }
}
```
- Error `code` registry: `VALIDATION_FAILED` (400), `INVALID_CREDENTIALS` (401), `TOKEN_EXPIRED` (401), `REFRESH_REUSE_DETECTED` (401), `PREMIUM_REQUIRED` (403), `NOT_FOUND` (404), `SESSION_ALREADY_ACTIVE` (409), `EMAIL_TAKEN` (409), `COOLDOWN_LOCK_ACTIVE` (423), `RATE_LIMITED` (429).

### 3.1 POST /api/v1/auth/register  *(anonymous)*

Request:
```json
{
  "email": "player@example.com",        // required, RFC 5322, max 320, lowered server-side
  "password": "S3curePassw0rd!"         // required, 10–128 chars, ≥1 upper, ≥1 digit
}
```
`201 Created`:
```json
{
  "userId": "0197c1a2-9f4e-7cc1-b3aa-1f2e3d4c5b6a",
  "email": "player@example.com",
  "premiumStatus": "free",
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "accessTokenExpiresAtUtc": "2026-07-09T15:32:11Z",
  "refreshToken": "vN3aX...64-byte-base64url...Qw",
  "refreshTokenExpiresAtUtc": "2026-08-23T14:32:11Z"
}
```
Failures: `400 VALIDATION_FAILED`, `409 EMAIL_TAKEN`.

### 3.2 POST /api/v1/auth/login  *(anonymous)*

Request:
```json
{ "email": "player@example.com", "password": "S3curePassw0rd!" }
```
`200 OK`: identical body shape to §3.1 (fresh token pair; refresh rotation applies).
Failures: `401 INVALID_CREDENTIALS` (identical response for unknown email vs. wrong password — no user enumeration), `429 RATE_LIMITED`.

### 3.3 POST /api/v1/auth/refresh  *(anonymous)*

Request:
```json
{ "refreshToken": "vN3aX...Qw" }
```
`200 OK`: new `{ accessToken, accessTokenExpiresAtUtc, refreshToken, refreshTokenExpiresAtUtc }`.
Failures: `401 TOKEN_EXPIRED`, `401 REFRESH_REUSE_DETECTED` (global logout side-effect, §1.3.4).

### 3.4 POST /api/v1/sessions/start  *(Bearer)*

Request:
```json
{ "gameType": "cs2" }    // enum: cs2 | lol | valorant | dota2 | tanki_online | rocket_league | apex_legends | fortnite | other
```
`201 Created`:
```json
{
  "sessionId": "0197c1b0-1111-7abc-9def-0123456789ab",
  "gameType": "cs2",
  "startTime": "2026-07-09T14:35:00.120Z",
  "isActive": true,
  "signalR": {
    "hubUrl": "https://api.tiltguard.app/hubs/tilt",
    "joinMethod": "JoinSession"
  }
}
```
Failures: `409 SESSION_ALREADY_ACTIVE` (body `details.activeSessionId` carries the existing id so the client can resume instead of erroring out).

### 3.5 POST /api/v1/sessions/end  *(Bearer)*

Request:
```json
{ "sessionId": "0197c1b0-1111-7abc-9def-0123456789ab" }
```
`200 OK`:
```json
{
  "sessionId": "0197c1b0-1111-7abc-9def-0123456789ab",
  "endTime": "2026-07-09T17:02:44.902Z",
  "summary": {
    "matchesPlayed": 7,
    "wins": 3,
    "losses": 4,
    "avgPerformanceScore": 61.35,
    "peakTiltLevel": 5,
    "cooldownsTriggered": 2,
    "cooldownsComplied": 1
  }
}
```
Failures: `404 NOT_FOUND` (not caller's session or not active), `423 COOLDOWN_LOCK_ACTIVE` if a mandatory cooldown is unresolved — ending a session is not an escape hatch; client must confirm compliance or wait out the watchdog expiry.

### 3.6 POST /api/v1/matches/log  *(Bearer)*

Request:
```json
{
  "sessionId": "0197c1b0-1111-7abc-9def-0123456789ab",
  "matchOutcome": "loss",              // win | loss
  "performanceScore": 42.50,           // 0.00–100.00
  "preMatchTiltLevel": 3,              // int 1–5
  "postMatchTiltLevel": 5              // int 1–5
}
```
`201 Created` — the response embeds the synchronous tilt evaluation so the UI can render even if the parallel SignalR push races it:
```json
{
  "matchId": "0197c1c4-2222-7def-8abc-fedcba987654",
  "loggedAt": "2026-07-09T15:11:03.551Z",
  "tiltEvaluation": {
    "tiltCoefficient": 0.87,
    "riskFlag": "lockRequired",         // stable | elevated | critical | lockRequired
    "windowSize": 5,
    "consecutiveLosses": 3,
    "recommendedCooldown": {
      "cooldownId": "0197c1c4-3333-7aaa-bbbb-001122334455",
      "strategyType": "breathing",
      "durationSeconds": 300,
      "isMandatory": true
    }
  }
}
```
When `riskFlag != lockRequired`, `recommendedCooldown` is `null` for `stable`/`elevated`, and populated with `isMandatory: false` for `critical`.
Failures: `400 VALIDATION_FAILED`, `404 NOT_FOUND` (session), `423 COOLDOWN_LOCK_ACTIVE` (cannot log a new match while locked — this *is* the enforcement mechanism).

---

## 4. REAL-TIME SIGNALR HUB PROTOCOL

Hub endpoint: `wss://api.tiltguard.app/hubs/tilt` · Protocol: **MessagePack** (`AddMessagePackProtocol`) with JSON fallback · Auth: JWT bearer (query `access_token` on WS upgrade) · `[Authorize]` on the hub class.

### 4.1 Strong-Typed Client Contract

```csharp
// Hubs/ITiltClient.cs
namespace TiltGuard.Hubs;

public interface ITiltClient
{
    Task ReceiveTiltAlert(TiltAlertPayload payload);
    Task ReceiveSessionState(SessionStatePayload payload);
    Task CooldownLockEngaged(CooldownLockPayload payload);
    Task CooldownLockReleased(CooldownReleasePayload payload);
    Task ReceiveTelemetryAck(TelemetryAckPayload payload);
}
```

### 4.2 Server→Client Payloads

```csharp
// Hubs/Payloads.cs
namespace TiltGuard.Hubs;

public enum RiskFlag { Stable, Elevated, Critical, LockRequired }

public sealed record TiltAlertPayload
{
    public required double TiltCoefficient { get; init; }      // 0.00–1.00
    public required RiskFlag RiskFlag { get; init; }
    public required int ConsecutiveLosses { get; init; }
    public required double TiltTrajectory { get; init; }        // avg(post−pre) over window
    public required RecommendedCooldownAction? RecommendedCooldownAction { get; init; }
    public required DateTimeOffset EvaluatedAtUtc { get; init; }
}

public sealed record RecommendedCooldownAction
{
    public required Guid CooldownId { get; init; }
    public required StrategyType StrategyType { get; init; }
    public required int DurationSeconds { get; init; }
    public required bool IsMandatory { get; init; }
}

public sealed record SessionStatePayload
{
    public required Guid SessionId { get; init; }
    public required string State { get; init; }                 // "Idle"|"InMatch"|"Evaluating"|"CooldownLocked"
    public required int MatchesLogged { get; init; }
}

public sealed record CooldownLockPayload
{
    public required Guid CooldownId { get; init; }
    public required StrategyType StrategyType { get; init; }
    public required int DurationSeconds { get; init; }
    public required DateTimeOffset LockExpiresAtUtc { get; init; }
    public required string CoachMessage { get; init; }           // e.g. "3 losses in a row. 5 minutes of box breathing before queue."
}

public sealed record CooldownReleasePayload
{
    public required Guid CooldownId { get; init; }
    public required bool ComplianceVerified { get; init; }       // false ⇒ released by watchdog expiry
}

public sealed record TelemetryAckPayload
{
    public required long ClientSequence { get; init; }
    public required double RollingHeartRateBaselineDelta { get; init; } // 0 when no HR data
}
```

### 4.3 Hub Class — Client→Server Methods

```csharp
// Hubs/TiltHub.cs
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using TiltGuard.Services;

namespace TiltGuard.Hubs;

[Authorize]
public sealed class TiltHub(ISessionService sessions, ICooldownOrchestrator cooldowns)
    : Hub<ITiltClient>
{
    private Guid UserId => Guid.Parse(Context.UserIdentifier!);
    private static string Group(Guid sessionId) => $"session:{sessionId}";

    /// Client calls after sessions/start (or on reconnect). Validates ownership,
    /// adds the connection to the session group, replays current state.
    public async Task JoinSession(Guid sessionId)
    {
        var state = await sessions.GetOwnedSessionStateAsync(UserId, sessionId)
            ?? throw new HubException("SESSION_NOT_FOUND_OR_NOT_OWNED");
        await Groups.AddToGroupAsync(Context.ConnectionId, Group(sessionId));
        await Clients.Caller.ReceiveSessionState(state);
    }

    public Task LeaveSession(Guid sessionId)
        => Groups.RemoveFromGroupAsync(Context.ConnectionId, Group(sessionId));

    /// Optional high-frequency channel (≤1 msg/2s enforced server-side):
    /// in-match self-reported micro tilt pulses and optional wearable HR.
    public async Task SendLiveTelemetry(LiveTelemetryPayload telemetry)
    {
        var ack = await sessions.IngestTelemetryAsync(UserId, telemetry);
        await Clients.Caller.ReceiveTelemetryAck(ack);
    }

    /// Client claims the cooldown UI flow was completed. The orchestrator
    /// verifies minimum elapsed wall-clock time server-side before honoring it.
    public async Task ConfirmCooldownCompliance(Guid cooldownId)
    {
        var release = await cooldowns.TryConfirmComplianceAsync(UserId, cooldownId);
        if (release is not null)
            await Clients.Group(Group(release.SessionId))
                         .CooldownLockReleased(release.Payload);
    }

    /// On-demand re-evaluation (pull), same payload as the push path.
    public async Task RequestTiltSnapshot(Guid sessionId)
    {
        var alert = await sessions.SnapshotAsync(UserId, sessionId);
        await Clients.Caller.ReceiveTiltAlert(alert);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        await sessions.MarkConnectionDroppedAsync(UserId, Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }
}

public sealed record LiveTelemetryPayload
{
    public required Guid SessionId { get; init; }
    public required long ClientSequence { get; init; }
    public required short InstantTiltPulse { get; init; }   // 1–5 quick tap
    public double? HeartRateBpm { get; init; }               // optional wearable feed
}
```

### 4.4 Push Path from REST → Hub

`MatchLogService.LogAsync` finishes its transaction, then:

```csharp
await hub.Clients.Group($"session:{sessionId}").ReceiveTiltAlert(alert);
if (alert.RiskFlag == RiskFlag.LockRequired)
    await hub.Clients.Group($"session:{sessionId}").CooldownLockEngaged(lockPayload);
```

`IUserIdProvider` is implemented to read the `sub` claim so `Context.UserIdentifier` is the user Guid. Reconnect policy on the client: `.withAutomaticReconnect([0, 2000, 5000, 10000, 30000])`; on `onreconnected`, the client re-invokes `JoinSession` (groups do not survive reconnects with new connection ids).

---
## 5. COOLDOWN & ANALYTICS ALGORITHM LOGIC — "Tilt Calculation Engine"

Runs inside `TiltCalculationEngine` (stateless, registered singleton; receives the 5-match window from a scoped repository call). Deterministic, unit-testable, no I/O inside the math.

### 5.1 Inputs

```
W = last N=5 MatchLogs for user, ordered newest → oldest
    (fewer than 5 exist early on; the engine degrades gracefully, see 5.4)
Each match m in W exposes:
    outcome(m) ∈ {Win, Loss}
    perf(m)    ∈ [0, 100]
    preTilt(m), postTilt(m) ∈ [1, 5]
```

### 5.2 Factor Pipeline (pseudocode)

```
FUNCTION Evaluate(W):

  IF |W| == 0: RETURN { coefficient: 0.0, flag: Stable, cooldown: null }

  # ── Factor 1: Progressive loss streak (weight 0.35) ──────────────
  # Count consecutive losses ENDING at the most recent match.
  streak ← 0
  FOR m IN W (newest → oldest):
      IF outcome(m) == Loss: streak ← streak + 1
      ELSE: BREAK
  # Progressive, not linear: 1 loss barely registers, 3 is alarming, 5 saturates.
  streakNorm ← [0.00, 0.10, 0.35, 0.70, 0.90, 1.00][min(streak, 5)]

  # ── Factor 2: Tilt trajectory — post-match spike detection (weight 0.30) ──
  # Positive (post − pre) deltas mean matches are actively inflaming the player.
  deltas ← [ max(0, postTilt(m) − preTilt(m)) for m IN W ]
  # Recency weights, newest first (must sum to 1 for |W|=5):
  rw ← [0.35, 0.25, 0.20, 0.12, 0.08]   (truncated + renormalized when |W|<5)
  trajectoryNorm ← Σ ( deltas[i] × rw[i] ) / 4.0        # 4 = max possible delta (5−1)

  # ── Factor 3: Absolute tilt level, recency-weighted (weight 0.20) ─
  absoluteNorm ← Σ ( (postTilt(m_i) − 1) / 4.0 × rw[i] )

  # ── Factor 4: Performance decay slope (weight 0.15) ──────────────
  # Least-squares slope of perf over match index (oldest=0 … newest=|W|−1).
  # Falling performance under rising tilt = classic tilt spiral signature.
  slope ← linearRegressionSlope( x: index, y: perf(m) )
  # Normalize: a drop of ≥ 8 perf points per match saturates the factor.
  decayNorm ← clamp( −slope / 8.0, 0.0, 1.0 )

  # ── Composite ─────────────────────────────────────────────────────
  T ← 0.35×streakNorm + 0.30×trajectoryNorm + 0.20×absoluteNorm + 0.15×decayNorm
  T ← round(clamp(T, 0, 1), 2)

  # ── Hard override rules (evaluated AFTER the composite) ──────────
  # These are unconditional: no weighting can talk the engine out of them.
  OVERRIDE_A: streak ≥ 3 AND count(m IN W[0..2] where postTilt(m) ≥ 4) ≥ 2
  OVERRIDE_B: postTilt(W[0]) == 5 AND delta(W[0]) ≥ 2       # single-match rage spike
  IF OVERRIDE_A OR OVERRIDE_B: T ← max(T, 0.85)

  # ── Flag thresholds ───────────────────────────────────────────────
  flag ← Stable        IF T < 0.40
       ← Elevated     IF 0.40 ≤ T < 0.65
       ← Critical     IF 0.65 ≤ T < 0.85
       ← LockRequired IF T ≥ 0.85          # MUST trigger unconditional cooldown

  RETURN { coefficient: T, flag, streak, trajectory: trajectoryNorm × 4 }
```

### 5.3 Cooldown Prescription

```
FUNCTION PrescribeCooldown(T, flag, streak):
  IF flag == Stable OR flag == Elevated: RETURN null
  mandatory ← (flag == LockRequired)

  # Duration scales with severity; clamped to schema CHECK (30–3600s).
  duration ← clamp( round(180 + (T − 0.65) × 1200), 180, 900 )   # 3–15 minutes

  # Strategy rotation: pick the strategy LEAST used in this session so the
  # coaching doesn't become wallpaper. Tie-break order:
  strategy ← argmin(sessionUsageCount over [Breathing, Stretching, Hydration])
  IF streak ≥ 4: strategy ← Breathing        # highest-severity default

  RETURN { strategy, durationSeconds: duration, isMandatory: mandatory }
```

### 5.4 Engine Invariants & Enforcement Semantics

- **Cold start:** `|W| < 3` ⇒ flag capped at `Elevated` (never lock a brand-new user off two data points). Recency weights renormalize over the available window.
- **Unconditional lock:** on `LockRequired` the server (a) inserts `cooldown_protocols` row, (b) transitions the session state machine to `CooldownLocked`, (c) pushes `CooldownLockEngaged`, and (d) **rejects `POST /matches/log` with `423`** until released. The lock is server-enforced, not a UI suggestion.
- **Release paths:** `ConfirmCooldownCompliance` accepted only when `now − started_at ≥ 0.8 × duration_seconds` (anti-tap-through). The `CooldownWatchdog` `BackgroundService` releases unresolved locks at `started_at + duration + 120s grace` with `ComplianceVerified = false` (this distinction feeds the compliance analytics in §3.5's session summary).
- **Determinism:** all constants live in `TiltEngineOptions` bound from configuration (`"TiltEngine"` section) so tuning never requires a redeploy.

### 5.5 C# Service Skeleton

```csharp
// Services/TiltCalculationEngine.cs
using Microsoft.Extensions.Options;

namespace TiltGuard.Services;

public sealed class TiltCalculationEngine(IOptions<TiltEngineOptions> options)
    : ITiltCalculationEngine
{
    private readonly TiltEngineOptions _o = options.Value;

    public TiltEvaluation Evaluate(IReadOnlyList<MatchWindowEntry> window)
    {
        if (window.Count == 0) return TiltEvaluation.Stable;

        var streak = window.TakeWhile(m => m.Outcome == MatchOutcome.Loss).Count();
        var streakNorm = _o.StreakCurve[Math.Min(streak, 5)];

        var rw = Renormalize(_o.RecencyWeights, window.Count);
        var trajectoryNorm = window.Select((m, i) =>
            Math.Max(0, m.PostTilt - m.PreTilt) * rw[i]).Sum() / 4.0;
        var absoluteNorm = window.Select((m, i) =>
            (m.PostTilt - 1) / 4.0 * rw[i]).Sum();
        var decayNorm = Math.Clamp(
            -LeastSquaresSlope(window) / _o.PerfDecaySaturation, 0.0, 1.0);

        var t = 0.35 * streakNorm + 0.30 * trajectoryNorm
              + 0.20 * absoluteNorm + 0.15 * decayNorm;

        if (IsHardOverride(window, streak)) t = Math.Max(t, 0.85);
        if (window.Count < 3) t = Math.Min(t, 0.64);          // cold-start cap

        t = Math.Round(Math.Clamp(t, 0, 1), 2);
        return new TiltEvaluation(t, FlagFor(t), streak, trajectoryNorm * 4);
    }
    // Renormalize, LeastSquaresSlope, IsHardOverride, FlagFor: pure static helpers.
}
```

Repository query feeding the engine (the index-only scan from §2.1):

```csharp
var window = await db.MatchLogs.AsNoTracking()
    .Where(m => m.UserId == userId)
    .OrderByDescending(m => m.LoggedAt)
    .Take(5)
    .Select(m => new MatchWindowEntry(m.MatchOutcome, (double)m.PerformanceScore,
                                      m.PreMatchTiltLevel, m.PostMatchTiltLevel))
    .ToListAsync(ct);
```

---

## 6. REVENUECAT / MOBILE MONETIZATION HOOKS

### 6.1 Client Integration (Expo)

- Package: `react-native-purchases` (RevenueCat SDK). **Requires an Expo dev build / EAS Build** — it contains native code and does not run in Expo Go. Config: add to `app.json` plugins, build with `eas build --profile development`.
- On login: `Purchases.logIn(userId)` where `userId` is the TiltGuard user Guid ⇒ becomes the **RevenueCat App User ID**, persisted to `users.revenuecat_app_user_id` via `PATCH`-less side effect of first entitlement sync.
- Entitlement identifier: **`tiltguard_pro`**. Offerings: `pro_monthly` ($4.99), `pro_annual` ($39.99). Stripe handles web checkout through RevenueCat's Stripe integration; mobile stores handle IAP — the backend only ever talks to RevenueCat webhooks and never to store APIs directly.
- Client renders premium gates from the **server's** `premiumStatus` (source of truth), using the SDK's `getCustomerInfo()` only as an optimistic hint.

### 6.2 Webhook Endpoint & Signature Verification

`POST /api/v1/webhooks/revenuecat` *(anonymous route, secret-gated)*

RevenueCat authenticates webhooks with a static `Authorization` header value you configure in the dashboard. Verification MUST be constant-time:

```csharp
// Webhooks/RevenueCatWebhookController.cs
[HttpPost("revenuecat")]
[AllowAnonymous]
public async Task<IResult> Handle(
    [FromHeader(Name = "Authorization")] string? authHeader,
    [FromBody] RevenueCatEvent envelope,
    CancellationToken ct)
{
    var expected = Encoding.UTF8.GetBytes(_options.WebhookAuthHeader); // from secrets store
    var actual   = Encoding.UTF8.GetBytes(authHeader ?? string.Empty);
    if (actual.Length != expected.Length ||
        !CryptographicOperations.FixedTimeEquals(actual, expected))
        return Results.Unauthorized();

    await _entitlements.ProcessAsync(envelope, ct);
    return Results.Ok();            // always 200 after auth; retries handled by idempotency
}
```

Relevant envelope subset (`event` object):

```json
{
  "api_version": "1.0",
  "event": {
    "id": "12345678-aaaa-bbbb-cccc-1234567890ab",
    "type": "RENEWAL",
    "app_user_id": "0197c1a2-9f4e-7cc1-b3aa-1f2e3d4c5b6a",
    "entitlement_ids": ["tiltguard_pro"],
    "expiration_at_ms": 1770076800000,
    "period_type": "NORMAL",
    "store": "APP_STORE"
  }
}
```

### 6.3 Event → PremiumStatus State Map

| RevenueCat `event.type` | Resulting `premium_status` |
|---|---|
| `INITIAL_PURCHASE`, `RENEWAL`, `UNCANCELLATION`, `PRODUCT_CHANGE` | `premium` |
| `BILLING_ISSUE` | `grace_period` |
| `CANCELLATION` | *(no change — access persists until expiration)* |
| `EXPIRATION` | `expired` |
| `SUBSCRIBER_ALIAS`, `TRANSFER` | re-resolve `app_user_id` mapping, then no-op |

### 6.4 Idempotency + Optimistic Concurrency Update

Two failure modes are handled explicitly: **webhook redelivery** (RevenueCat retries on non-2xx and on timeout) and **concurrent writers** (a webhook and an admin action, or two retried deliveries, touching the same user row).

```csharp
// Services/EntitlementService.cs
public async Task ProcessAsync(RevenueCatEvent envelope, CancellationToken ct)
{
    var e = envelope.Event;

    // 1) Idempotency ledger: INSERT ... ON CONFLICT DO NOTHING semantics.
    db.ProcessedWebhookEvents.Add(new() { EventId = e.Id, EventType = e.Type });
    try { await db.SaveChangesAsync(ct); }
    catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: "23505" })
    { return; }   // already processed — swallow the retry

    // 2) Optimistic-concurrency update loop on the user row (xmin token).
    const int maxAttempts = 3;
    for (var attempt = 1; ; attempt++)
    {
        var user = await db.Users
            .FirstOrDefaultAsync(u => u.RevenueCatAppUserId == e.AppUserId
                                   || u.Id == Guid.Parse(e.AppUserId), ct);
        if (user is null) { logger.LogWarning("RC event {Id}: unknown user", e.Id); return; }

        user.RevenueCatAppUserId ??= e.AppUserId;
        user.PremiumStatus = MapStatus(e.Type, user.PremiumStatus);

        try { await db.SaveChangesAsync(ct); return; }
        catch (DbUpdateConcurrencyException) when (attempt < maxAttempts)
        {
            // Someone else moved xmin. Reload and re-apply the state map —
            // the map is monotone per event, so replaying is safe.
            db.ChangeTracker.Clear();
            await Task.Delay(TimeSpan.FromMilliseconds(50 * attempt), ct);
        }
    }
}
```

Why `xmin`: PostgreSQL stamps every row version in the hidden `xmin` system column; mapping `User.Version` with `.IsRowVersion()` under Npgsql makes EF Core append `WHERE xmin = @original` to the `UPDATE`, so a lost-update becomes a `DbUpdateConcurrencyException` instead of silent corruption — no trigger, no extra column, no schema noise.

### 6.5 Premium Evaluation API

`GET /api/v1/me/entitlements` *(Bearer)* → `200 OK`:

```json
{
  "premiumStatus": "premium",
  "entitlements": ["tiltguard_pro"],
  "features": {
    "unlimitedHistory": true,
    "liveTelemetry": true,
    "advancedAnalytics": true
  }
}
```

Server-side gate: policy `RequirePremium` (`premiumStatus ∈ {premium, grace_period}` read from the JWT `premium` claim, revalidated against the DB for `grace_period` users). Free-tier limits enforced server-side: history queries truncated to last 10 matches; `SendLiveTelemetry` returns `HubException("PREMIUM_REQUIRED")`.

---

## 7. MOBILE ARCHITECTURE TARGETS (Expo React Native)

```
app/
├── _layout.tsx              # Root: SafeArea + AuthProvider + QueryClientProvider
├── (auth)/
│   ├── _layout.tsx          # Redirects to /(app) when token pair present
│   ├── login.tsx
│   └── register.tsx
└── (app)/
    ├── _layout.tsx          # Tab navigator; guards on auth state
    ├── index.tsx            # Dashboard: tilt gauge + last-5 window strip
    ├── session/
    │   ├── active.tsx       # Live session: SignalR-driven state machine UI
    │   └── cooldown.tsx     # Full-screen mandatory cooldown (non-dismissable)
    ├── history.tsx
    └── settings.tsx
src/
├── api/client.ts            # fetch wrapper: bearer injection + 401→refresh→retry queue
├── realtime/tiltHub.ts      # @microsoft/signalr HubConnection singleton, typed events
├── stores/sessionStore.ts   # Zustand: mirrors server session state machine
├── stores/authStore.ts      # token pair in expo-secure-store, hydration on boot
└── components/…             # NativeWind-styled primitives
```

Non-negotiables:
- **Expo Router v4+ file-based routing** with route groups as shown; the `(app)` layout renders `<Redirect href="/(auth)/login" />` when unauthenticated.
- `tiltHub.ts` maps server events 1:1 to Zustand actions: `ReceiveTiltAlert → setTiltState`, `CooldownLockEngaged → router.replace('/session/cooldown')`. The cooldown screen disables Android back via `usePreventRemove` and offers no dismiss affordance until `CooldownLockReleased`.
- NativeWind theme tokens: risk colors `stable=#22c55e`, `elevated=#eab308`, `critical=#f97316`, `lockRequired=#ef4444` — used consistently across gauge, alerts, and push notification categories.
- All secrets (`API_URL`, RevenueCat public SDK keys) via `app.config.ts` + `expo-constants`; no secret material ships in the bundle beyond RevenueCat's public keys.

---

## 8. AGENT IMPLEMENTATION ORDER (build sequence for code-gen)

1. `TiltGuard.Domain` (enums + entities) → `TiltGuard.Infrastructure` (DbContext, migration matching §2.1 DDL exactly).
2. Auth vertical slice (§1.3 + §3.1–3.3) with integration tests for rotation + reuse detection.
3. Sessions + match logging (§3.4–3.6) with the `423` lock semantics stubbed.
4. `TiltCalculationEngine` (§5) — pure unit tests first: streak table, override rules, cold-start cap.
5. SignalR hub + `CooldownWatchdog` (§4, §5.4).
6. RevenueCat webhook + entitlement gates (§6).
7. Expo client (§7), wiring REST → hub → cooldown lock UI.

*End of TILTGUARD_SPEC.md*
