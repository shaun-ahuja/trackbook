module Types

using StructTypes

export PlanDescriptor, ScenarioContext, ScenarioMatrix
export OptimizeResponse, TrajectoryStats, PlanWeight, BindingConstraint

struct PlanDescriptor
    firstAction::String
    policyName::String
    firstActionIndex::Int
    policyIndex::Int
end

struct ScenarioContext
    currentInventory::Float64
    maxInventory::Float64
    regime::String
    forecastConfidence::Float64
    adverseSelectionScore::Float64
    bestBidTicks::Float64
    bestAskTicks::Float64
end

# Stable scenario tensor contract — the only interface between the rollout
# engine (TypeScript now, C++ later) and the Julia optimizer.
struct ScenarioMatrix
    N::Int
    M::Int
    H::Int
    gamma::Float64
    R::Vector{Vector{Float64}}          # [N][M] discounted returns
    invFinal::Vector{Vector{Float64}}   # [N][M] final inventory
    maxAbsInv::Vector{Vector{Float64}}  # [N][M] max |inv| over trajectory
    maxDrawdown::Vector{Vector{Float64}} # [N][M] max drawdown over trajectory
    plans::Vector{PlanDescriptor}
    context::ScenarioContext
end

struct TrajectoryStats
    planIndex::Int
    firstAction::String
    policyName::String
    meanReturn::Float64
    stdReturn::Float64
    cvarReturn::Float64
    fillProbability::Float64
    meanInvFinal::Float64
end

struct PlanWeight
    planIndex::Int
    firstAction::String
    policyName::String
    weight::Float64
end

struct BindingConstraint
    name::String
    dualValue::Float64
    interpretation::String
end

struct OptimizeResponse
    selectedPlanIndex::Int
    selectedFirstAction::String
    selectedPolicyName::String
    mixingDistribution::Vector{PlanWeight}
    trajectoryStats::Vector{TrajectoryStats}
    bindingConstraints::Vector{BindingConstraint}
    explanation::String
    solveStatus::String
    solveDurationMs::Float64
end

# StructTypes for JSON3 serialisation
StructTypes.StructType(::Type{PlanDescriptor}) = StructTypes.Struct()
StructTypes.StructType(::Type{ScenarioContext}) = StructTypes.Struct()
StructTypes.StructType(::Type{ScenarioMatrix}) = StructTypes.Struct()
StructTypes.StructType(::Type{TrajectoryStats}) = StructTypes.Struct()
StructTypes.StructType(::Type{PlanWeight}) = StructTypes.Struct()
StructTypes.StructType(::Type{BindingConstraint}) = StructTypes.Struct()
StructTypes.StructType(::Type{OptimizeResponse}) = StructTypes.Struct()

end # module
