# ADR 0003: Host Authentication And Data Ownership

- Status: Accepted
- Date: 2026-08-02
- Decision owners: Product owner and runtime owner

## Context

External agent hosts keep subscription credentials and local authentication state. Copying those files into OPC Studio would expand the secret boundary and make account revocation unreliable.

## Decision

1. OPC Studio never copies or exports Codex, Claude Code or other host authentication files.
2. Subscription execution uses the host CLI and its own authenticated environment. OPC stores only non-secret account labels, availability and configuration references.
3. API secrets remain behind the credential broker. Workers receive short-lived, single-use references or process environment injection only at launch.
4. MCP, plugins, bundles, evidence and diagnostic exports recursively redact secrets and local private paths.
5. Imported companies declare required providers and capabilities, never embedded credentials.

## Consequences

- Users can revoke credentials at the owning host.
- Plugin uninstall does not need to recover copied credentials.
- Authentication availability is diagnosed independently from host filesystem write capability.

