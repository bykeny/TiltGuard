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
