# Fixture for `determinism: dotnet`. The project file and restored packages
# live in the image; the sandbox mounts ./src and `dotnet run --no-restore`
# compiles it at container start. Only restore here: build outputs baked into
# the image could look newer than a swapped-in source tree and be reused.
FROM mcr.microsoft.com/dotnet/sdk:10.0
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
WORKDIR /app
COPY App.csproj ./
RUN dotnet restore
EXPOSE 8080
CMD ["dotnet", "run", "--no-restore", "--no-launch-profile"]
