# Fixture for `determinism: go`. Dependencies are downloaded (and compiled into
# the build cache) at image build; the sandbox mounts ./src and the command
# compiles it at container start, so the overlay shim is linked in.
FROM golang:1.27-alpine
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY src ./src
RUN go build -o /dev/null ./src
EXPOSE 8080
CMD ["go", "run", "./src"]
