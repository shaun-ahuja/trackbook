FROM julia:1.11

WORKDIR /app

COPY . .

ENV JULIA_HOST=0.0.0.0
ENV PORT=2024
ENV JULIA_DEPOT_PATH=/tmp/julia-depot

EXPOSE 2024

CMD ["sh", "-c", "julia --project=. -e 'using Pkg; Pkg.instantiate()' && julia --project=. src/Server.jl"]
