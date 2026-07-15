namespace TiltGuard.Contracts;

public sealed record StartSessionRequest
{
    public required string GameType { get; init; }
}

public sealed record SessionStartResponse
{
    public required Guid SessionId { get; init; }
    public required string GameType { get; init; }
    public required DateTimeOffset StartTime { get; init; }
    public required bool IsActive { get; init; }
}

public sealed record EndSessionRequest
{
    public required Guid SessionId { get; init; }
}

public sealed record SessionSummary
{
    public required int MatchesPlayed { get; init; }
    public required int Wins { get; init; }
    public required int Losses { get; init; }
    public required double AvgPerformanceScore { get; init; }
    public required int PeakTiltLevel { get; init; }
    public required int CooldownsTriggered { get; init; }
    public required int CooldownsComplied { get; init; }
}

public sealed record SessionEndResponse
{
    public required Guid SessionId { get; init; }
    public required DateTimeOffset EndTime { get; init; }
    public required SessionSummary Summary { get; init; }
}

public sealed record LogMatchRequest
{
    public required Guid SessionId { get; init; }
    public required string MatchOutcome { get; init; }
    public required decimal PerformanceScore { get; init; }
    public required short PreMatchTiltLevel { get; init; }
    public required short PostMatchTiltLevel { get; init; }
}

public sealed record RecommendedCooldownResponse
{
    public required Guid CooldownId { get; init; }
    public required string StrategyType { get; init; }
    public required int DurationSeconds { get; init; }
    public required bool IsMandatory { get; init; }
}

public sealed record TiltEvaluationResponse
{
    public required double TiltCoefficient { get; init; }
    public required string RiskFlag { get; init; }
    public required int WindowSize { get; init; }
    public required int ConsecutiveLosses { get; init; }
    public RecommendedCooldownResponse? RecommendedCooldown { get; init; }
}

public sealed record MatchLogResponse
{
    public required Guid MatchId { get; init; }
    public required DateTimeOffset LoggedAt { get; init; }
    public required TiltEvaluationResponse TiltEvaluation { get; init; }
}
