using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using TiltGuard.Hubs;
using TiltGuard.Infrastructure;

namespace TiltGuard.BackgroundServices;

// Server-side authority on cooldown expiry (§1.2/§5.4): releases any CooldownProtocol whose
// duration has elapsed without the client ever confirming compliance, so a lock can never be
// left stuck open just because ConfirmCooldownCompliance was never called.
public sealed class CooldownWatchdog(IServiceScopeFactory scopeFactory, ILogger<CooldownWatchdog> logger)
    : BackgroundService
{
    private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TickInterval);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await ReleaseExpiredCooldownsAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "CooldownWatchdog tick failed.");
            }
        }
    }

    private async Task ReleaseExpiredCooldownsAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TiltGuardDbContext>();
        var hub = scope.ServiceProvider.GetRequiredService<IHubContext<TiltHub, ITiltClient>>();

        var now = DateTimeOffset.UtcNow;

        // ix_cooldowns_pending is a partial index on (started_at) WHERE released_at IS NULL, so
        // the first predicate keeps this an index scan over just the not-yet-released rows, not
        // the full cooldown_protocols history. ReleasedAt (not ComplianceVerified) is what marks
        // a row as "already handled" - ComplianceVerified stays false here since the watchdog
        // releasing a lock is not the same thing as the user having complied with it, and once
        // ReleasedAt is set this row drops out of the query's match set so it is never
        // reprocessed or rebroadcast on a later tick.
        var expired = await db.Cooldowns
            .Include(c => c.Match)
            .Where(c => c.ReleasedAt == null)
            .Where(c => c.StartedAt.AddSeconds(c.DurationSeconds) <= now)
            .ToListAsync(ct);

        foreach (var cooldown in expired)
        {
            cooldown.ReleasedAt = DateTimeOffset.UtcNow;
            cooldown.ComplianceVerified = false;
            await db.SaveChangesAsync(ct);

            var userId = cooldown.Match.UserId;
            await hub.Clients.Group(userId.ToString())
                .CooldownLockReleased("Your cooldown period has ended. Play focused.");
        }
    }
}
