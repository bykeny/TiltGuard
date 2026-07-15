namespace TiltGuard.Contracts;

public sealed record RegisterRequest
{
    public required string Email { get; init; }
    public required string Password { get; init; }
}

public sealed record LoginRequest
{
    public required string Email { get; init; }
    public required string Password { get; init; }
}

public sealed record RefreshRequest
{
    public required string RefreshToken { get; init; }
}

public sealed record AuthTokenResponse
{
    public required Guid UserId { get; init; }
    public required string Email { get; init; }
    public required string PremiumStatus { get; init; }
    public required string AccessToken { get; init; }
    public required DateTimeOffset AccessTokenExpiresAtUtc { get; init; }
    public required string RefreshToken { get; init; }
    public required DateTimeOffset RefreshTokenExpiresAtUtc { get; init; }
}

public sealed record RefreshTokenResponse
{
    public required string AccessToken { get; init; }
    public required DateTimeOffset AccessTokenExpiresAtUtc { get; init; }
    public required string RefreshToken { get; init; }
    public required DateTimeOffset RefreshTokenExpiresAtUtc { get; init; }
}
