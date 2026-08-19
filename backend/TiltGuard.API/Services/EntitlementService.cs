using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Npgsql;
using TiltGuard.Contracts;
using TiltGuard.Domain;
using TiltGuard.Infrastructure;

namespace TiltGuard.Services;

// Outcome of one webhook delivery. The endpoint turns this into a status code, which is what
// decides whether RevenueCat redelivers.
public enum WebhookProcessingResult
{
    /// Ledger written and the state map applied (which may legitimately be a no-op).
    Processed,

    /// This event.id was already in the ledger — a redelivery. Nothing re-applied.
    Duplicate,

    /// app_user_id matched no user. Recorded and dropped; redelivering will not help.
    UnknownUser,

    /// Optimistic concurrency lost 3 times. Nothing was committed, so this one *must* be retried.
    Conflict,
}

public interface IEntitlementService
{
    Task<WebhookProcessingResult> ProcessAsync(RevenueCatEvent envelope, CancellationToken ct);

    /// Null when the user id does not exist (a valid token for a deleted user).
    Task<EntitlementsResponse?> GetEntitlementsAsync(Guid userId, CancellationToken ct);
}

public sealed class EntitlementService(
    TiltGuardDbContext db,
    IOptions<RevenueCatOptions> options,
    ILogger<EntitlementService> logger) : IEntitlementService
{
    private const int MaxConcurrencyAttempts = 3;

    public async Task<WebhookProcessingResult> ProcessAsync(RevenueCatEvent envelope, CancellationToken ct)
    {
        var e = envelope.Event
            ?? throw new ArgumentException("Envelope has no event body.", nameof(envelope));
        var eventId = e.Id ?? throw new ArgumentException("Event has no id.", nameof(envelope));
        var eventType = e.Type ?? throw new ArgumentException("Event has no type.", nameof(envelope));

        // EnableRetryOnFailure means EF's execution strategy owns retries, and a manually-opened
        // transaction has to be wrapped through it or EF throws at runtime. A retry re-runs the
        // whole delegate, which is safe precisely because of the ledger: a re-run after an
        // ambiguous commit sees its own row and returns Duplicate.
        var strategy = db.Database.CreateExecutionStrategy();

        return await strategy.ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear();
            await using var tx = await db.Database.BeginTransactionAsync(ct);

            // 1) Idempotency ledger. Deliberately inside the same transaction as the entitlement
            // update: the spec's two-step version commits the ledger first, so a crash in between
            // marks the event processed while the user's status never moved — and since the
            // endpoint answers 200, RevenueCat never redelivers it. Atomic here means the event is
            // either fully applied or fully retryable.
            db.ProcessedWebhookEvents.Add(new ProcessedWebhookEvent
            {
                EventId = eventId,
                EventType = eventType,
            });

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                // A 23505 aborts the Postgres transaction, so nothing further can run on it.
                await tx.RollbackAsync(ct);
                logger.LogInformation("RevenueCat event {EventId} already processed; ignoring redelivery.", eventId);
                return WebhookProcessingResult.Duplicate;
            }

            // 2) Optimistic-concurrency update loop on the user row (xmin token, §6.4).
            for (var attempt = 1; ; attempt++)
            {
                var user = await ResolveUserAsync(e.AppUserId, ct);
                if (user is null)
                {
                    logger.LogWarning(
                        "RevenueCat event {EventId} ({EventType}): no user matches app_user_id {AppUserId}.",
                        eventId, eventType, e.AppUserId);

                    // The ledger row still commits: replaying this delivery would resolve to the
                    // same nobody, so swallowing the retry is the correct end state.
                    await tx.CommitAsync(ct);
                    return WebhookProcessingResult.UnknownUser;
                }

                // First entitlement sync is what links the RevenueCat id to the account (§6.1).
                user.RevenueCatAppUserId ??= e.AppUserId;

                var mapped = MapStatus(eventType);
                if (mapped is { } nextStatus)
                {
                    user.PremiumStatus = nextStatus;
                }

                try
                {
                    await db.SaveChangesAsync(ct);
                    await tx.CommitAsync(ct);

                    logger.LogInformation(
                        "RevenueCat event {EventId} ({EventType}) applied to user {UserId}: premium status {Status}.",
                        eventId, eventType, user.Id, user.PremiumStatus);

                    return WebhookProcessingResult.Processed;
                }
                catch (DbUpdateConcurrencyException) when (attempt < MaxConcurrencyAttempts)
                {
                    // Someone else moved xmin. Reload and re-apply the state map — the map is
                    // monotone per event, so replaying it is safe.
                    db.ChangeTracker.Clear();
                    await Task.Delay(TimeSpan.FromMilliseconds(50 * attempt), ct);
                }
                catch (DbUpdateConcurrencyException ex)
                {
                    // Out of attempts. Roll the ledger back too, so the event is not recorded as
                    // processed when it was not — the endpoint answers non-2xx and RevenueCat
                    // redelivers into a clean slate.
                    await tx.RollbackAsync(ct);
                    logger.LogError(
                        ex,
                        "RevenueCat event {EventId}: lost optimistic concurrency {Attempts} times; rolled back for redelivery.",
                        eventId, MaxConcurrencyAttempts);

                    return WebhookProcessingResult.Conflict;
                }
            }
        });
    }

    public async Task<EntitlementsResponse?> GetEntitlementsAsync(Guid userId, CancellationToken ct)
    {
        var status = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => (PremiumStatus?)u.PremiumStatus)
            .FirstOrDefaultAsync(ct);

        if (status is not { } premiumStatus)
            return null;

        // §6.5's RequirePremium definition: grace_period still has access — that is the entire
        // point of a grace period, so it must not be treated as lapsed here.
        var isActive = premiumStatus is PremiumStatus.Premium or PremiumStatus.GracePeriod;

        return new EntitlementsResponse
        {
            PremiumStatus = premiumStatus.ToApiString(),
            Entitlements = isActive ? [options.Value.EntitlementId] : [],
            Features = new EntitlementFeatures
            {
                UnlimitedHistory = isActive,
                LiveTelemetry = isActive,
                AdvancedAnalytics = isActive,
            },
        };
    }

    /// §6.3 event -> premium_status map. Null means "leave the status alone":
    /// CANCELLATION keeps access until the subscription actually expires, SUBSCRIBER_ALIAS and
    /// TRANSFER only re-resolve the app_user_id mapping, and an unrecognised type must never
    /// silently downgrade a paying user.
    private static PremiumStatus? MapStatus(string eventType) => eventType.ToUpperInvariant() switch
    {
        "INITIAL_PURCHASE" or "RENEWAL" or "UNCANCELLATION" or "PRODUCT_CHANGE" => PremiumStatus.Premium,
        "BILLING_ISSUE" => PremiumStatus.GracePeriod,
        "EXPIRATION" => PremiumStatus.Expired,
        _ => null,
    };

    private async Task<User?> ResolveUserAsync(string? appUserId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(appUserId))
            return null;

        // TryParse, not Parse: app_user_id is only a Guid once Purchases.logIn has run. A purchase
        // made beforehand carries a RevenueCat anonymous id ("$RCAnonymousID:..."), which would
        // throw FormatException and 500 the webhook. A failed parse leaves Guid.Empty, which
        // matches no row, so the lookup falls through to the linked-id comparison alone.
        Guid.TryParse(appUserId, out var candidateId);

        return await db.Users.FirstOrDefaultAsync(
            u => u.RevenueCatAppUserId == appUserId || u.Id == candidateId, ct);
    }

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is PostgresException { SqlState: "23505" };
}
