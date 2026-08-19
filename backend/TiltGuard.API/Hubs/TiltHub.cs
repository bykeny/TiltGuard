using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using TiltGuard.Services;

namespace TiltGuard.Hubs;

[Authorize]
public sealed class TiltHub(ISessionService sessions) : Hub<ITiltClient>
{
    // §4.3 group naming. Declared here and consumed by SessionService's push path (§4.4) so the
    // producer and the consumer of these groups can never drift apart.
    public static string SessionGroup(Guid sessionId) => $"session:{sessionId}";

    // Backed by SubClaimUserIdProvider, which reads the "sub" claim. Also the name of the
    // per-user group joined below, so CooldownWatchdog's Clients.Group(userId.ToString())
    // broadcasts keep landing.
    private Guid UserId =>
        Guid.TryParse(Context.UserIdentifier, out var userId)
            ? userId
            : throw new HubException("UNAUTHENTICATED");

    public override async Task OnConnectedAsync()
    {
        // Group name is the raw "sub" claim string, which is the user Guid's default ToString()
        // format (see AuthService.GenerateAccessToken) - CooldownWatchdog broadcasts to
        // Clients.Group(userId.ToString()) using that exact same format, so the two line up.
        var userId = Context.UserIdentifier;
        if (!string.IsNullOrEmpty(userId))
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, userId);
        }

        await base.OnConnectedAsync();
    }

    /// Client calls after sessions/start (or on reconnect). Validates ownership, adds the
    /// connection to the session group, replays current state (§4.3).
    public async Task JoinSession(Guid sessionId)
    {
        // Ownership is verified server-side before the connection is allowed anywhere near the
        // group: group membership is what receives another user's tilt alerts, so an unchecked
        // JoinSession would be a cross-account data leak.
        var state = await sessions.GetOwnedSessionStateAsync(UserId, sessionId, Context.ConnectionAborted)
            ?? throw new HubException("SESSION_NOT_FOUND_OR_NOT_OWNED");

        await Groups.AddToGroupAsync(Context.ConnectionId, SessionGroup(sessionId), Context.ConnectionAborted);
        await Clients.Caller.ReceiveSessionState(state);
    }

    /// Groups are keyed to a connection id, so this only needs to undo an explicit join - a
    /// disconnect drops the membership on its own.
    public Task LeaveSession(Guid sessionId) =>
        Groups.RemoveFromGroupAsync(Context.ConnectionId, SessionGroup(sessionId), Context.ConnectionAborted);
}
