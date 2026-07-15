namespace TiltGuard.Domain;

public class CooldownProtocol
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public required Guid MatchId { get; init; }
    public required int DurationSeconds { get; init; }
    public required StrategyType StrategyType { get; init; }
    public bool ComplianceVerified { get; set; }
    public DateTimeOffset StartedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? ReleasedAt { get; set; }

    public MatchLog Match { get; init; } = null!;
}
