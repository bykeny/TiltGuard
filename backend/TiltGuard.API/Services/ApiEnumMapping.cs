using TiltGuard.Domain;

namespace TiltGuard.Services;

// Wire-format <-> CLR enum conversions. Wire strings match the DDL's native Postgres enum
// labels (snake_case) except RiskFlag, which is API/hub-only (never persisted) and uses
// camelCase per §4.2/§3.6 JSON examples ("lockRequired").
public static class ApiEnumMapping
{
    public static string ToApiString(this GameType value) => value switch
    {
        GameType.Cs2 => "cs2",
        GameType.Lol => "lol",
        GameType.Valorant => "valorant",
        GameType.Dota2 => "dota2",
        GameType.TankiOnline => "tanki_online",
        GameType.RocketLeague => "rocket_league",
        GameType.ApexLegends => "apex_legends",
        GameType.Fortnite => "fortnite",
        GameType.Other => "other",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static bool TryParseGameType(string? value, out GameType result)
    {
        switch (value?.Trim().ToLowerInvariant())
        {
            case "cs2": result = GameType.Cs2; return true;
            case "lol": result = GameType.Lol; return true;
            case "valorant": result = GameType.Valorant; return true;
            case "dota2": result = GameType.Dota2; return true;
            case "tanki_online": result = GameType.TankiOnline; return true;
            case "rocket_league": result = GameType.RocketLeague; return true;
            case "apex_legends": result = GameType.ApexLegends; return true;
            case "fortnite": result = GameType.Fortnite; return true;
            case "other": result = GameType.Other; return true;
            default: result = default; return false;
        }
    }

    public static string ToApiString(this MatchOutcome value) => value switch
    {
        MatchOutcome.Win => "win",
        MatchOutcome.Loss => "loss",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static bool TryParseMatchOutcome(string? value, out MatchOutcome result)
    {
        switch (value?.Trim().ToLowerInvariant())
        {
            case "win": result = MatchOutcome.Win; return true;
            case "loss": result = MatchOutcome.Loss; return true;
            default: result = default; return false;
        }
    }

    public static string ToApiString(this StrategyType value) => value switch
    {
        StrategyType.Breathing => "breathing",
        StrategyType.Stretching => "stretching",
        StrategyType.Hydration => "hydration",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static string ToApiString(this RiskFlag value) => value switch
    {
        RiskFlag.Stable => "stable",
        RiskFlag.Elevated => "elevated",
        RiskFlag.Critical => "critical",
        RiskFlag.LockRequired => "lockRequired",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };
}
