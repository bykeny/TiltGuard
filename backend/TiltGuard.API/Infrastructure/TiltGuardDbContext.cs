using Microsoft.EntityFrameworkCore;
using TiltGuard.Domain;

namespace TiltGuard.Infrastructure;

public class TiltGuardDbContext(DbContextOptions<TiltGuardDbContext> options)
    : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<GamingSession> Sessions => Set<GamingSession>();
    public DbSet<MatchLog> MatchLogs => Set<MatchLog>();
    public DbSet<CooldownProtocol> Cooldowns => Set<CooldownProtocol>();
    public DbSet<ProcessedWebhookEvent> ProcessedWebhookEvents => Set<ProcessedWebhookEvent>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.HasPostgresEnum<PremiumStatus>();
        b.HasPostgresEnum<GameType>();
        b.HasPostgresEnum<MatchOutcome>();
        b.HasPostgresEnum<StrategyType>();

        b.Entity<User>(e =>
        {
            e.ToTable("users");

            // ============================================================================
            // DO NOT let a future `dotnet ef migrations add` silently "fix" this index.
            // ux_users_email_lower is HAND-PATCHED in its migration file to a raw-SQL
            // functional index — `CREATE UNIQUE INDEX ux_users_email_lower ON users
            // (LOWER(email));` — because EF Core's fluent HasIndex API has no primitive
            // for an arbitrary SQL expression index (only real/shadow columns). The
            // HasIndex call below only exists so the model has *some* declaration for
            // this constraint; the model snapshot therefore thinks it's a plain unique
            // index on the raw `email` column and does NOT know about the LOWER()
            // expression. If you ever touch this entity's config and EF proposes a
            // migration that touches `ux_users_email_lower`, re-apply the raw-SQL patch
            // by hand in the generated migration's Up()/Down() — see
            // Migrations/*_InitialTiltGuardDatabase.cs for the reference patch.
            // ============================================================================
            e.Property(u => u.Email).HasMaxLength(320);
            e.HasIndex(u => u.Email).IsUnique().HasDatabaseName("ux_users_email_lower");
            e.Property(u => u.PasswordHash).HasMaxLength(100);
            e.Property(u => u.PremiumStatus).HasColumnType("premium_status");
            e.Property(u => u.RefreshToken).HasMaxLength(64);
            e.Property(u => u.Version).IsRowVersion();     // maps to xmin on Npgsql

            // DDL column is "revenuecat_app_user_id" (one word "revenuecat"), which diverges
            // from what snake_case naming convention would derive from RevenueCatAppUserId
            // ("revenue_cat_app_user_id"); pin the column name explicitly so migrations and
            // the filtered index predicate below stay byte-equivalent to the DDL.
            e.Property(u => u.RevenueCatAppUserId).HasColumnName("revenuecat_app_user_id");
            e.HasIndex(u => u.RevenueCatAppUserId).IsUnique()
             .HasFilter("revenuecat_app_user_id IS NOT NULL")
             .HasDatabaseName("ux_users_revenuecat_id");
        });

        b.Entity<GamingSession>(e =>
        {
            e.ToTable("gaming_sessions", t =>
                t.HasCheckConstraint("ck_sessions_end_after_start", "end_time IS NULL OR end_time >= start_time"));
            e.Property(s => s.GameType).HasColumnType("game_type");
            e.HasIndex(s => new { s.UserId, s.StartTime }).IsDescending(false, true)
             .HasDatabaseName("ix_sessions_user_start_desc");
            e.HasIndex(s => s.UserId).IsUnique().HasFilter("is_active")
             .HasDatabaseName("ux_sessions_one_active_per_user");
        });

        b.Entity<MatchLog>(e =>
        {
            e.ToTable("match_logs", t =>
            {
                t.HasCheckConstraint("ck_match_pre_tilt", "pre_match_tilt_level BETWEEN 1 AND 5");
                t.HasCheckConstraint("ck_match_post_tilt", "post_match_tilt_level BETWEEN 1 AND 5");
                t.HasCheckConstraint("ck_match_perf", "performance_score BETWEEN 0 AND 100");
            });
            e.Property(m => m.MatchOutcome).HasColumnType("match_outcome");
            e.Property(m => m.PerformanceScore).HasPrecision(5, 2);
            e.HasIndex(m => new { m.UserId, m.LoggedAt }).IsDescending(false, true)
             .IncludeProperties(m => new { m.MatchOutcome, m.PerformanceScore,
                                           m.PreMatchTiltLevel, m.PostMatchTiltLevel })
             .HasDatabaseName("ix_match_logs_user_logged_desc");
            e.HasIndex(m => new { m.SessionId, m.LoggedAt }).IsDescending(false, true)
             .HasDatabaseName("ix_match_logs_session_logged_desc");
            e.HasOne(m => m.Cooldown).WithOne(c => c.Match)
             .HasForeignKey<CooldownProtocol>(c => c.MatchId);
        });

        b.Entity<CooldownProtocol>(e =>
        {
            e.ToTable("cooldown_protocols", t =>
                t.HasCheckConstraint("ck_cooldown_duration", "duration_seconds BETWEEN 30 AND 3600"));
            e.Property(c => c.StrategyType).HasColumnType("strategy_type");
            e.HasIndex(c => c.StartedAt).HasFilter("released_at IS NULL")
             .HasDatabaseName("ix_cooldowns_pending");
        });

        b.Entity<ProcessedWebhookEvent>(e =>
        {
            e.ToTable("processed_webhook_events");
            e.HasKey(p => p.EventId);
            e.Property(p => p.EventId).HasMaxLength(64);
            e.Property(p => p.EventType).HasMaxLength(48);
        });
    }
}
