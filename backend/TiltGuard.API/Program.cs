using System.Diagnostics;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Npgsql;
using TiltGuard.BackgroundServices;
using TiltGuard.Contracts;
using TiltGuard.Domain;
using TiltGuard.Hubs;
using TiltGuard.Infrastructure;
using TiltGuard.Services;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();

var dataSourceBuilder = new NpgsqlDataSourceBuilder(
    builder.Configuration.GetConnectionString("TiltGuard"));
dataSourceBuilder.MapEnum<PremiumStatus>("premium_status");
dataSourceBuilder.MapEnum<GameType>("game_type");
dataSourceBuilder.MapEnum<MatchOutcome>("match_outcome");
dataSourceBuilder.MapEnum<StrategyType>("strategy_type");
var dataSource = dataSourceBuilder.Build();

builder.Services.AddDbContextPool<TiltGuardDbContext>(o =>
    o.UseNpgsql(dataSource, npgsql =>
     {
         // When using a pre-built NpgsqlDataSource, Npgsql requires the enum mapping to be
         // registered a second time here (in addition to the NpgsqlDataSourceBuilder calls
         // above) - otherwise the EF layer silently falls back to sending enum values as
         // plain integers at runtime, even though HasPostgresEnum<T>() is declared in
         // OnModelCreating and the column's real Postgres type is the native enum.
         npgsql.MapEnum<PremiumStatus>("premium_status");
         npgsql.MapEnum<GameType>("game_type");
         npgsql.MapEnum<MatchOutcome>("match_outcome");
         npgsql.MapEnum<StrategyType>("strategy_type");
         npgsql.EnableRetryOnFailure(3);
     })
     .UseSnakeCaseNamingConvention());

builder.Services.Configure<JwtOptions>(builder.Configuration.GetSection(JwtOptions.SectionName));
builder.Services.Configure<RevenueCatOptions>(builder.Configuration.GetSection(RevenueCatOptions.SectionName));
builder.Services.AddScoped<IAuthService, AuthService>();
builder.Services.AddScoped<IEntitlementService, EntitlementService>();
builder.Services.AddScoped<ITiltCalculationEngine, TiltCalculationEngine>();
builder.Services.AddScoped<ISessionService, SessionService>();
builder.Services.AddHostedService<CooldownWatchdog>();

builder.Services.AddSignalR().AddMessagePackProtocol();

// Must be registered for Context.UserIdentifier to resolve at all - see SubClaimUserIdProvider
// for why the default NameIdentifier-based provider comes back null in this app (§4.4).
builder.Services.AddSingleton<IUserIdProvider, SubClaimUserIdProvider>();

var jwtSection = builder.Configuration.GetSection(JwtOptions.SectionName);
var jwtSecret = jwtSection["Secret"]
    ?? throw new InvalidOperationException("Jwt:Secret is not configured.");
var jwtIssuer = jwtSection["Issuer"]
    ?? throw new InvalidOperationException("Jwt:Issuer is not configured.");
var jwtAudience = jwtSection["Audience"]
    ?? throw new InvalidOperationException("Jwt:Audience is not configured.");

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        // Keep short claim names ("sub", not the long ClaimTypes.NameIdentifier URI) on the
        // resulting ClaimsPrincipal - Context.UserIdentifier (SignalR, §4.3) and any future
        // [Authorize]-protected handler that reads the "sub" claim depend on this.
        options.MapInboundClaims = false;
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = jwtIssuer,
            ValidateAudience = true,
            ValidAudience = jwtAudience,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Convert.FromBase64String(jwtSecret)),
            ValidateLifetime = true,
            ClockSkew = TimeSpan.Zero,
        };

        // SignalR's browser/mobile clients can't set an Authorization header on the WebSocket
        // handshake, so the JWT travels as an "access_token" query string param instead;
        // intercept it here and hand it to the bearer handler as if it were the header value.
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                if (context.HttpContext.Request.Path.StartsWithSegments("/hubs/tilt"))
                {
                    string? accessToken = context.HttpContext.Request.Query["access_token"];
                    if (!string.IsNullOrEmpty(accessToken))
                    {
                        context.Token = accessToken;
                    }
                }

                return Task.CompletedTask;
            },
        };
    });

