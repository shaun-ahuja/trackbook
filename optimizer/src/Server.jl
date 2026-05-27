using HTTP
using JSON3
using StructTypes
using Dates

# Include and activate the optimizer module
include("TrackBookOptimizer.jl")
using .TrackBookOptimizer
using .TrackBookOptimizer.Types

const PORT = 2024

function handle_optimize(req::HTTP.Request)::HTTP.Response
    t0 = time()
    try
        body = String(req.body)
        @info "Optimize request received" bytes=length(body)
        matrix = JSON3.read(body, ScenarioMatrix)
        @info "Matrix parsed" plans=matrix.N scenarios=matrix.M horizon=matrix.H
        result = optimize_matrix(matrix)
        elapsed = round((time() - t0) * 1000, digits=1)
        @info "Optimize complete" status=result.solveStatus elapsed_ms=elapsed
        response_body = JSON3.write(result)
        return HTTP.Response(200, ["Content-Type" => "application/json"], response_body)
    catch e
        elapsed = round((time() - t0) * 1000, digits=1)
        msg = sprint(showerror, e, catch_backtrace())
        @error "Optimizer error" elapsed_ms=elapsed exception=msg
        return HTTP.Response(500, ["Content-Type" => "application/json"],
            JSON3.write(Dict("error" => string(e), "detail" => msg)))
    end
end

function handle_health(req::HTTP.Request)::HTTP.Response
    payload = Dict(
        "status" => "ok",
        "port" => PORT,
        "timestamp" => string(Dates.now()),
        "juliaVersion" => string(VERSION),
        "optimizerReady" => true,
    )
    return HTTP.Response(200, ["Content-Type" => "application/json"], JSON3.write(payload))
end

function router(req::HTTP.Request)::HTTP.Response
    if req.method == "POST" && req.target == "/optimize"
        return handle_optimize(req)
    elseif req.method == "GET" && req.target == "/health"
        return handle_health(req)
    else
        return HTTP.Response(404, ["Content-Type" => "application/json"],
            JSON3.write(Dict("error" => "not found", "target" => req.target)))
    end
end

function main()
    # JIT warmup — run a minimal scenario so the first real request is fast
    @info "Warming up JIT..."
    warmup_matrix = ScenarioMatrix(
        2, 3, 2, 0.97,
        [[1.2, 0.8, -0.3], [2.1, -0.5, 1.4]],
        [[2.0, 3.0, 1.0], [1.0, 2.0, 2.0]],
        [[3.0, 4.0, 2.0], [2.0, 3.0, 2.0]],
        [[0.5, 1.2, 0.3], [1.0, 0.8, 0.4]],
        [
            PlanDescriptor("PASS",  "passive_maker",  0, 0),
            PlanDescriptor("WIDEN", "risk_off_widen", 1, 1),
        ],
        ScenarioContext(3.0, 25.0, "calm", 0.72, 0.15, 48.5, 49.5),
    )
    try
        optimize_matrix(warmup_matrix)
        @info "JIT warmup complete"
    catch e
        @warn "JIT warmup failed (non-fatal)" exception = e
    end

    @info "TrackBook optimizer listening on port $PORT"
    HTTP.serve(router, "127.0.0.1", PORT)
end

main()
