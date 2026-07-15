using Microsoft.EntityFrameworkCore;
using TiltGuard.Domain;
using TiltGuard.Infrastructure;

namespace TiltGuard.Services;

public enum RiskFlag { Stable, Elevated, Critical, LockRequired }

public sealed record RecommendedCooldown
{
    public required StrategyType StrategyType { get; init; }
    public required int DurationSeconds { get; init; }
    public required bool IsMandatory { get; init; }
}

public sealed record TiltAssessment
{
    public required double TiltCoefficient { get; init; }   // 0.00-1.00, §5.2 composite T
    public required RiskFlag RiskFlag { get; init; }
    public required int WindowSize { get; init; }
    public required int ConsecutiveLosses { get; init; }
    public required double Trajectory { get; init; }        // avg(post-pre) over window, 0-4 scale

    // Auxiliary diagnostics (not what drives RiskFlag/TiltCoefficient, which use the full
    // weighted composite below, but useful signal on their own).
    public required double RollingWinRate { get; init; }
    public required double AvgPostMatchTilt { get; init; }

    // True iff RiskFlag == LockRequired - the one flag §5.4 says "MUST trigger unconditional
    // cooldown". Critical is an advisory (non-mandatory) recommendation, not a lock.
    public required bool RequiresCooldown { get; init; }
    public RecommendedCooldown? RecommendedCooldown { get; init; }
}

public interface ITiltCalculationEngine
{
    Task<TiltAssessment> AssessPlayerStateAsync(Guid userId, CancellationToken ct);
}

// Registered Scoped (not the Singleton the spec's architecture diagram calls for in §1.1/§5.5):
// this class injects TiltGuardDbContext directly to fetch its own window given just a userId,
// per the exact signature requested for this phase. A Scoped EF DbContext cannot safely be
// injected into a Singleton service (captive dependency / DI validation failure), so Scoped is
// the correct lifetime for this shape. If a future phase wants the Singleton-math /
// Scoped-repository split from the spec, the pure math below (Evaluate) can be lifted into a
// separate stateless class unchanged - it takes no dependencies itself.
public sealed class TiltCalculationEngine(TiltGuardDbContext db) : ITiltCalculationEngine
{
    private const int WindowSize = 5;

    // Recency weights, newest-first; must sum to 1 for a full 5-match window (§5.2).
    private static readonly double[] BaseRecencyWeights = [0.35, 0.25, 0.20, 0.12, 0.08];

    // Progressive loss-streak curve indexed by streak length 0..5 (§5.2 Factor 1).
    private static readonly double[] StreakCurve = [0.00, 0.10, 0.35, 0.70, 0.90, 1.00];

    public async Task<TiltAssessment> AssessPlayerStateAsync(Guid userId, CancellationToken ct)
    {
        var window = await db.MatchLogs.AsNoTracking()
            .Where(m => m.UserId == userId)
            .OrderByDescending(m => m.LoggedAt)
            .Take(WindowSize)
            .Select(m => new MatchWindowEntry(m.MatchOutcome, m.PerformanceScore, m.PreMatchTiltLevel, m.PostMatchTiltLevel))
            .ToListAsync(ct);

        return Evaluate(window);
    }

