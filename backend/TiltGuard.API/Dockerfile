# syntax=docker/dockerfile:1
#
# Build context is `backend/`, not this directory — the COPY paths below are
# relative to the solution root so a second project can be added without
# rewriting this file:
#
#   docker build -f TiltGuard.API/Dockerfile .
#
# docker-compose.prod.yml wires that up already.

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src

# Restore on its own layer, from the project file alone. Source churns on every
# commit while the dependency graph rarely moves, so this layer stays cached
# across most builds.
COPY ["TiltGuard.API/TiltGuard.API.csproj", "TiltGuard.API/"]
RUN dotnet restore "TiltGuard.API/TiltGuard.API.csproj"

COPY . .

# --no-restore is safe only because .dockerignore excludes bin/ and obj/: the
# COPY above would otherwise drop the host's build artifacts on top of the
# restore we just did, and publish would fail on a stale or foreign-RID asset
# file. That exclusion is load-bearing, not tidiness.
RUN dotnet publish "TiltGuard.API/TiltGuard.API.csproj" \
    -c "$BUILD_CONFIGURATION" \
    -o /app/publish \
    --no-restore \
    /p:UseAppHost=false

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime

# curl backs the HEALTHCHECK below; the aspnet image ships neither curl nor
# wget. Installed here, as root, before the USER switch.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/publish .

# Only HTTP is bound. TLS terminates at the reverse proxy in front of this
# container, which is also why ASPNETCORE_HTTPS_PORTS is left unset: setting it
# would make UseHttpsRedirection start 307-ing plain-HTTP requests, and the
# health probe below is a plain-HTTP request.
ENV ASPNETCORE_ENVIRONMENT=Production \
    ASPNETCORE_HTTP_PORTS=8080

# 8080 = HTTP (bound). 8081 = the conventional HTTPS port, declared so an
# operator terminating TLS in-container can bind it after mounting a cert.
EXPOSE 8080
EXPOSE 8081

# APP_UID (1654) is defined by the base image; the matching non-root `app` user
# and its home directory already exist. Nothing above this line is writable by
# it, so the published output cannot be modified at runtime.
USER $APP_UID

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["dotnet", "TiltGuard.API.dll"]
