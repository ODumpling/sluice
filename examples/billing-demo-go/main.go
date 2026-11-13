// Command billing-demo starts the billing HTTP service. All application code
// lives in ./src (package billing), which the Sluice sandbox mounts read-only
// and compiles at container start.
package main

import billing "billing-demo/src"

func main() { billing.Main() }
