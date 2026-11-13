// PR overlays (partial copies of src/ and test/, applied by scripts/demo).
// This nested module keeps them out of `go build/test/vet ./...` of the app.
module billing-demo/prs

go 1.27
