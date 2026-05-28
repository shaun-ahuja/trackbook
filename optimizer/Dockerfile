FROM julia:1.11

WORKDIR /app

COPY Project.toml Manifest.toml ./

RUN julia --project=. -e "using Pkg; Pkg.instantiate(); Pkg.precompile()"

COPY src/ src/

ENV JULIA_HOST=0.0.0.0
ENV PORT=2024

EXPOSE 2024

CMD ["julia", "--project=.", "src/Server.jl"]
