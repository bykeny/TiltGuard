namespace TiltGuard.Hubs;

// Server->client hub payloads (§4.2).
//
// Enum-valued fields are carried as their wire strings (ApiEnumMapping.ToApiString) rather than
// as CLR enums: SignalR's JSON protocol would otherwise serialize them as ordinals, which are
// opaque on the wire and shift the moment a member is inserted. Strings also keep these payloads
// spelled identically to their REST counterparts in TiltEvaluationResponse (§3.6), so a client
// parses "lockRequired" the same way whichever channel delivered it.

public sealed record RecommendedCooldownAction
{
    public required Guid CooldownId { get; init; }
    public required string StrategyType { get; init; }      // breathing | stretching | hydration
    public required int DurationSeconds { get; init; }
    public required bool IsMandatory { get; init; }
}

public sealed record TiltAlertPayload
{
    public required double TiltCoefficient { get; init; }   // 0.00-1.00
    public required string RiskFlag { get; init; }          // stable | elevated | critical | lockRequired
    public required int ConsecutiveLosses { get; init; }
    public required double TiltTrajectory { get; init; }    // avg(post-pre) over the window
    public required RecommendedCooldownAction? RecommendedCooldownAction { get; init; }
    public required DateTimeOffset EvaluatedAtUtc { get; init; }
}

public sealed record CooldownLockPayload
{
    public required Guid CooldownId { get; init; }
    public required string StrategyType { get; init; }
    public required int DurationSeconds { get; init; }
    public required DateTimeOffset LockExpiresAtUtc { get; init; }
    public required string CoachMessage { get; init; }
}

public sealed record SessionStatePayload
{
    public required Guid SessionId { get; init; }
    public required string State { get; init; }             // Idle | InMatch | Evaluating | CooldownLocked
    public required int MatchesLogged { get; init; }
}
