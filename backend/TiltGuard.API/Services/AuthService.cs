using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Npgsql;
using TiltGuard.Contracts;
using TiltGuard.Domain;
using TiltGuard.Infrastructure;

namespace TiltGuard.Services;

public interface IAuthService
{
    Task<AuthTokenResponse> RegisterAsync(RegisterRequest request, CancellationToken ct);
    Task<AuthTokenResponse> LoginAsync(LoginRequest request, CancellationToken ct);

    // expiredAccessToken: the just-expired access token from the client's last call (Authorization
    // header). It identifies WHICH user's row to check/rotate/revoke — see the design note above
    // TryExtractUserId for why this is required rather than optional.
    Task<RefreshTokenResponse> RefreshAsync(RefreshRequest request, string? expiredAccessToken, CancellationToken ct);
}

public sealed class AuthService(TiltGuardDbContext db, IOptions<JwtOptions> jwtOptions) : IAuthService
{
    private readonly JwtOptions _jwt = jwtOptions.Value;

    private static readonly Regex EmailPattern = new(@"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$", RegexOptions.Compiled);
    private static readonly Regex PasswordPattern = new(@"^(?=.*[A-Z])(?=.*\d).{10,128}$", RegexOptions.Compiled);

    public async Task<AuthTokenResponse> RegisterAsync(RegisterRequest request, CancellationToken ct)
    {
        var email = NormalizeEmail(request.Email);
        ValidateCredentials(email, request.Password);

        // .ToLower() (not a plain equality) so this hits the ux_users_email_lower functional
        // index (CREATE UNIQUE INDEX ... ON users (LOWER(email))) instead of a sequential scan.
        var exists = await db.Users.AnyAsync(u => u.Email.ToLower() == email, ct);
        if (exists)
            throw EmailTaken();

        var (rawRefresh, refreshHash, refreshExpiry) = GenerateRefreshToken();

        var user = new User
        {
            Email = email,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(request.Password, workFactor: 12),
            RefreshToken = refreshHash,
            RefreshTokenExpiry = refreshExpiry,
        };

        db.Users.Add(user);

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            // Belt-and-suspenders: the proactive AnyAsync check above has a race window between
            // two concurrent registrations for the same email; the DB's partial unique index is
            // the real guarantee (surfaces here as Postgres 23505).
            throw EmailTaken();
        }

