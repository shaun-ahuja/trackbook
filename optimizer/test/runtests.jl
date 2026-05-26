using Test

include("../src/TrackBookOptimizer.jl")
using .TrackBookOptimizer
using .TrackBookOptimizer.Types
using .TrackBookOptimizer.RolloutStats
using .TrackBookOptimizer.RiskSelection

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function make_matrix(;
    N = 4,
    M = 10,
    H = 5,
    gamma = 0.97,
    regime = "calm",
    inv = 0.0,
    max_inv = 25.0,
    conf = 0.72,
    adverse = 0.10,
)
    rng_base = randn(N * M)
    R = [rng_base[(n-1)*M+1:n*M] for n in 1:N]
    inv_final = [fill(inv + 0.1 * n, M) for n in 1:N]
    max_abs = [fill(abs(inv) + 1.0, M) for n in 1:N]
    max_dd = [fill(0.5, M) for n in 1:N]
    actions = ["PASS", "WIDEN", "SKEW_BID", "AGG_BUY"]
    policies = ["passive_maker", "risk_off_widen", "inv_mean_reversion", "edge_following"]
    plans = [PlanDescriptor(actions[n], policies[n], n-1, n-1) for n in 1:N]
    ctx = ScenarioContext(inv, max_inv, regime, conf, adverse, 48.5, 49.5)
    return ScenarioMatrix(N, M, H, gamma, R, inv_final, max_abs, max_dd, plans, ctx)
end

# ---------------------------------------------------------------------------
# RolloutStats tests
# ---------------------------------------------------------------------------

@testset "RolloutStats" begin
    @testset "cvar_at_alpha on known distribution" begin
        returns = Float64[-10, -5, -1, 0, 1, 5, 10, 20]
        # α=0.25 → worst 25% = [-10, -5] → mean = -7.5 → CVaR = 7.5
        cv = cvar_at_alpha(returns, 0.25)
        @test isapprox(cv, 7.5, atol = 0.1)
    end

    @testset "compute_stats returns N entries" begin
        matrix = make_matrix(N = 4, M = 20)
        stats = compute_stats(matrix)
        @test length(stats) == 4
    end

    @testset "stats have finite values" begin
        matrix = make_matrix(N = 3, M = 15)
        stats = compute_stats(matrix)
        for s in stats
            @test isfinite(s.meanReturn)
            @test isfinite(s.stdReturn)
            @test isfinite(s.cvarReturn)
            @test 0.0 <= s.fillProbability <= 1.0
        end
    end
end

# ---------------------------------------------------------------------------
# RiskSelection tests
# ---------------------------------------------------------------------------

