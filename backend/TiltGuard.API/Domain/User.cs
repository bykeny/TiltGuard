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
