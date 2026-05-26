module RiskSelection

using JuMP
using HiGHS
const MOI = JuMP.MOI
using LinearAlgebra
using Statistics
using ..Types

export jump_cvar_select, greedy_select

# Groups of plan indices (0-indexed) by first action and policy name.
# Used to build regime-conditional constraints.
function plan_indices_where(plans::Vector{PlanDescriptor}, pred)::Vector{Int}
    return [i for (i, p) in enumerate(plans) if pred(p)]
end

# JuMP CVaR-constrained LP over the scenario matrix.
# Maximises expected mixed return subject to:
#   - CVaR tail risk limit (α=0.10)
#   - Expected final inventory bounds
#   - Regime-conditional suppression of aggressive / high-risk plans
#
# Returns (selected_plan_1indexed, mixing_weights, binding_constraints, solve_status).
function jump_cvar_select(
    matrix::ScenarioMatrix;
    α::Float64 = 0.10,
    ρ_max::Float64 = 50.0,  # max CVaR loss tolerance; permissive so LP stays feasible, named constraints do the work
)
    N = matrix.N
    M = matrix.M
    plans = matrix.plans
    ctx = matrix.context

    # Build N×M return matrix from nested vectors
    R = hcat([matrix.R[n] for n in 1:N]...)'   # shape [N, M]
    inv_final = hcat([matrix.invFinal[n] for n in 1:N]...)'  # shape [N, M]

    mean_R = vec(mean(R, dims=2))  # [N]

    model = Model(HiGHS.Optimizer)
    set_silent(model)

    @variable(model, w[1:N] >= 0)   # mixing weights
    @variable(model, η)              # CVaR threshold
    @variable(model, u[1:M] >= 0)   # CVaR excess slack

    @objective(model, Max, dot(w, mean_R))

    # Convex combination over plans
    @constraint(model, sum(w) == 1, base_name = "plan_mixture")

    # CVaR linearisation: mixed portfolio return on each trajectory
    @expression(model, port_return[m = 1:M], sum(w[n] * R[n, m] for n in 1:N))
    @constraint(model, [m = 1:M], u[m] >= η - port_return[m], base_name = "cvar_excess")

    # CVaR risk constraint: E[loss in worst α fraction] ≤ ρ_max
    @constraint(model, η - 1 / (α * M) * sum(u) >= -ρ_max, base_name = "cvar_risk_limit")

    # Expected final inventory within bounds
    mean_inv = vec(mean(inv_final, dims=2))  # [N]
    @constraint(model, dot(w, mean_inv) <=  ctx.maxInventory, base_name = "inv_long_limit")
    @constraint(model, dot(w, mean_inv) >= -ctx.maxInventory, base_name = "inv_short_limit")

    # --- Regime-conditional constraints ---

    aggr_actions = Set(["AGG_BUY", "AGG_SELL"])
    aggr_plan_idx = plan_indices_where(plans, p -> p.firstAction in aggr_actions)

    if ctx.regime == "shock" && !isempty(aggr_plan_idx)
        @constraint(model, sum(w[i] for i in aggr_plan_idx) <= 0.05,
            base_name = "shock_aggr_limit")
    end

    edge_following_idx = plan_indices_where(plans, p -> p.policyName == "edge_following")
    if ctx.regime in ("shock", "alert") && ctx.forecastConfidence < 0.6 && !isempty(edge_following_idx)
        @constraint(model, sum(w[i] for i in edge_following_idx) <= 0.10,
            base_name = "low_conf_aggr_limit")
    end

    # Near inventory limit: suppress plans that worsen the imbalance
    abs_inv = abs(ctx.currentInventory)
    if abs_inv >= 0.75 * ctx.maxInventory
        buy_actions = Set(["AGG_BUY", "SKEW_BID", "LIFT"])
        sell_actions = Set(["AGG_SELL", "SKEW_ASK", "HIT"])
        # Long → suppress further buying; short → suppress further selling
        if ctx.currentInventory > 0
            worsening = plan_indices_where(plans, p -> p.firstAction in buy_actions)
        else
            worsening = plan_indices_where(plans, p -> p.firstAction in sell_actions)
        end
        for idx in worsening
            @constraint(model, w[idx] <= 0.02, base_name = "inventory_skew_$(idx)")
        end
    end

    if ctx.adverseSelectionScore > 0.6
        tight_actions = Set(["TIGHTEN", "AGG_BUY", "AGG_SELL"])
        tight_idx = plan_indices_where(plans, p -> p.firstAction in tight_actions)
        if !isempty(tight_idx)
            @constraint(model, sum(w[i] for i in tight_idx) <= 0.05,
                base_name = "adverse_sel_limit")
        end
    end

    optimize!(model)

    status = string(termination_status(model))

    # Guard: if solver found no solution (INFEASIBLE / INFEASIBLE_OR_UNBOUNDED
    # / NUMERICAL_ERROR etc.) fall back to greedy immediately rather than
    # crashing when trying to read variable values from an empty model.
    if !(termination_status(model) in [MOI.OPTIMAL, MOI.ALMOST_OPTIMAL, MOI.LOCALLY_SOLVED])
        return (greedy_select(matrix), ones(N) ./ N, BindingConstraint[], "GREEDY_FALLBACK")
    end

    w_val = value.(w)

    # Detect binding constraints via non-zero dual values (LP shadow prices)
    binding = BindingConstraint[]
    interpretations = Dict(
        "cvar_risk_limit"    => "CVaR constraint binds — tail-risk control costs mean return",
        "inv_long_limit"     => "Long inventory limit reached — inventory-increasing plans suppressed",
        "inv_short_limit"    => "Short inventory limit reached — inventory-decreasing plans suppressed",
        "shock_aggr_limit"   => "Shock regime suppresses aggressive first actions",
        "low_conf_aggr_limit" => "Low confidence restricts edge-following continuation",
        "adverse_sel_limit"  => "High adverse selection score suppresses tight/aggressive plans",
    )
    for (F, S) in list_of_constraint_types(model)
        for con in all_constraints(model, F, S)
            cname = JuMP.name(con)
            isempty(cname) && continue
            startswith(cname, "cvar_excess") && continue  # scalar per-trajectory, not interesting
            try
                dv = dual(con)
                if abs(dv) > 1e-6
                    interp = get(interpretations, cname, "binding at optimum")
                    push!(binding, BindingConstraint(cname, dv, interp))
                end
            catch
            end
        end
    end

    selected = argmax(w_val)
    return (selected, w_val, binding, status)
end

# Greedy fallback: select the plan with highest mean return.
# Used as a deterministic baseline when JuMP is unavailable.
function greedy_select(matrix::ScenarioMatrix)::Int
    best = 1
    best_mean = -Inf
    for n in 1:matrix.N
        μ = sum(matrix.R[n]) / length(matrix.R[n])
        if μ > best_mean
            best_mean = μ
            best = n
        end
    end
    return best
end

end # module
