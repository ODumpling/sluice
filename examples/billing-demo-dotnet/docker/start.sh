#!/bin/sh
# Container entrypoint: compile the mounted ./src (read-only) into
# /app/artifacts and run it. Falls back to `dotnet build` without csc.rsp.
set -eu
cd /app
if [ -f csc.rsp ] && [ -f "$(cat csc.path)" ]; then
  # shellcheck disable=SC2046 # one argument per source file
  dotnet "$(cat csc.path)" -nologo -noconfig @csc.rsp $(find src -name '*.cs' | sort)
else
  dotnet build BillingDemo.csproj --no-restore --nologo -c Release -v q
fi
exec dotnet artifacts/bin/BillingDemo/release/BillingDemo.dll
