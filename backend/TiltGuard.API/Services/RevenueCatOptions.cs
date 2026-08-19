namespace TiltGuard.Services;

public sealed class RevenueCatOptions
{
    public const string SectionName = "RevenueCat";

    // The static Authorization header value configured in the RevenueCat dashboard (§6.2).
    //
    // Nullable on purpose: an unconfigured secret is a state the endpoint has to detect and fail
    // *closed* on. If this were a non-null empty string, the constant-time comparison would
    // happily match an empty/absent Authorization header and leave the webhook open to anyone.
    public string? WebhookAuthHeader { get; init; }

    // The entitlement identifier RevenueCat grants for a paid subscription (§6.1).
    public string EntitlementId { get; init; } = "tiltguard_pro";
}
