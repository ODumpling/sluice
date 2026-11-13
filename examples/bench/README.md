# Bench example: cel-js

`cel-js.bundle` is the unmodified git history of
[marcbachmann/cel-js](https://github.com/marcbachmann/cel-js) (MIT License,
© Marc Bachmann) up to `86cd972`, vendored so mining runs offline.

```sh
cd examples/bench
sluice bench mine          # validates fail-to-pass tasks in no-network containers
sluice bench run           # oracle vs first-file (scripted) agents
```

Add real agents to `bench.yaml` (examples are commented in it). The
`first-file` agent reports a **simulated** cost so cost aggregation is testable
without calling a model.
