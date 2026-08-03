# ADR 0001: Control Plane And Domain Boundaries

- Status: Accepted
- Date: 2026-08-02
- Decision owners: Product owner and runtime owner

## Context

OPC Studio has an Electron/React application, a headless CLI, external-host integrations and multiple execution engines. Allowing each surface to own business rules would create incompatible run, approval, artifact and memory semantics.

## Decision

1. React in Electron is the primary human control plane. It renders state and issues commands; it does not invent run truth.
2. CLI and GUI are peer clients of the same server/domain APIs. Neither receives a privileged success path.
3. `apps/server` and `packages/shared` are the only domain core. Run lifecycle, acceptance, evidence, memory governance and bundle compatibility live there.
4. Project is a durable user work container. Run is one execution attempt. UI and APIs must not conflate them.
5. Every surface consumes canonical identifiers and contracts rather than scraping another surface's display text.

## Consequences

- A feature is incomplete when it works only in React or only in the CLI.
- A host integration cannot report success unless the server acceptance and evidence gates agree.
- Compatibility fixtures and contract tests are release gates.

