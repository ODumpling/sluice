module example.com/invoices

go 1.22

require (
	example.com/money v0.0.0
	github.com/google/go-cmp v0.6.0
)

// consumers build against the sibling checkout of the library
replace example.com/money => ../shared-money