        var (accessToken, accessExpiry) = GenerateAccessToken(user);
        return ToAuthTokenResponse(user, accessToken, accessExpiry, rawRefresh, refreshExpiry);
    }

    public async Task<AuthTokenResponse> LoginAsync(LoginRequest request, CancellationToken ct)
    {
        var email = NormalizeEmail(request.Email);
        var user = await db.Users.FirstOrDefaultAsync(u => u.Email.ToLower() == email, ct);

        // Identical response for unknown email vs. wrong password - no user enumeration (§3.2).
        if (user is null || !BCrypt.Net.BCrypt.Verify(request.Password, user.PasswordHash))
            throw new AuthException("INVALID_CREDENTIALS", "Invalid email or password.", StatusCodes.Status401Unauthorized);

        var (rawRefresh, refreshHash, refreshExpiry) = GenerateRefreshToken();
        user.RefreshToken = refreshHash;
        user.RefreshTokenExpiry = refreshExpiry;
        await db.SaveChangesAsync(ct);

        var (accessToken, accessExpiry) = GenerateAccessToken(user);
        return ToAuthTokenResponse(user, accessToken, accessExpiry, rawRefresh, refreshExpiry);
    }

    public async Task<RefreshTokenResponse> RefreshAsync(RefreshRequest request, string? expiredAccessToken, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.RefreshToken))
            throw new AuthException("VALIDATION_FAILED", "refreshToken is required.", StatusCodes.Status400BadRequest,
                new Dictionary<string, string[]> { ["refreshToken"] = ["Required."] });

        var userId = TryExtractUserId(expiredAccessToken);
        if (userId is null)
            throw new AuthException("VALIDATION_FAILED",
                "A valid 'Authorization: Bearer <access token>' header (may be expired) must accompany the refresh request.",
                StatusCodes.Status400BadRequest);

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user?.RefreshToken is null || user.RefreshTokenExpiry is null)
            throw TokenExpired();

        var presentedHash = SHA256.HashData(Encoding.UTF8.GetBytes(request.RefreshToken));
        var storedHash = Base64UrlDecode(user.RefreshToken);

        var isValid = presentedHash.Length == storedHash.Length
            && CryptographicOperations.FixedTimeEquals(presentedHash, storedHash);

        if (!isValid)
        {
            // Reuse/replay detected: a token hash was presented for this user that does not
            // match what's currently on file. Nuclear option - revoke every active session for
            // this user rather than trying to guess which one is legitimate (§1.3.4).
            user.RefreshToken = null;
            user.RefreshTokenExpiry = null;
            await db.SaveChangesAsync(ct);
            throw new AuthException("REFRESH_REUSE_DETECTED",
                "Refresh token reuse detected. All sessions for this account have been revoked.",
                StatusCodes.Status401Unauthorized);
        }

        if (user.RefreshTokenExpiry <= DateTimeOffset.UtcNow)
            throw TokenExpired();

        // Rotate: issue a brand-new pair; the old hash is overwritten atomically in the same UPDATE.
        var (rawRefresh, refreshHash, refreshExpiry) = GenerateRefreshToken();
        user.RefreshToken = refreshHash;
        user.RefreshTokenExpiry = refreshExpiry;
        await db.SaveChangesAsync(ct);

        var (accessToken, accessExpiry) = GenerateAccessToken(user);
        return new RefreshTokenResponse
        {
            AccessToken = accessToken,
            AccessTokenExpiresAtUtc = accessExpiry,
            RefreshToken = rawRefresh,
            RefreshTokenExpiresAtUtc = refreshExpiry,
        };
    }

    // The refresh_token column stores exactly one hash per user (rotated in place on every use),
    // so a bare "hash the presented token and look it up" cannot identify a candidate row once a
    // token has already been rotated away or was never valid - there is nothing left to scan for.
    // Per §1.3.4, the client-supplied (possibly expired) access token's `sub` claim is what
    // identifies the user; we validate its signature/issuer/audience but not its lifetime, so a
    // tampered or forged token can never be used to point reuse-detection at an arbitrary victim.
    private Guid? TryExtractUserId(string? bearerToken)
    {
        if (string.IsNullOrWhiteSpace(bearerToken))
            return null;

        var parameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = _jwt.Issuer,
            ValidateAudience = true,
            ValidAudience = _jwt.Audience,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Convert.FromBase64String(_jwt.Secret)),
            ValidateLifetime = false, // the access token is expected to be expired at refresh time
            ClockSkew = TimeSpan.Zero,
        };

        try
        {
            // MapInboundClaims defaults to true, which silently renames "sub" to the long legacy
            // ClaimTypes.NameIdentifier URI on the resulting principal - FindFirst("sub") would
            // otherwise always return null even for a token that validated successfully.
            var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
            var principal = handler.ValidateToken(bearerToken, parameters, out _);
            var sub = principal.FindFirst(JwtRegisteredClaimNames.Sub)?.Value;
            return Guid.TryParse(sub, out var id) ? id : null;
        }
        catch (SecurityTokenException)
        {
            return null;
        }
    }

    private (string token, DateTimeOffset expiresAt) GenerateAccessToken(User user)
    {
        var now = DateTimeOffset.UtcNow;
        var expires = now.AddMinutes(_jwt.AccessTokenLifetimeMinutes);

        var claims = new[]
        {
            new Claim(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
            new Claim(JwtRegisteredClaimNames.Email, user.Email),
            new Claim("premium", user.PremiumStatus.ToString()),
            new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
        };

        var key = new SymmetricSecurityKey(Convert.FromBase64String(_jwt.Secret));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var token = new JwtSecurityToken(
            issuer: _jwt.Issuer,
            audience: _jwt.Audience,
            claims: claims,
            notBefore: now.UtcDateTime,
            expires: expires.UtcDateTime,
            signingCredentials: creds);

        return (new JwtSecurityTokenHandler().WriteToken(token), expires);
    }

    private (string rawToken, string hash, DateTimeOffset expiresAt) GenerateRefreshToken()
    {
        var rawToken = Base64UrlEncode(RandomNumberGenerator.GetBytes(64));
        var hash = Base64UrlEncode(SHA256.HashData(Encoding.UTF8.GetBytes(rawToken)));
        var expiresAt = DateTimeOffset.UtcNow.AddDays(_jwt.RefreshTokenLifetimeDays);
        return (rawToken, hash, expiresAt);
    }

    private static string NormalizeEmail(string email) => email.Trim().ToLowerInvariant();

    private static void ValidateCredentials(string email, string password)
    {
        var errors = new Dictionary<string, string[]>();

        if (string.IsNullOrEmpty(email) || email.Length > 320 || !EmailPattern.IsMatch(email))
            errors["email"] = ["Must be a valid email address, max 320 characters."];

        if (string.IsNullOrEmpty(password) || !PasswordPattern.IsMatch(password))
            errors["password"] = ["Must be 10-128 characters with at least one uppercase letter and one digit."];

        if (errors.Count > 0)
            throw new AuthException("VALIDATION_FAILED", "One or more fields are invalid.", StatusCodes.Status400BadRequest, errors);
    }

    private static AuthException EmailTaken() =>
        new("EMAIL_TAKEN", "An account with this email already exists.", StatusCodes.Status409Conflict);

    private static AuthException TokenExpired() =>
        new("TOKEN_EXPIRED", "Refresh token is invalid or expired.", StatusCodes.Status401Unauthorized);

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is PostgresException { SqlState: "23505" };

    private static string Base64UrlEncode(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded += (padded.Length % 4) switch { 2 => "==", 3 => "=", _ => "" };
        return Convert.FromBase64String(padded);
    }

    private static AuthTokenResponse ToAuthTokenResponse(
        User user, string accessToken, DateTimeOffset accessExpiry, string rawRefresh, DateTimeOffset refreshExpiry) => new()
    {
        UserId = user.Id,
        Email = user.Email,
        PremiumStatus = ToApiPremiumStatus(user.PremiumStatus),
        AccessToken = accessToken,
        AccessTokenExpiresAtUtc = accessExpiry,
        RefreshToken = rawRefresh,
        RefreshTokenExpiresAtUtc = refreshExpiry,
    };

    // Matches the DDL enum labels / REST JSON examples (§3.1: "premiumStatus": "free"), which
    // are snake_case and distinct from the JWT claim's PascalCase convention (§1.3: "Premium").
    private static string ToApiPremiumStatus(PremiumStatus status) => status switch
    {
        PremiumStatus.Free => "free",
        PremiumStatus.Premium => "premium",
        PremiumStatus.GracePeriod => "grace_period",
        PremiumStatus.Expired => "expired",
        _ => throw new ArgumentOutOfRangeException(nameof(status)),
    };
}
