using System.IdentityModel.Tokens.Jwt;
using Microsoft.AspNetCore.SignalR;

namespace TiltGuard.Hubs;

// §4.4: "IUserIdProvider is implemented to read the sub claim so Context.UserIdentifier is the
// user Guid."
//
// This is required, not decorative. Program.cs sets JwtBearerOptions.MapInboundClaims = false to
// keep short claim names, so the principal carries "sub" and never ClaimTypes.NameIdentifier -
// which is the only claim DefaultUserIdProvider looks at. Without this provider
// Context.UserIdentifier is null on every connection.
public sealed class SubClaimUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection) =>
        connection.User?.FindFirst(JwtRegisteredClaimNames.Sub)?.Value;
}
