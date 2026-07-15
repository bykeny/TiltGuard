namespace TiltGuard.Services;

// Thrown by AuthService for every non-2xx outcome; the endpoint layer maps
// Code/StatusCode/Details directly onto the uniform error envelope (§3).
public sealed class AuthException(
    string code,
    string message,
    int statusCode,
    IReadOnlyDictionary<string, string[]>? details = null)
    : Exception(message)
{
    public string Code { get; } = code;
    public int StatusCode { get; } = statusCode;
    public IReadOnlyDictionary<string, string[]>? Details { get; } = details;
}
