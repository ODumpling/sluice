# .NET SDK image: the app is compiled from the mounted ./src at container start
# (so the gate can swap sources per run). Packages are restored here and build
# output goes to /app/artifacts, never into the read-only sources.
FROM mcr.microsoft.com/dotnet/sdk:10.0
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_GENERATE_ASPNET_CERTIFICATE=false DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=1 \
    NUGET_XMLDOC_MODE=skip MSBUILDDISABLENODEREUSE=1 \
    DOTNET_TieredPGO=0 DOTNET_gcServer=0
WORKDIR /app
COPY Directory.Build.props BillingDemo.csproj BillingDemo.Tests.csproj ./
RUN dotnet restore BillingDemo.Tests.csproj
COPY docker ./docker
COPY src ./src
RUN sh docker/warm.sh
EXPOSE 3000
CMD ["sh", "docker/start.sh"]
