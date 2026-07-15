namespace TiltGuard.Hubs;

// Simplified 3-method subset of the spec's §4.1 strongly-typed contract (which has 5 methods
// with dedicated payload records - ReceiveSessionState, ReceiveTelemetryAck, and typed
// TiltAlertPayload/CooldownLockPayload/CooldownReleasePayload). Loosely-typed here as requested
// for this phase; expected to be tightened up once the REST-to-hub push path (§4.4) is wired.
public interface ITiltClient
{
    Task ReceiveTiltAlert(object payload);
    Task CooldownLockEngaged(object payload);
    Task CooldownLockReleased(string message);
}
