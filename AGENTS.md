# AGENTS.md

Rules for AI assistants working on KVox Desktop. Product, architecture and roadmap: [README.md](README.md). Epic and issues: [marinoscar/kvox#574](https://github.com/marinoscar/kvox/issues/574).

## MANDATORY: Packages first — this repository contains no domain logic

KVox Desktop is a **host** of the published `@marinoscar/kvox-*` packages ([ADR-0001](https://github.com/marinoscar/kvox/blob/main/docs/decisions/0001-packages-first.md)).

- Allowed here: port bindings (the `KVOX_*` ports of `@marinoscar/kvox-api/ports`, `KvoxWebHost`), the Electron shell, settings and navigation, packaging, and Desktop-only glue (keychain, local vault, egress allowlist).
- Never here: slice code, prompts, AI request mechanics, schemas, parsers, SQL beyond extension creation, or copies of any of these. If Desktop needs a behaviour the packages lack, open an issue in `marinoscar/kvox` and add it to a package first.
- Every PR review includes the item: "no domain logic in this repository".

## MANDATORY: Data stays on the device

Documents, notes, the graph and settings live under the user data folder. The only outbound traffic is the configured AI provider (and update checks, only when the user enables them). See [ADR-0004](https://github.com/marinoscar/kvox/blob/main/docs/decisions/0004-desktop-data-local-only.md). Never add telemetry, crash upload or remote assets.

## Git and PRs

- Every change ships as a PR against `main`; never push to `main`. Conventional Commits (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`). Link issues with `Fixes marinoscar/kvox#<n>`.
- In a cloud session, work on the branch the session designates.
- Pin the `@marinoscar/kvox-*` packages to one exact version and bump them together.

## Where to read

- Desktop consumer guide: [kvox/docs/guides/kvox-desktop.md](https://github.com/marinoscar/kvox/blob/main/docs/guides/kvox-desktop.md)
- Ports contract: [kvox/docs/specs/kvox-ports.md](https://github.com/marinoscar/kvox/blob/main/docs/specs/kvox-ports.md)
- Reference host to copy from: [kvox/examples/bare-host](https://github.com/marinoscar/kvox/tree/main/examples/bare-host)
- Architecture decisions: [kvox/docs/decisions](https://github.com/marinoscar/kvox/tree/main/docs/decisions)