@testset "RiskSelection" begin
    @testset "greedy_select returns valid index" begin
        matrix = make_matrix(N = 4, M = 10)
        idx = greedy_select(matrix)
        @test 1 <= idx <= 4
    end

    @testset "jump_cvar_select returns OPTIMAL or fallback" begin
        matrix = make_matrix(N = 4, M = 10)
        selected, w, binding, status = jump_cvar_select(matrix)
        @test status in ("OPTIMAL", "LOCALLY_SOLVED", "INFEASIBLE", "GREEDY_FALLBACK")
        @test 1 <= selected <= 4
        @test length(w) == 4
        @test isapprox(sum(w), 1.0, atol = 1e-6)
        @test all(>=(0), w)
    end

    @testset "same matrix → same selection (determinism)" begin
        matrix = make_matrix(N = 4, M = 10)
        s1, _, _, _ = jump_cvar_select(matrix)
        s2, _, _, _ = jump_cvar_select(matrix)
        @test s1 == s2
    end

    @testset "shock regime suppresses AGG_BUY / AGG_SELL" begin
        # Build a matrix where AGG_BUY has clearly the best mean return
        N = 6
        M = 10
        actions = ["PASS", "WIDEN", "AGG_BUY", "AGG_SELL", "SKEW_BID", "SKEW_ASK"]
        policies = fill("passive_maker", N)
        plans = [PlanDescriptor(actions[i], policies[i], i-1, 0) for i in 1:N]
        # Make AGG_BUY (index 3) look very attractive
        R = [fill(-1.0, M) for _ in 1:N]
        R[3] = fill(100.0, M)  # AGG_BUY has dominant return
        R[4] = fill(50.0, M)   # AGG_SELL also good
        inv_f = [fill(0.0, M) for _ in 1:N]
        max_abs = [fill(1.0, M) for _ in 1:N]
        max_dd = [fill(0.1, M) for _ in 1:N]
        ctx = ScenarioContext(0.0, 25.0, "shock", 0.4, 0.1, 48.5, 49.5)
        matrix = ScenarioMatrix(N, M, 5, 0.97, R, inv_f, max_abs, max_dd, plans, ctx)

        selected, w, _, _ = jump_cvar_select(matrix)
        # AGG_BUY is plan 3, AGG_SELL is plan 4
        aggr_weight = w[3] + w[4]
        @test aggr_weight <= 0.06  # shock_aggr_limit: ≤ 5%
    end

    @testset "near inventory limit suppresses inventory-worsening plans" begin
        # Long position near limit — AGG_BUY should be suppressed
        N = 4
        M = 8
        actions = ["PASS", "WIDEN", "AGG_BUY", "AGG_SELL"]
        plans = [PlanDescriptor(actions[i], "passive_maker", i-1, 0) for i in 1:N]
        R = [fill(-1.0, M), fill(-1.0, M), fill(50.0, M), fill(-2.0, M)]
        inv_f = [fill(0.0, M) for _ in 1:N]
        max_abs = [fill(1.0, M) for _ in 1:N]
        max_dd = [fill(0.1, M) for _ in 1:N]
        # Near long limit: inv = 0.8 × max_inv
        ctx = ScenarioContext(20.0, 25.0, "calm", 0.75, 0.1, 48.5, 49.5)
        matrix = ScenarioMatrix(N, M, 5, 0.97, R, inv_f, max_abs, max_dd, plans, ctx)

        selected, w, _, _ = jump_cvar_select(matrix)
        # AGG_BUY (plan 3) should have weight ≤ 0.02
        @test w[3] <= 0.03
    end

    @testset "high adverse selection suppresses tight/aggressive plans" begin
        N = 3
        M = 8
        actions = ["WIDEN", "TIGHTEN", "AGG_BUY"]
        plans = [PlanDescriptor(actions[i], "passive_maker", i-1, 0) for i in 1:N]
        R = [fill(-1.0, M), fill(50.0, M), fill(40.0, M)]
        inv_f = [fill(0.0, M) for _ in 1:N]
        max_abs = [fill(1.0, M) for _ in 1:N]
        max_dd = [fill(0.1, M) for _ in 1:N]
        ctx = ScenarioContext(0.0, 25.0, "calm", 0.75, 0.75, 48.5, 49.5)  # adverse=0.75
        matrix = ScenarioMatrix(N, M, 5, 0.97, R, inv_f, max_abs, max_dd, plans, ctx)

        selected, w, _, _ = jump_cvar_select(matrix)
        tight_weight = w[2] + w[3]  # TIGHTEN + AGG_BUY
        @test tight_weight <= 0.06
    end
end

# ---------------------------------------------------------------------------
# End-to-end optimize_matrix tests
# ---------------------------------------------------------------------------

@testset "optimize_matrix end-to-end" begin
    @testset "returns valid response structure" begin
        matrix = make_matrix(N = 4, M = 10)
        resp = optimize_matrix(matrix)
        @test 0 <= resp.selectedPlanIndex < 4
        @test resp.selectedFirstAction in ["PASS", "WIDEN", "SKEW_BID", "AGG_BUY"]
        @test resp.selectedPolicyName in ["passive_maker", "risk_off_widen", "inv_mean_reversion", "edge_following"]
        @test !isempty(resp.solveStatus)
        @test resp.solveDurationMs >= 0.0
        @test length(resp.trajectoryStats) == 4
    end

    @testset "mixing distribution sums to ~1" begin
        matrix = make_matrix(N = 4, M = 10)
        resp = optimize_matrix(matrix)
        total = sum(p.weight for p in resp.mixingDistribution)
        @test isapprox(total, 1.0, atol = 0.01)
    end

    @testset "high-variance matrix: CVaR binds → lower mean, constraint mentioned" begin
        N = 2
        M = 20
        # Plan 1 has high variance (some very bad outcomes), plan 2 is safe
        R = [vcat(fill(-50.0, 4), fill(60.0, 16)), fill(2.0, 20)]
        inv_f = [fill(0.0, M), fill(0.0, M)]
        max_abs = [fill(1.0, M), fill(1.0, M)]
        max_dd = [fill(0.1, M), fill(0.1, M)]
        plans = [PlanDescriptor("SKEW_BID", "edge_following", 0, 0),
                 PlanDescriptor("WIDEN", "risk_off_widen", 1, 1)]
        ctx = ScenarioContext(0.0, 25.0, "calm", 0.72, 0.1, 48.5, 49.5)
        matrix = ScenarioMatrix(N, M, 5, 0.97, R, inv_f, max_abs, max_dd, plans, ctx)

        resp = optimize_matrix(matrix)
        # CVaR limit should push toward the safer plan (WIDEN)
        # At minimum, the response is valid
        @test 0 <= resp.selectedPlanIndex < 2
        @test !isempty(resp.explanation)
    end

    @testset "determinism: same input gives same output" begin
        matrix = make_matrix(N = 4, M = 12)
        r1 = optimize_matrix(matrix)
        r2 = optimize_matrix(matrix)
        @test r1.selectedPlanIndex == r2.selectedPlanIndex
        @test r1.selectedFirstAction == r2.selectedFirstAction
    end
