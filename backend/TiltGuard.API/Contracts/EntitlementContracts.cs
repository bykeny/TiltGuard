namespace TiltGuard.Contracts;

// GET /api/v1/me/entitlements (§6.5).

public sealed record EntitlementFeatures
{
    public required bool UnlimitedHistory { get; init; }
    public required bool LiveTelemetry { get; init; }
    public required bool AdvancedAnalytics { get; init; }
}

public sealed record EntitlementsResponse
{
    public required string PremiumStatus { get; init; }          // free | premium | grace_period | expired
    public required IReadOnlyList<string> Entitlements { get; init; }  // ["tiltguard_pro"] when active
    public required EntitlementFeatures Features { get; init; }
}
