namespace TiltGuard.Services;

// Thrown by SessionService for every non-2xx outcome; the endpoint layer maps
// Code/StatusCode/Details directly onto the uniform error envelope (§3).
public sealed class SessionException(string code, string message, int statusCode, object? details = null)
    : Exception(message)
{
    public string Code { get; } = code;
    public int StatusCode { get; } = statusCode;
    public object? Details { get; } = details;
}
