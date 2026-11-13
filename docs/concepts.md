# Concepts

## Architecture

```
surfaces   cli · mcp · github (App + Action) · web
   │
plugins    gate · bench · rules · leases · campaign · inbox · hello
   │
core       plugin-api · config · sandbox · fakes · evidence · policy · work · github-api
```

Dependencies point down only; **core never imports plugins** (enforced by an
ESLint rule and `test/unit/architecture.test.ts`). Every command and MCP tool
— including the core CLI commands — is registered through the versioned
[plugin API](/plugin-api). See [ADR-0001](/adr/0001-architecture).

## Key ideas

- **Sealed sandbox.** Services run on a Docker `--internal` network. A gateway
  container is the only bridge and forwards only Sluice's chosen ports;
  third-party APIs are reachable only as Sluice-hosted fakes.
  ([ADR-0002](/adr/0002-sandbox-and-fakes))
- **Fakes generated from contracts.** Fake responses are synthesized from the
  provider's OpenAPI and validated strictly before they leave the fake; drift
  is detected against newer specs and recorded traffic.
- **Evidence, not opinions.** A session records responses, egress, row-level
  DB writes and domain events; replay with a frozen clock and seeded RNG is
  byte-for-byte deterministic; the diff engine filters noise.
  ([ADR-0003](/adr/0003-evidence-and-replay))
- **Approved before written.** Gate scenarios are approved by a human and
  bound to a content hash; definitions are read from the base revision, so a
  PR cannot change its own checks. ([ADR-0004](/adr/0004-gate))
- **Checks with teeth.** Mutation testing on the changed lines proves the
  scenarios catch deliberately broken versions of the code.
- **Least privilege for agents.** Agents hold short-lived, task-scoped broker
  tokens, never real credentials. ([ADR-0006](/adr/0006-policy-and-rules))
- **Coordinate on symbols, not files.** Leases and interface-change
  broadcasts are computed from a TypeScript language-service index.
  ([ADR-0007](/adr/0007-coordination))
