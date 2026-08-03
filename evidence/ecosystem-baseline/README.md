# Ecosystem Baseline

This directory freezes the pre-ecosystem compatibility boundary required by Phase 0.

- `fixtures/`: canonical machine-readable Company Bundle, Run Event and governed Memory Proposal examples.
- `visual/`: Electron/React screenshots from the verified Windows flow and current MCP/Skill control surfaces.
- `external-runs/`: preserved ACP run evidence. Evidence remains read-only and must not be replaced by prose summaries.
- `manifest.json`: file list, provenance and SHA-256 lock values.

Run `pnpm test -- ecosystemBaseline.test.ts` after changing a contract or baseline file. A deliberate compatibility change must update the schema migration, fixture, manifest hash and capability matrix together.