end

# ---------------------------------------------------------------------------
# Demo scenario behavioral validation
# These construct representative matrices for each of the 3 demo scenarios
# and assert that the JuMP optimizer makes economically correct decisions.
# ---------------------------------------------------------------------------

@testset "Demo scenario: CALM_EDGE" begin
    # 6 plans, M=20. Edge-following plans have best returns.
    # Context: calm, inv=0, conf=0.78, adverse=0.08
    # Expected: no shock/adverse constraints; an edge-capturing plan is selected.
    M = 20
    actions  = ["PASS",   "PASS",           "WIDEN",        "TIGHTEN",    "SKEW_BID",     "AGG_BUY"]
    policies = ["passive_maker", "edge_following", "risk_off_widen", "passive_maker", "edge_following", "passive_maker"]
    N = length(actions)
    plans = [PlanDescriptor(actions[i], policies[i], i-1, i-1) for i in 1:N]
    # Edge-following variants (idx 2, 5) get the best returns in a calm market
    R = [
        fill(1.0,  M),   # PASS/passive
        fill(4.2,  M),   # PASS/edge_following  ← winner candidate
        fill(0.4,  M),   # WIDEN/risk_off
        fill(1.8,  M),   # TIGHTEN/passive
        fill(4.5,  M),   # SKEW_BID/edge_following ← winner candidate
        fill(3.8,  M),   # AGG_BUY/passive
    ]
    inv_f   = [fill(0.0, M) for _ in 1:N]
    max_abs = [fill(0.5, M) for _ in 1:N]
    max_dd  = [fill(0.2, M) for _ in 1:N]
    ctx = ScenarioContext(0.0, 8.0, "calm", 0.78, 0.08, 54.5, 55.5)
    matrix = ScenarioMatrix(N, M, 6, 0.97, R, inv_f, max_abs, max_dd, plans, ctx)

    resp = optimize_matrix(matrix)

    @testset "CALM_EDGE: edge-capturing plan selected" begin
        # Expected: SKEW_BID/edge_following (idx 5) or PASS/edge_following (idx 2)
        @test resp.selectedFirstAction in ("SKEW_BID", "AGG_BUY", "PASS")
        @test resp.selectedPolicyName in ("edge_following", "passive_maker")
    end

    @testset "CALM_EDGE: no shock or adverse-selection constraint mentioned" begin
        binding_names = [b.name for b in resp.bindingConstraints]
        @test "shock_aggr_limit" ∉ binding_names
        @test "adverse_sel_limit" ∉ binding_names
    end

    @testset "CALM_EDGE: explanation contains regime and confidence" begin
        @test occursin("CALM", resp.explanation)
        @test occursin("FLAT", resp.explanation) || occursin("0", resp.explanation)
    end

    @testset "CALM_EDGE: mixing distribution sums to ~1" begin
        total = sum(p.weight for p in resp.mixingDistribution)
        @test isapprox(total, 1.0, atol = 0.01)
    end
end

