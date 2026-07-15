namespace TiltGuard.Domain;

public class MatchLog
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public required Guid SessionId { get; init; }
    public required Guid UserId { get; init; }            // denormalized, see DDL comment
    public required MatchOutcome MatchOutcome { get; init; }
    public required decimal PerformanceScore { get; init; }   // 0-100
    public required short PreMatchTiltLevel { get; init; }    // 1-5
    public required short PostMatchTiltLevel { get; init; }   // 1-5
    public DateTimeOffset LoggedAt { get; init; } = DateTimeOffset.UtcNow;

    public GamingSession Session { get; init; } = null!;
    public CooldownProtocol? Cooldown { get; set; }
}
