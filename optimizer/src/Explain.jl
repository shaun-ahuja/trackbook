module Explain

using Printf
using Statistics
using ..Types
using ..RolloutStats

export build_explanation

function build_explanation(
    matrix::ScenarioMatrix,
    selected_n::Int,
    stats::Vector{TrajectoryStats},
    binding::Vector{BindingConstraint},
    w::Vector{Float64},
)::String
    plan = matrix.plans[selected_n]
    s = stats[selected_n]
    ctx = matrix.context

    lines = String[]

    # ── Header: market state at the time of the decision ─────────────────────
    inv = ctx.currentInventory
    inv_str = if abs(inv) < 0.5
        "FLAT"
    elseif inv > 0
        @sprintf("LONG %.0f/%.0f", inv, ctx.maxInventory)
    else
        @sprintf("SHORT %.0f/%.0f", abs(inv), ctx.maxInventory)
    end
    regime_str = uppercase(ctx.regime)
    conf_str = @sprintf("%.0f%% conf", ctx.forecastConfidence * 100)
    push!(lines, @sprintf("%s · %s · %s", regime_str, inv_str, conf_str))

    # ── Layer 1: statistical summary ─────────────────────────────────────────
    push!(lines, @sprintf(
        "▶ %s + %s",
        plan.firstAction, plan.policyName,
    ))
    push!(lines, @sprintf(
        "  μ=%.2f  σ=%.2f  CVaR₁₀%%=%.2f  fill=%.0f%%",
        s.meanReturn, s.stdReturn, s.cvarReturn, s.fillProbability * 100,
    ))

    # ── Layer 2: binding constraints (narrative, no raw dual) ─────────────────
    active_binding = filter(
        b -> b.name != "plan_mixture" && !startswith(b.name, "cvar_excess"),
        binding,
    )
    if !isempty(active_binding)
        push!(lines, "")
        push!(lines, "CONSTRAINTS:")
        for b in active_binding
            push!(lines, @sprintf("  ⚑ %s", b.interpretation))
        end
    end

    # ── Layer 3: one-liner policy rationale ──────────────────────────────────
    push!(lines, "")
    push!(lines, policy_rationale(plan.policyName, ctx, s, active_binding))

    # ── Top-3 mixing distribution ─────────────────────────────────────────────
    top_n = min(3, length(w))
    sorted_idx = sortperm(w, rev = true)[1:top_n]
    if any(w[i] > 0.01 for i in sorted_idx)
        push!(lines, "")
        push!(lines, "MIX:")
        for i in sorted_idx
            w[i] <= 0.01 && continue
            p = matrix.plans[i]
            push!(lines, @sprintf("  %4.1f%%  %s + %s", w[i] * 100, p.firstAction, p.policyName))
        end
    end

    return join(lines, "\n")
end

function policy_rationale(
    policy_name::String,
    ctx::ScenarioContext,
    s::TrajectoryStats,
    binding::Vector{BindingConstraint},
)::String
    inv = ctx.currentInventory
    max_inv = ctx.maxInventory
    conf = ctx.forecastConfidence
    regime = ctx.regime
    adverse = ctx.adverseSelectionScore

    has_shock = any(b -> b.name == "shock_aggr_limit", binding)
    has_cvar  = any(b -> b.name == "cvar_risk_limit",  binding)
    has_inv   = any(b -> startswith(b.name, "inventory_skew") || b.name in ("inv_long_limit", "inv_short_limit"), binding)

    if policy_name == "passive_maker"
        if has_cvar
            return @sprintf(
                "Tail risk dominant: CVaR constraint limits upside. Passive maker minimises tail exposure at %.2f expected return.",
                s.meanReturn,
            )
        end
        return @sprintf(
            "Neutral baseline: resting maker quotes at ±1 tick. %.0f%% confidence supports holding edge without over-committing.",
            conf * 100,
        )
    elseif policy_name == "risk_off_widen"
        reason = if regime == "shock"
            "Shock regime: defensive wide quotes protect against adverse tail fills."
        elseif has_shock
            "Shock constraint active: aggressive plans capped at 5%. Widened spreads reduce fill exposure."
        else
            "Risk-off: conservative anchor. Wide quotes (+/-2 ticks) reduce fill rate but cap downside."
        end
        return reason
    elseif policy_name == "inv_mean_reversion"
        return @sprintf(
            "Inventory skew: position %.0f/%.0f drives quote bias toward reducing exposure. Mean-reverting continuation targets flat within horizon.",
            inv, max_inv,
        )
    elseif policy_name == "edge_following"
        if has_shock
            return "Edge-following suppressed by shock constraint — weight capped."
        end
        return @sprintf(
            "Edge capture: %.0f%% confidence unlocks aggressive continuation. Edge-following targets %.2f expected return across trajectory.",
            conf * 100, s.meanReturn,
        )
    elseif policy_name == "shock_defensive"
        return @sprintf(
            "Shock-defensive continuation: wide quotes + flatten at 60%% inv limit. Regime=%s, protecting %.0f%% of capacity.",
            regime, (1 - abs(inv) / max_inv) * 100,
        )
    elseif policy_name == "flatten_on_threshold"
        return @sprintf(
            "Hard inventory discipline: flatten above 70%% of limit (current=%.0f/%.0f = %.0f%%). Position risk over edge.",
            abs(inv), max_inv, abs(inv) / max_inv * 100,
        )
    else
        return @sprintf("Policy: %s  (μ=%.2f, CVaR=%.2f)", policy_name, s.meanReturn, s.cvarReturn)
    end
end

end # module
