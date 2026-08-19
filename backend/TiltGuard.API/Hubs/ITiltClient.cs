namespace TiltGuard.Hubs;

// Strongly-typed client contract (§4.1).
//
// ReceiveTelemetryAck is still absent because SendLiveTelemetry (§4.3) has no server-side
// implementation yet. CooldownLockReleased deliberately keeps its `string` argument rather than
// §4.2's CooldownReleasePayload: CooldownWatchdog is its only caller and tightening it is a wire
// change for already-shipped clients, so it is left for the phase that builds
// ConfirmCooldownCompliance and needs the ComplianceVerified flag to distinguish a user-confirmed
// release from a watchdog expiry.
public interface ITiltClient
{
    Task ReceiveTiltAlert(TiltAlertPayload payload);
    Task ReceiveSessionState(SessionStatePayload payload);
    Task CooldownLockEngaged(CooldownLockPayload payload);
    Task CooldownLockReleased(string message);
}