builder.Services.AddAuthorization();

builder.Services.AddRateLimiter(options =>
{
    // Policy "auth": 10 requests/minute/IP on /api/v1/auth/* (§1.3 rate limiting table).
    options.AddFixedWindowLimiter("auth", limiterOptions =>
    {
        limiterOptions.PermitLimit = 10;
        limiterOptions.Window = TimeSpan.FromMinutes(1);
        limiterOptions.QueueLimit = 0;
        limiterOptions.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
    });

    options.OnRejected = async (context, ct) =>
    {
        context.HttpContext.Response.ContentType = "application/json";
        context.HttpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;
        await context.HttpContext.Response.WriteAsJsonAsync(
            BuildErrorEnvelope("RATE_LIMITED", "Too many requests. Please try again later.", context.HttpContext),
            cancellationToken: ct);
    };
});

var app = builder.Build();

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

app.MapHub<TiltHub>("/hubs/tilt");

var auth = app.MapGroup("/api/v1/auth").RequireRateLimiting("auth");

auth.MapPost("/register", async (RegisterRequest request, IAuthService authService, HttpContext httpContext, CancellationToken ct) =>
{
    try
    {
        var result = await authService.RegisterAsync(request, ct);
        return Results.Created($"/api/v1/users/{result.UserId}", result);
    }
    catch (AuthException ex)
    {
        return ToErrorResult(ex, httpContext);
    }
});

auth.MapPost("/login", async (LoginRequest request, IAuthService authService, HttpContext httpContext, CancellationToken ct) =>
{
    try
    {
        var result = await authService.LoginAsync(request, ct);
        return Results.Ok(result);
    }
    catch (AuthException ex)
    {
        return ToErrorResult(ex, httpContext);
    }
});

auth.MapPost("/refresh", async (RefreshRequest request, IAuthService authService, HttpContext httpContext, CancellationToken ct) =>
{
    try
    {
        var header = httpContext.Request.Headers.Authorization.ToString();
        var expiredAccessToken = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? header["Bearer ".Length..]
            : null;

        var result = await authService.RefreshAsync(request, expiredAccessToken, ct);
        return Results.Ok(result);
    }
    catch (AuthException ex)
    {
        return ToErrorResult(ex, httpContext);
    }
});

var api = app.MapGroup("/api/v1").RequireAuthorization();

api.MapPost("/sessions/start", async (StartSessionRequest request, ISessionService sessionService, ClaimsPrincipal user, HttpContext httpContext, CancellationToken ct) =>
{
    try
    {
        var result = await sessionService.StartSessionAsync(GetUserId(user), request, ct);
        return Results.Created($"/api/v1/sessions/{result.SessionId}", result);
    }
    catch (SessionException ex)
    {
        return ToSessionErrorResult(ex, httpContext);
    }
});

api.MapGet("/sessions/active", async (ISessionService sessionService, ClaimsPrincipal user, CancellationToken ct) =>
{
    var result = await sessionService.GetActiveSessionAsync(GetUserId(user), ct);

    // 204, not 404: "you have no session open" is a valid answer to a valid question, not a
    // missing resource, and it saves the client from parsing an error envelope on the happy path.
    return result is null ? Results.NoContent() : Results.Ok(result);
});

api.MapPost("/sessions/end", async (EndSessionRequest request, ISessionService sessionService, ClaimsPrincipal user, HttpContext httpContext, CancellationToken ct) =>
{
    try
    {
        var result = await sessionService.EndSessionAsync(GetUserId(user), request, ct);
        return Results.Ok(result);
    }
    catch (SessionException ex)
    {
        return ToSessionErrorResult(ex, httpContext);
    }
});

api.MapPost("/matches/log", async (LogMatchRequest request, ISessionService sessionService, ClaimsPrincipal user, HttpContext httpContext, CancellationToken ct) =>
{
    try
    {
        var result = await sessionService.LogMatchAsync(GetUserId(user), request, ct);
        return Results.Created($"/api/v1/matches/{result.MatchId}", result);
    }
    catch (SessionException ex)
    {
        return ToSessionErrorResult(ex, httpContext);
    }
});

