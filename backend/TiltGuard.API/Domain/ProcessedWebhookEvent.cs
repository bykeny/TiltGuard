namespace TiltGuard.Domain;

// Idempotency ledger for RevenueCat webhook deliveries (§6.4).
public class ProcessedWebhookEvent
{
    public required string EventId { get; init; }          // RevenueCat event.id
    public required string EventType { get; init; }
    public DateTimeOffset ProcessedAt { get; init; } = DateTimeOffset.UtcNow;
}
