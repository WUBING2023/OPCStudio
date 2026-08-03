# ADR 0002: Execution And Ecosystem Bridges

- Status: Accepted
- Date: 2026-08-02
- Decision owners: Product owner and runtime owner

## Context

Codex, Claude Code and other agent hosts expose different session, approval, streaming and tool semantics. Treating one host's protocol as the OPC domain model would couple the product to that host.

## Decision

1. ACP is the generic execution channel.
2. Native adapters are optional capability enhancements for resume, fork, interrupt, approvals or richer event streams.
3. Every adapter negotiates explicit capabilities and converts host events into versioned OPC contracts.
4. Routing may select a native adapter only when the requested capability requires it and the adapter is healthy. Fallback is explicit and emits degradation facts.
5. MCP plus portable Skills are the public ecosystem layer. They expose OPC capabilities without transferring domain ownership to the host.
6. Adapter output must pass the same artifact, evidence and acceptance gates as OPC-native execution.

## Consequences

- Native and ACP paths can be compared on the same task and evidence contract.
- Missing host capabilities fail closed or degrade explicitly.
- Host-specific display or protocol fields remain in adapter metadata, not core entities.

