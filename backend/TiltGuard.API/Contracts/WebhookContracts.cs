using System.Text.Json.Serialization;

namespace TiltGuard.Contracts;

// RevenueCat webhook envelope (§6.2).
//
// Every property carries an explicit [JsonPropertyName]: RevenueCat emits snake_case, while this
// API's Minimal API pipeline deserializes with the Web defaults (camelCase). Without these
// attributes "app_user_id" would silently bind to null and every event would resolve to an
// unknown user.
//
// Nothing is `required`. System.Text.Json throws on a missing required member, which would turn a
// malformed delivery into an unhandled 500; the endpoint validates the few fields that matter and
// answers deliberately instead.

public sealed record RevenueCatEvent
{
    [JsonPropertyName("api_version")]
    public string? ApiVersion { get; init; }

    [JsonPropertyName("event")]
    public RevenueCatEventBody? Event { get; init; }
}

public sealed record RevenueCatEventBody
{
    /// RevenueCat's event id — the idempotency key written to processed_webhook_events.
    [JsonPropertyName("id")]
    public string? Id { get; init; }

    /// INITIAL_PURCHASE | RENEWAL | UNCANCELLATION | PRODUCT_CHANGE | BILLING_ISSUE |
    /// CANCELLATION | EXPIRATION | SUBSCRIBER_ALIAS | TRANSFER | ...
    [JsonPropertyName("type")]
    public string? Type { get; init; }

    /// The TiltGuard user Guid (§6.1) — but may also be a RevenueCat anonymous id
    /// ("$RCAnonymousID:...") for a purchase made before Purchases.logIn ran.
    [JsonPropertyName("app_user_id")]
    public string? AppUserId { get; init; }

    [JsonPropertyName("entitlement_ids")]
    public string[]? EntitlementIds { get; init; }

    [JsonPropertyName("expiration_at_ms")]
    public long? ExpirationAtMs { get; init; }

    [JsonPropertyName("period_type")]
    public string? PeriodType { get; init; }

    [JsonPropertyName("store")]
    public string? Store { get; init; }
}
