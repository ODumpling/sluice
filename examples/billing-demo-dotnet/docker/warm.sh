#!/bin/sh
# Image-build step: restore + build once so every container start can compile
# the mounted ./src with a single csc call (no MSBuild evaluation, ~1s faster).
# Records the exact csc invocation MSBuild used as /app/csc.rsp (minus the
# app's own sources, which start.sh globs from the mounted ./src).
set -eu
cd /app
mkdir -p test
printf 'namespace BillingDemo.Tests;\npublic class Warm { [Xunit.Fact] public void Ok() { } }\n' > test/Warm.cs
dotnet test BillingDemo.Tests.csproj --no-restore --nologo -v q
rm -rf test
dotnet build BillingDemo.csproj --no-restore --nologo -c Release -v n -p:UseSharedCompilation=false > /tmp/build.log
line=$(grep -m1 '/noconfig' /tmp/build.log)
csc=$(printf '%s\n' "$line" | awk '{print $1}')
printf '%s.dll\n' "$csc" > /app/csc.path
printf '%s\n' "$line" | tr ' ' '\n' | awk '
  $0 == "" || /\/csc$/ || $0 == "/noconfig" { next } # csc itself; /noconfig goes on the command line
  /^src\// { next }                          # app sources: globbed at start
  /^\/refout:/ { next }                      # reference assembly: not needed to run
  /^\/out:/ { print "/out:/app/artifacts/bin/BillingDemo/release/BillingDemo.dll"; next }
  { print }' > /app/csc.rsp
# keep generated files, deps/runtimeconfig and package assemblies; drop the compiled app
rm -f artifacts/obj/*/*/BillingDemo*.dll artifacts/obj/*/*/BillingDemo*.pdb \
  artifacts/bin/BillingDemo/release/BillingDemo.dll artifacts/bin/BillingDemo/release/BillingDemo.pdb
rm -rf artifacts/bin/BillingDemo.Tests artifacts/obj/BillingDemo.Tests/debug/BillingDemo.Tests.dll
