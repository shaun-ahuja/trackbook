module RolloutStats

using Statistics
using ..Types

export compute_stats, cvar_at_alpha

# CVaR (expected shortfall) at tail fraction α over a vector of returns.
# Returns the expected loss in the worst α fraction of outcomes.
# Defined as E[R | R ≤ q_α], negated so a higher cvar means more tail loss.
function cvar_at_alpha(returns::Vector{Float64}, α::Float64 = 0.10)::Float64
    n = length(returns)
    if n == 0
        return 0.0
    end
    sorted = sort(returns)
    k = max(1, floor(Int, α * n))
    return -mean(sorted[1:k])
end

function compute_stats(matrix::ScenarioMatrix, α::Float64 = 0.10)::Vector{TrajectoryStats}
    stats = TrajectoryStats[]
    for n in 1:matrix.N
        R_n = matrix.R[n]
        inv_n = matrix.invFinal[n]
        plan = matrix.plans[n]

        μ = mean(R_n)
        σ = length(R_n) > 1 ? std(R_n) : 0.0
        cvar = cvar_at_alpha(R_n, α)

        # Fill probability: fraction of trajectories where |inv| changed (a fill occurred).
        # Since we don't track fills directly, approximate from inventory change.
        fill_prob = count(abs(v) > 0 for v in inv_n) / length(inv_n)

        push!(stats, TrajectoryStats(
            n - 1,  # zero-indexed for TypeScript consumption
            plan.firstAction,
            plan.policyName,
            μ,
            σ,
            cvar,
            fill_prob,
            mean(inv_n),
        ))
    end
    return stats
end

end # module
