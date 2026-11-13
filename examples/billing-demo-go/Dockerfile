# Go toolchain image: the app is compiled from the mounted ./src at container
# start (so the gate can swap sources per run). Modules and the build cache are
# baked in here, so start-up only recompiles package src and links.
FROM golang:1.27-alpine
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=off GOCACHE=/root/.cache/go-build
WORKDIR /app
COPY go.mod go.sum ./
RUN GOPROXY=https://proxy.golang.org go mod download
COPY main.go ./
COPY src ./src
# Warm the build cache for the server binary and for `go test` (testing + vet).
RUN go build -ldflags='-s -w' -o /tmp/billing-demo . && rm /tmp/billing-demo \
 && mkdir test && printf 'package billing_test\nimport (\n"testing"\n_ "billing-demo/src"\n)\nfunc TestWarm(t *testing.T) {}\n' > test/warm_test.go \
 && go test ./test/ && rm -rf test
EXPOSE 3000
CMD ["sh", "-c", "go build -ldflags='-s -w' -o /tmp/billing-demo . && exec /tmp/billing-demo"]
