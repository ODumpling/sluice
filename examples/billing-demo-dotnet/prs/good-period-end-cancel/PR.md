# Cancel at period end (CANCEL-1)

Adds `POST /subscriptions/:id/cancel`. Schedules cancellation at the end of the current
period in Stripe (`cancel_at_period_end`), keeps access until then, emits
`subscription.cancel_scheduled`. Includes unit tests.
