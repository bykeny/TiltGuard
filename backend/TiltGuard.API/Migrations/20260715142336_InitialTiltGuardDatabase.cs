using System;
using Microsoft.EntityFrameworkCore.Migrations;
using TiltGuard.Domain;

#nullable disable

namespace TiltGuard.API.Migrations
{
    /// <inheritdoc />
    public partial class InitialTiltGuardDatabase : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AlterDatabase()
                .Annotation("Npgsql:Enum:game_type", "cs2,lol,valorant,dota2,tanki_online,rocket_league,apex_legends,fortnite,other")
                .Annotation("Npgsql:Enum:match_outcome", "win,loss")
                .Annotation("Npgsql:Enum:premium_status", "free,premium,grace_period,expired")
                .Annotation("Npgsql:Enum:strategy_type", "breathing,stretching,hydration");

            migrationBuilder.CreateTable(
                name: "processed_webhook_events",
                columns: table => new
                {
                    event_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    event_type = table.Column<string>(type: "character varying(48)", maxLength: 48, nullable: false),
                    processed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_processed_webhook_events", x => x.event_id);
                });

            migrationBuilder.CreateTable(
                name: "users",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    password_hash = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    premium_status = table.Column<PremiumStatus>(type: "premium_status", nullable: false),
                    revenuecat_app_user_id = table.Column<string>(type: "text", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    refresh_token = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    refresh_token_expiry = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_users", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "gaming_sessions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    game_type = table.Column<GameType>(type: "game_type", nullable: false),
                    start_time = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    end_time = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    is_active = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_gaming_sessions", x => x.id);
                    table.CheckConstraint("ck_sessions_end_after_start", "end_time IS NULL OR end_time >= start_time");
                    table.ForeignKey(
                        name: "fk_gaming_sessions_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "match_logs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    session_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    match_outcome = table.Column<MatchOutcome>(type: "match_outcome", nullable: false),
                    performance_score = table.Column<decimal>(type: "numeric(5,2)", precision: 5, scale: 2, nullable: false),
                    pre_match_tilt_level = table.Column<short>(type: "smallint", nullable: false),
                    post_match_tilt_level = table.Column<short>(type: "smallint", nullable: false),
                    logged_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_match_logs", x => x.id);
                    table.CheckConstraint("ck_match_perf", "performance_score BETWEEN 0 AND 100");
                    table.CheckConstraint("ck_match_post_tilt", "post_match_tilt_level BETWEEN 1 AND 5");
                    table.CheckConstraint("ck_match_pre_tilt", "pre_match_tilt_level BETWEEN 1 AND 5");
                    table.ForeignKey(
                        name: "fk_match_logs_sessions_session_id",
                        column: x => x.session_id,
                        principalTable: "gaming_sessions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "cooldown_protocols",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    match_id = table.Column<Guid>(type: "uuid", nullable: false),
                    duration_seconds = table.Column<int>(type: "integer", nullable: false),
                    strategy_type = table.Column<StrategyType>(type: "strategy_type", nullable: false),
                    compliance_verified = table.Column<bool>(type: "boolean", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    released_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_cooldown_protocols", x => x.id);
                    table.CheckConstraint("ck_cooldown_duration", "duration_seconds BETWEEN 30 AND 3600");
                    table.ForeignKey(
                        name: "fk_cooldown_protocols_match_logs_match_id",
                        column: x => x.match_id,
                        principalTable: "match_logs",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_cooldown_protocols_match_id",
                table: "cooldown_protocols",
                column: "match_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_cooldowns_pending",
                table: "cooldown_protocols",
                column: "started_at",
                filter: "released_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "ix_sessions_user_start_desc",
                table: "gaming_sessions",
                columns: new[] { "user_id", "start_time" },
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "ux_sessions_one_active_per_user",
                table: "gaming_sessions",
                column: "user_id",
                unique: true,
                filter: "is_active");

            migrationBuilder.CreateIndex(
                name: "ix_match_logs_session_logged_desc",
                table: "match_logs",
                columns: new[] { "session_id", "logged_at" },
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "ix_match_logs_user_logged_desc",
                table: "match_logs",
                columns: new[] { "user_id", "logged_at" },
                descending: new[] { false, true })
                .Annotation("Npgsql:IndexInclude", new[] { "match_outcome", "performance_score", "pre_match_tilt_level", "post_match_tilt_level" });

            // Functional (case-insensitive) unique index - not expressible via the fluent
            // index API, which only targets real/shadow columns, not arbitrary SQL expressions.
            migrationBuilder.Sql("CREATE UNIQUE INDEX ux_users_email_lower ON users (LOWER(email));");

            migrationBuilder.CreateIndex(
                name: "ux_users_revenuecat_id",
                table: "users",
                column: "revenuecat_app_user_id",
                unique: true,
                filter: "revenuecat_app_user_id IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP INDEX IF EXISTS ux_users_email_lower;");

            migrationBuilder.DropTable(
                name: "cooldown_protocols");

            migrationBuilder.DropTable(
                name: "processed_webhook_events");

            migrationBuilder.DropTable(
                name: "match_logs");

            migrationBuilder.DropTable(
                name: "gaming_sessions");

            migrationBuilder.DropTable(
                name: "users");
        }
    }
}