    // Pure, stateless, unit-testable - no I/O. window is newest -> oldest, matching §5.1.
    internal static TiltAssessment Evaluate(IReadOnlyList<MatchWindowEntry> window)
    {
        var n = window.Count;

        if (n == 0)
        {
            return new TiltAssessment
            {
                TiltCoefficient = 0.0,
                RiskFlag = RiskFlag.Stable,
                WindowSize = 0,
                ConsecutiveLosses = 0,
                Trajectory = 0,
                RollingWinRate = 0,
                AvgPostMatchTilt = 0,
                RequiresCooldown = false,
                RecommendedCooldown = null,
            };
        }

        // ---- Factor 1: progressive loss streak (weight 0.35) ----
        var streak = 0;
        foreach (var m in window)
        {
            if (m.Outcome == MatchOutcome.Loss) streak++;
            else break;
        }
        var streakNorm = StreakCurve[Math.Min(streak, 5)];

        // ---- Factors 2 & 3: tilt trajectory (0.30) and absolute tilt level (0.20) ----
        var rw = Renormalize(BaseRecencyWeights, n);
        var trajectorySum = 0.0;
        var absoluteNorm = 0.0;
        for (var i = 0; i < n; i++)
        {
            var delta = Math.Max(0, window[i].PostTilt - window[i].PreTilt);
            trajectorySum += delta * rw[i];
            absoluteNorm += (window[i].PostTilt - 1) / 4.0 * rw[i];
        }
        var trajectoryNorm = trajectorySum / 4.0; // 4 = max possible delta (5-1)

        // ---- Factor 4: performance decay slope (weight 0.15) ----
        var oldestToNewestPerf = window.Reverse().Select(m => (double)m.PerformanceScore).ToList();
        var slope = LeastSquaresSlope(oldestToNewestPerf);
        var decayNorm = Math.Clamp(-slope / 8.0, 0.0, 1.0);

        // ---- Composite ----
        var t = 0.35 * streakNorm + 0.30 * trajectoryNorm + 0.20 * absoluteNorm + 0.15 * decayNorm;

        // ---- Hard override rules (evaluated AFTER the composite; unconditional) ----
        var overrideA = streak >= 3 && window.Take(3).Count(m => m.PostTilt >= 4) >= 2;
        var overrideB = window[0].PostTilt == 5 && (window[0].PostTilt - window[0].PreTilt) >= 2;
        if (overrideA || overrideB) t = Math.Max(t, 0.85);

        // Cold start: never lock a brand-new user off fewer than 3 data points (§5.4).
        if (n < 3) t = Math.Min(t, 0.64);

        t = Math.Round(Math.Clamp(t, 0, 1), 2);

        var flag = t switch
        {
            >= 0.85 => RiskFlag.LockRequired,
            >= 0.65 => RiskFlag.Critical,
            >= 0.40 => RiskFlag.Elevated,
            _ => RiskFlag.Stable,
        };

        var recommended = PrescribeCooldown(flag, streak);

        return new TiltAssessment
        {
            TiltCoefficient = t,
            RiskFlag = flag,
            WindowSize = n,
            ConsecutiveLosses = streak,
            Trajectory = Math.Round(trajectoryNorm * 4.0, 2),
            RollingWinRate = Math.Round(window.Count(m => m.Outcome == MatchOutcome.Win) / (double)n, 2),
            AvgPostMatchTilt = Math.Round(window.Average(m => m.PostTilt), 2),
            RequiresCooldown = flag == RiskFlag.LockRequired,
            RecommendedCooldown = recommended,
        };
    }

    // §5.3. Strategy rotation (least-used-in-session) is simplified to a fixed Breathing
    // default for this phase - see TODO in SessionService for the full rotation.
    private static RecommendedCooldown? PrescribeCooldown(RiskFlag flag, int streak)
    {
        if (flag is RiskFlag.Stable or RiskFlag.Elevated) return null;

        var mandatory = flag == RiskFlag.LockRequired;
        return new RecommendedCooldown
        {
            StrategyType = StrategyType.Breathing,
            DurationSeconds = 900,
            IsMandatory = mandatory,
        };
    }

    private static double[] Renormalize(double[] weights, int count)
    {
        var slice = weights.Take(count).ToArray();
        var sum = slice.Sum();
        return slice.Select(w => w / sum).ToArray();
    }

    // x = index (oldest=0 .. newest=|W|-1), y = perf(m).
    private static double LeastSquaresSlope(IReadOnlyList<double> yOldestToNewest)
    {
        var n = yOldestToNewest.Count;
        if (n < 2) return 0.0;

        var xMean = (n - 1) / 2.0;
        var yMean = yOldestToNewest.Average();

        double num = 0, den = 0;
        for (var i = 0; i < n; i++)
        {
            num += (i - xMean) * (yOldestToNewest[i] - yMean);
            den += (i - xMean) * (i - xMean);
        }

        return den == 0 ? 0.0 : num / den;
    }
}

public sealed record MatchWindowEntry(MatchOutcome Outcome, decimal PerformanceScore, short PreTilt, short PostTilt);