api.MapGet("/me/entitlements", async (IEntitlementService entitlements, ClaimsPrincipal user, HttpContext httpContext, CancellationToken ct) =>
{
    // Read from the database, not from the JWT's "premium" claim: the claim is a snapshot taken
    // at login and an access token lives 15 minutes, so a webhook that just upgraded (or expired)
    // an account would not be reflected until the next refresh. §6.1 makes the server's stored
    // status the source of truth for gating.
    var result = await entitlements.GetEntitlementsAsync(GetUserId(user), ct);

    return result is null
        ? Results.Json(BuildErrorEnvelope("NOT_FOUND", "User not found.", httpContext), statusCode: StatusCodes.Status404NotFound)
        : Results.Ok(result);
});

// Anonymous, secret-gated (§6.2). Deliberately outside the "auth" rate-limit policy: throttling
// RevenueCat's delivery retries by IP would drop legitimate billing events on the floor.
app.MapPost("/api/v1/webhooks/revenuecat", async (
    RevenueCatEvent envelope,
    IEntitlementService entitlements,
    IOptions<RevenueCatOptions> revenueCatOptions,
    HttpContext httpContext,
    ILoggerFactory loggerFactory,
    CancellationToken ct) =>
{
    var logger = loggerFactory.CreateLogger("RevenueCatWebhook");
    var configured = revenueCatOptions.Value.WebhookAuthHeader;

    // Fail closed. With no secret configured, `expected` would be empty and the constant-time
    // compare below would match an absent Authorization header - i.e. a misconfigured deployment
    // would silently expose entitlement writes to the internet.
    if (string.IsNullOrEmpty(configured))
    {
        logger.LogError("RevenueCat:WebhookAuthHeader is not configured; rejecting webhook delivery.");
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }

    var expected = Encoding.UTF8.GetBytes(configured);
    var actual = Encoding.UTF8.GetBytes(httpContext.Request.Headers.Authorization.ToString());
    if (actual.Length != expected.Length || !CryptographicOperations.FixedTimeEquals(actual, expected))
        return Results.Unauthorized();

    // Structural validation happens after auth so an unauthenticated caller cannot probe the
    // parser for shape differences.
    if (string.IsNullOrWhiteSpace(envelope.Event?.Id) || string.IsNullOrWhiteSpace(envelope.Event.Type))
        return Results.Json(
            BuildErrorEnvelope("VALIDATION_FAILED", "event.id and event.type are required.", httpContext),
            statusCode: StatusCodes.Status400BadRequest);

    if (envelope.Event.Id.Length > 64 || envelope.Event.Type.Length > 48)
        return Results.Json(
            BuildErrorEnvelope("VALIDATION_FAILED", "event.id or event.type exceeds the supported length.", httpContext),
            statusCode: StatusCodes.Status400BadRequest);

    var result = await entitlements.ProcessAsync(envelope, ct);

    // 200 for everything the ledger settled - redeliveries are absorbed by idempotency, so there
    // is nothing for RevenueCat to retry. A lost concurrency race is the one case where nothing
    // was committed, so it answers 503 to *ask* for the redelivery.
    return result == WebhookProcessingResult.Conflict
        ? Results.StatusCode(StatusCodes.Status503ServiceUnavailable)
        : Results.Ok();
})
.AllowAnonymous();

app.Run();

static Guid GetUserId(ClaimsPrincipal user) =>
    Guid.Parse(user.FindFirstValue(JwtRegisteredClaimNames.Sub)!);

static object BuildErrorEnvelope(string code, string message, HttpContext httpContext, object? details = null) => new
{
    error = new
    {
        code,
        message,
        traceId = Activity.Current?.Id ?? httpContext.TraceIdentifier,
        details,
    }
};

static IResult ToErrorResult(AuthException ex, HttpContext httpContext) =>
    Results.Json(BuildErrorEnvelope(ex.Code, ex.Message, httpContext, ex.Details), statusCode: ex.StatusCode);

static IResult ToSessionErrorResult(SessionException ex, HttpContext httpContext) =>
    Results.Json(BuildErrorEnvelope(ex.Code, ex.Message, httpContext, ex.Details), statusCode: ex.StatusCode);
