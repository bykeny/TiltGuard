using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using TiltGuard.Contracts;
using TiltGuard.Domain;
using TiltGuard.Hubs;
using TiltGuard.Infrastructure;

namespace TiltGuard.Services;

public interface ISessionService
{
    Task<SessionStartResponse> StartSessionAsync(Guid userId, StartSessionRequest request, CancellationToken ct);
    Task<SessionEndResponse> EndSessionAsync(Guid userId, EndSessionRequest request, CancellationToken ct);
    Task<MatchLogResponse> LogMatchAsync(Guid userId, LogMatchRequest request, CancellationToken ct);
    Task<ActiveSessionDto?> GetActiveSessionAsync(Guid userId, CancellationToken ct);

    // Hub-facing (§4.3): returns null when the session does not exist or is not the caller's,
    // which is what lets TiltHub.JoinSession reject without leaking which of the two it was.
    Task<SessionStatePayload?> GetOwnedSessionStateAsync(Guid userId, Guid sessionId, CancellationToken ct);
}

public sealed class SessionService(
    TiltGuardDbContext db,
    ITiltCalculationEngine tiltEngine,
    IHubContext<TiltHub, ITiltClient> hub,
    ILogger<SessionService> logger) : ISessionService
{
    private const int LockedCooldownDurationSeconds = 900; // 15 minutes, fixed for this phase.

    public async Task<SessionStartResponse> StartSessionAsync(Guid userId, StartSessionRequest request, CancellationToken ct)
    {
        if (!ApiEnumMapping.TryParseGameType(request.GameType, out var gameType))
            throw ValidationFailed("gameType", "Must be one of: cs2, lol, valorant, dota2, tanki_online, rocket_league, apex_legends, fortnite, other.");

        var activeSessionId = await db.Sessions.AsNoTracking()
            .Where(s => s.UserId == userId && s.IsActive)
            .Select(s => (Guid?)s.Id)
            .FirstOrDefaultAsync(ct);
        if (activeSessionId is { } existingId)
            throw SessionAlreadyActive(existingId);

        var session = new GamingSession { UserId = userId, GameType = gameType };
        db.Sessions.Add(session);

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            // The partial unique index ux_sessions_one_active_per_user is the real guarantee;
            // the AnyAsync check above has a race window between two concurrent session starts.
            throw SessionAlreadyActive(null);
        }

        return new SessionStartResponse
        {
            SessionId = session.Id,
            GameType = gameType.ToApiString(),
            StartTime = session.StartTime,
            IsActive = session.IsActive,
        };
    }

    public async Task<SessionEndResponse> EndSessionAsync(Guid userId, EndSessionRequest request, CancellationToken ct)
    {
        var session = await db.Sessions.FirstOrDefaultAsync(
            s => s.Id == request.SessionId && s.UserId == userId && s.IsActive, ct)
            ?? throw NotFound();

        var activeLock = await GetActiveLockAsync(userId, ct);
        if (activeLock is not null)
            throw CooldownActive(activeLock);

        var matches = await db.MatchLogs.AsNoTracking()
            .Where(m => m.SessionId == session.Id)
            .Select(m => new { m.MatchOutcome, m.PerformanceScore, m.PostMatchTiltLevel })
            .ToListAsync(ct);

        var cooldownCompliance = await db.Cooldowns.AsNoTracking()
            .Where(c => c.Match.SessionId == session.Id)
            .Select(c => c.ComplianceVerified)
            .ToListAsync(ct);

        session.IsActive = false;
        session.EndTime = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        var summary = new SessionSummary
        {
            MatchesPlayed = matches.Count,
            Wins = matches.Count(m => m.MatchOutcome == MatchOutcome.Win),
            Losses = matches.Count(m => m.MatchOutcome == MatchOutcome.Loss),
            AvgPerformanceScore = matches.Count == 0 ? 0 : Math.Round((double)matches.Average(m => m.PerformanceScore), 2),
            PeakTiltLevel = matches.Count == 0 ? 0 : matches.Max(m => (int)m.PostMatchTiltLevel),
            CooldownsTriggered = cooldownCompliance.Count,
            CooldownsComplied = cooldownCompliance.Count(complied => complied),
        };

        return new SessionEndResponse { SessionId = session.Id, EndTime = session.EndTime!.Value, Summary = summary };
    }

    public async Task<MatchLogResponse> LogMatchAsync(Guid userId, LogMatchRequest request, CancellationToken ct)
    {
        if (!ApiEnumMapping.TryParseMatchOutcome(request.MatchOutcome, out var outcome))
            throw ValidationFailed("matchOutcome", "Must be 'win' or 'loss'.");
        ValidateLogRequest(request);

        // Circuit breaker: an active cooldown lock blocks match logging outright (§5.4).
        var activeLock = await GetActiveLockAsync(userId, ct);
        if (activeLock is not null)
            throw CooldownActive(activeLock);

        var session = await db.Sessions.FirstOrDefaultAsync(
            s => s.Id == request.SessionId && s.UserId == userId && s.IsActive, ct)
            ?? throw NotFound();

        var match = new MatchLog
        {
            SessionId = session.Id,
            UserId = userId,
            MatchOutcome = outcome,
            PerformanceScore = request.PerformanceScore,
            PreMatchTiltLevel = request.PreMatchTiltLevel,
            PostMatchTiltLevel = request.PostMatchTiltLevel,
        };

        TiltAssessment assessment = null!;
        CooldownProtocol? cooldown = null;

        // EnableRetryOnFailure means EF's execution strategy owns retries; a manually-opened
        // transaction must be wrapped through it or EF throws at runtime ("execution strategy
        // does not support user-initiated transactions"). The match insert and the conditional
        // cooldown insert must commit atomically - a lock that fails to persist must not leave
        // an unguarded match log behind.
        var strategy = db.Database.CreateExecutionStrategy();
        await strategy.ExecuteAsync(async () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(ct);

            db.MatchLogs.Add(match);
            await db.SaveChangesAsync(ct);

            assessment = await tiltEngine.AssessPlayerStateAsync(userId, ct);

            if (assessment.RequiresCooldown)
            {
                cooldown = new CooldownProtocol
                {
                    MatchId = match.Id,
                    DurationSeconds = LockedCooldownDurationSeconds,
                    StrategyType = assessment.RecommendedCooldown?.StrategyType ?? StrategyType.Breathing,
                    ComplianceVerified = false,
                };
                db.Cooldowns.Add(cooldown);
                await db.SaveChangesAsync(ct);
            }

            await tx.CommitAsync(ct);
        });

        var tiltEvaluation = new TiltEvaluationResponse
        {
            TiltCoefficient = assessment.TiltCoefficient,
            RiskFlag = assessment.RiskFlag.ToApiString(),
            WindowSize = assessment.WindowSize,
            ConsecutiveLosses = assessment.ConsecutiveLosses,
            RecommendedCooldown = cooldown is null ? null : new RecommendedCooldownResponse
            {
                CooldownId = cooldown.Id,
                StrategyType = cooldown.StrategyType.ToApiString(),
                DurationSeconds = cooldown.DurationSeconds,
                IsMandatory = true,
            },
        };

        // §4.4 push path, deliberately after the commit: broadcasting from inside the transaction
        // would announce a match that a rollback then erased.
        await PushTiltAlertAsync(session.Id, match.LoggedAt, assessment, cooldown);

        return new MatchLogResponse { MatchId = match.Id, LoggedAt = match.LoggedAt, TiltEvaluation = tiltEvaluation };
    }

    // Fire-and-report: the match is already durable and §3.6 embeds the same evaluation in the
    // 201 body precisely so the UI renders without waiting on this. A hub fault must therefore
    // never turn a successful write into a 500 - it degrades to "no live push this time".
    private async Task PushTiltAlertAsync(
        Guid sessionId,
        DateTimeOffset evaluatedAt,
        TiltAssessment assessment,
        CooldownProtocol? cooldown)
    {
        try
        {
            var group = hub.Clients.Group(TiltHub.SessionGroup(sessionId));

            await group.ReceiveTiltAlert(new TiltAlertPayload
            {
                TiltCoefficient = assessment.TiltCoefficient,
                RiskFlag = assessment.RiskFlag.ToApiString(),
                ConsecutiveLosses = assessment.ConsecutiveLosses,
                TiltTrajectory = assessment.Trajectory,
                RecommendedCooldownAction = cooldown is null ? null : new RecommendedCooldownAction
                {
                    CooldownId = cooldown.Id,
                    StrategyType = cooldown.StrategyType.ToApiString(),
                    DurationSeconds = cooldown.DurationSeconds,
                    IsMandatory = true,
                },
                EvaluatedAtUtc = evaluatedAt,
            });

            // RequiresCooldown is true only for LockRequired (§5.4); Critical is advisory and
            // must not lock. The cooldown row is what the client needs to count down against,
            // so both conditions have to hold before a lock is announced.
            if (assessment.RequiresCooldown && cooldown is not null)
            {
                await group.CooldownLockEngaged(new CooldownLockPayload
                {
                    CooldownId = cooldown.Id,
                    StrategyType = cooldown.StrategyType.ToApiString(),
                    DurationSeconds = cooldown.DurationSeconds,
                    // Same expression GetActiveLockAsync and CooldownWatchdog use to decide when
                    // a lock is over, so the client's timer cannot outlive the server's view.
                    LockExpiresAtUtc = cooldown.StartedAt.AddSeconds(cooldown.DurationSeconds),
                    CoachMessage = BuildCoachMessage(assessment.ConsecutiveLosses, cooldown),
                });
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Hub push failed for session {SessionId}; the match was still committed.", sessionId);
        }
    }

    private static string BuildCoachMessage(int consecutiveLosses, CooldownProtocol cooldown)
    {
        var minutes = Math.Max(1, cooldown.DurationSeconds / 60);
        var activity = cooldown.StrategyType switch
        {
            StrategyType.Breathing => "box breathing",
            StrategyType.Stretching => "stretching",
            StrategyType.Hydration => "hydration",
            _ => "recovery",
        };

        var streak = consecutiveLosses == 1
            ? "That loss put you over the line."
            : $"{consecutiveLosses} losses in a row.";

        return $"{streak} {minutes} minutes of {activity} before queue.";
    }

    public async Task<ActiveSessionDto?> GetActiveSessionAsync(Guid userId, CancellationToken ct)
    {
        // ux_sessions_one_active_per_user (partial unique index) guarantees at most one row here,
        // so FirstOrDefault is exact rather than "pick any".
        var session = await db.Sessions.AsNoTracking()
            .Where(s => s.UserId == userId && s.IsActive)
            .Select(s => new
            {
                s.Id,
                s.GameType,
                s.StartTime,
                MatchesCount = s.Matches.Count,
            })
            .FirstOrDefaultAsync(ct);

        return session is null ? null : new ActiveSessionDto
        {
            SessionId = session.Id,
            GameType = session.GameType.ToApiString(),
            StartTime = session.StartTime,
            MatchesCount = session.MatchesCount,
        };
    }

    public async Task<SessionStatePayload?> GetOwnedSessionStateAsync(Guid userId, Guid sessionId, CancellationToken ct)
    {
        // Ownership - not liveness - is the gate. A client re-invoking JoinSession after a
        // reconnect should be told the session is Idle, not thrown a HubException, if it ended
        // while the socket was down.
        var session = await db.Sessions.AsNoTracking()
            .Where(s => s.Id == sessionId && s.UserId == userId)
            .Select(s => new
            {
                s.Id,
                s.IsActive,
                MatchesLogged = s.Matches.Count,
            })
            .FirstOrDefaultAsync(ct);

        if (session is null)
            return null;

        // Reuses the one definition of "active lock" rather than restating the predicate, so the
        // replayed state can never disagree with what LogMatchAsync enforces.
        var isLocked = await GetActiveLockAsync(userId, ct) is not null;

        return new SessionStatePayload
        {
            SessionId = session.Id,
            State = isLocked ? "CooldownLocked" : session.IsActive ? "InMatch" : "Idle",
            MatchesLogged = session.MatchesLogged,
        };
    }

    // "Unexpired cooldown protocol for that user": ReleasedAt is the authoritative signal that
    // a lock has been closed out (by the watchdog or, once built, by user self-report via
    // ConfirmCooldownCompliance - §4.3), matching CooldownWatchdog's own query. The duration
    // check is kept too as a self-healing fallback so a lock still stops blocking once its
    // window passes even in the few seconds before the watchdog's next tick releases it.
    private async Task<CooldownProtocol?> GetActiveLockAsync(Guid userId, CancellationToken ct) =>
        await db.Cooldowns
            .Where(c => c.Match.UserId == userId
                     && c.ReleasedAt == null
                     && c.StartedAt.AddSeconds(c.DurationSeconds) > DateTimeOffset.UtcNow)
            .OrderByDescending(c => c.StartedAt)
            .FirstOrDefaultAsync(ct);

    private static void ValidateLogRequest(LogMatchRequest request)
    {
        var errors = new Dictionary<string, string[]>();

        if (request.PerformanceScore < 0 || request.PerformanceScore > 100)
            errors["performanceScore"] = ["Must be between 0 and 100."];
        if (request.PreMatchTiltLevel is < 1 or > 5)
            errors["preMatchTiltLevel"] = ["Must be between 1 and 5."];
        if (request.PostMatchTiltLevel is < 1 or > 5)
            errors["postMatchTiltLevel"] = ["Must be between 1 and 5."];

        if (errors.Count > 0)
            throw new SessionException("VALIDATION_FAILED", "One or more fields are invalid.", StatusCodes.Status400BadRequest, errors);
    }

    private static SessionException NotFound() =>
        new("NOT_FOUND", "Session not found.", StatusCodes.Status404NotFound);

    private static SessionException SessionAlreadyActive(Guid? activeSessionId) =>
        new("SESSION_ALREADY_ACTIVE", "You already have an active session.", StatusCodes.Status409Conflict,
            activeSessionId is { } id ? new { activeSessionId = id } : null);

    // Deviates from the spec §3 registry's "COOLDOWN_LOCK_ACTIVE" - using the literal code
    // requested for this phase. Flagging in case it should be reconciled with the registry.
    private static SessionException CooldownActive(CooldownProtocol activeLock) =>
        new("COOLDOWN_ACTIVE",
            "A mandatory cooldown is active. Confirm compliance or wait for it to expire before continuing.",
            StatusCodes.Status423Locked,
            new
            {
                cooldownId = activeLock.Id,
                lockExpiresAtUtc = activeLock.StartedAt.AddSeconds(activeLock.DurationSeconds),
            });

    private static SessionException ValidationFailed(string field, string message) =>
        new("VALIDATION_FAILED", "One or more fields are invalid.", StatusCodes.Status400BadRequest,
            new Dictionary<string, string[]> { [field] = [message] });

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is PostgresException { SqlState: "23505" };
}
