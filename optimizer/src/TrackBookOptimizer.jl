module TrackBookOptimizer

include("Types.jl")
include("RolloutStats.jl")
include("RiskSelection.jl")
include("Explain.jl")

using .Types
using .RolloutStats
using .RiskSelection
using .Explain

export optimize_matrix

# Main entry point: receives a ScenarioMatrix, runs the CVaR-constrained JuMP
# optimizer, and returns a fully populated OptimizeResponse.
function optimize_matrix(matrix::ScenarioMatrix)::OptimizeResponse
    t0 = time()

    α = 0.10
    stats = compute_stats(matrix, α)

    selected_n, w_val, binding, status = jump_cvar_select(matrix; α = α)

    # If JuMP failed (infeasible / unbounded), fall back to greedy argmax
    if status ∉ ("OPTIMAL", "LOCALLY_SOLVED")
        selected_n = greedy_select(matrix)
        w_val = zeros(Float64, matrix.N)
        w_val[selected_n] = 1.0
        binding = BindingConstraint[]
        status = "GREEDY_FALLBACK"
    end

    plan = matrix.plans[selected_n]

    mixing = [
        PlanWeight(
            n - 1,  # zero-indexed for TypeScript
            matrix.plans[n].firstAction,
            matrix.plans[n].policyName,
            w_val[n],
        )
        for n in 1:matrix.N if w_val[n] > 1e-4
    ]
    sort!(mixing, by = x -> -x.weight)

    explanation = build_explanation(matrix, selected_n, stats, binding, w_val)
    duration_ms = (time() - t0) * 1000.0

    return OptimizeResponse(
        selected_n - 1,  # zero-indexed
        plan.firstAction,
        plan.policyName,
        mixing,
        stats,
        binding,
        explanation,
        status,
        duration_ms,
    )
end

end # module