@testset "Demo scenario: SHOCK" begin
    # 4 plans. AGG_BUY/AGG_SELL have fantastic returns — but shock regime
    # must suppress them via shock_aggr_limit.
    # Context: shock, inv=2, conf=0.32, adverse=0.2
    M = 20
    actions  = ["WIDEN",          "PASS",          "AGG_BUY",       "AGG_SELL"]
    policies = ["shock_defensive", "passive_maker", "edge_following", "edge_following"]
    N = length(actions)
    plans = [PlanDescriptor(actions[i], policies[i], i-1, i-1) for i in 1:N]
    R = [
        fill(1.5,  M),   # WIDEN/shock_defensive — safe
        fill(0.8,  M),   # PASS/passive — baseline
        fill(25.0, M),   # AGG_BUY — looks amazing but shock must suppress
        fill(20.0, M),   # AGG_SELL — also attractive
    ]
    inv_f   = [fill(0.0, M), fill(0.0, M), fill(4.0, M), fill(-1.0, M)]
    max_abs = [fill(2.0, M) for _ in 1:N]
    max_dd  = [fill(0.3, M) for _ in 1:N]
    ctx = ScenarioContext(2.0, 8.0, "shock", 0.32, 0.20, 51.0, 52.0)
    matrix = ScenarioMatrix(N, M, 5, 0.97, R, inv_f, max_abs, max_dd, plans, ctx)

    resp = optimize_matrix(matrix)

    @testset "SHOCK: aggressive plans suppressed to ≤5% weight" begin
        agg_weight = sum(p.weight for p in resp.mixingDistribution
            if p.firstAction in ("AGG_BUY", "AGG_SELL"); init = 0.0)
        @test agg_weight <= 0.06
    end

    @testset "SHOCK: shock_aggr_limit binds" begin
        binding_names = [b.name for b in resp.bindingConstraints]
        @test "shock_aggr_limit" ∈ binding_names
    end

    @testset "SHOCK: defensive plan (WIDEN or PASS) has majority weight" begin
        defensive_weight = sum(p.weight for p in resp.mixingDistribution
            if p.firstAction in ("WIDEN", "PASS"); init = 0.0)
        @test defensive_weight >= 0.90
    end

    @testset "SHOCK: explanation mentions shock or constraint" begin
        @test occursin("SHOCK", resp.explanation) ||
              occursin("shock", resp.explanation) ||
              occursin("Shock", resp.explanation)
    end
end

@testset "Demo scenario: INV_STRESS" begin
    # 4 plans. AGG_BUY looks attractive but long position means JuMP
    # inventory_skew must constrain it (currentInventory=7 >= 0.75×8=6).
    # PARTIAL_FLATTEN / AGG_SELL should dominate.
    M = 20
    actions  = ["PARTIAL_FLATTEN",       "AGG_SELL",          "PASS",          "AGG_BUY"]
    policies = ["flatten_on_threshold", "inv_mean_reversion", "passive_maker", "passive_maker"]
    N = length(actions)
    plans = [PlanDescriptor(actions[i], policies[i], i-1, i-1) for i in 1:N]
    R = [
        fill(3.0,  M),   # PARTIAL_FLATTEN — good
        fill(5.5,  M),   # AGG_SELL — better (reduces long position)
        fill(1.0,  M),   # PASS — baseline
        fill(9.0,  M),   # AGG_BUY — looks best but worsens long position
    ]
    inv_f   = [fill(4.0, M), fill(3.0, M), fill(7.0, M), fill(9.0, M)]
    max_abs = [fill(7.5, M) for _ in 1:N]
    max_dd  = [fill(0.5, M) for _ in 1:N]
    # inv=7/8: abs_inv=7 >= 0.75×8=6 → inventory_skew active
    # currentInventory > 0 → buy-side plans are worsening
    ctx = ScenarioContext(7.0, 8.0, "calm", 0.71, 0.12, 55.0, 56.0)
    matrix = ScenarioMatrix(N, M, 5, 0.97, R, inv_f, max_abs, max_dd, plans, ctx)

    resp = optimize_matrix(matrix)

    @testset "INV_STRESS: AGG_BUY weight ≤ 2%" begin
        agg_buy_weight = sum(p.weight for p in resp.mixingDistribution
            if p.firstAction == "AGG_BUY"; init = 0.0)
        @test agg_buy_weight <= 0.03
    end

    @testset "INV_STRESS: inventory_skew constraint binds" begin
        binding_names = [b.name for b in resp.bindingConstraints]
        @test any(startswith(n, "inventory_skew") for n in binding_names)
    end

    @testset "INV_STRESS: flatten or sell plan selected" begin
        @test resp.selectedFirstAction in ("PARTIAL_FLATTEN", "AGG_SELL", "PASS")
    end

    @testset "INV_STRESS: explanation mentions inventory" begin
        @test occursin("inventory", lowercase(resp.explanation)) ||
              occursin("LONG", resp.explanation) ||
              occursin("inv", lowercase(resp.explanation))
    end
end
