using System.IdentityModel.Tokens.Jwt;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace TiltGuard.Hubs;

[Authorize]
public sealed class TiltHub : Hub<ITiltClient>
{
    public override async Task OnConnectedAsync()
    {
        // Group name is the raw "sub" claim string, which is the user Guid's default
        // ToString() format (see AuthService.GenerateAccessToken) - CooldownWatchdog broadcasts
        // to Clients.Group(userId.ToString()) using that exact same format, so the two line up
        // without needing a custom IUserIdProvider.
        var userId = Context.User?.FindFirst(JwtRegisteredClaimNames.Sub)?.Value;
        if (!string.IsNullOrEmpty(userId))
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, userId);
        }

        await base.OnConnectedAsync();
    }
}
