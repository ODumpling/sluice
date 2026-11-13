# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

## Reporting a vulnerability

Please **do not** open a public issue. Report privately through GitHub's
"Report a vulnerability" (Security → Advisories) on this repository. Include a
description, affected component, reproduction steps and impact. We aim to
acknowledge within 3 working days and to ship a fix or mitigation for
confirmed issues within 30 days, crediting reporters who want to be credited.

## Scope and threat model

Sluice runs untrusted, AI-written code. Areas we treat as security-relevant:

- **Sandbox isolation** — services must have no route off the host except via
  the gateway's explicit forwards (`core/sandbox`).
- **Credential broker** — agents must never obtain upstream credentials;
  scope, TTL, cap and step-up checks must not be bypassable; the audit log must
  detect tampering (`core/policy`).
- **Gate integrity** — a change must not be able to alter or approve its own
  scenarios; approvals are bound to content hashes and read from base
  (`plugins/gate`).
- **Webhooks** — GitHub webhook signatures must be verified
  (`surfaces/github`).
- **Local web UI** — binds 127.0.0.1, rejects cross-origin mutations.

Known limitations in v0.1: Docker is the isolation boundary (not a VM);
the determinism shim is not a security control; `node:sqlite` is
experimental in Node 22.
