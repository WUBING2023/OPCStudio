# OPC Studio 0.1.0 - Windows Private Alpha

This is the first public Windows Private Alpha snapshot of OPC Studio.

## Included

- Local-first multi-agent company and mission workflow
- API provider and supported subscription CLI execution
- Task graph, A2A state, artifacts, evidence, and honest run status
- Governed multi-level memory and reusable company bundles
- Skill, MCP, token usage, project, and company management interfaces
- Codex and Claude integration packages

## Windows artifact

- File: `OPC-Studio-Private-Alpha-0.1.0-x64.exe`
- Download size: 132,823,585 bytes (126.7 MiB)
- Installed size: approximately 472 MiB
- SHA-256: `7E666468F21228CBFC3FCF72CC760A2CA9F82CD38CD65958AAC2370FF2581C4D`

## Verification

The release candidate passed the repository typecheck/test gate and an installed Electron acceptance covering startup, health, ten primary routes, restart persistence, and the passive subscription-probe regression. Gemini CLI is not launched by passive model-catalog reads.

## Known limits

- Windows x64 only; macOS is not yet packaged or installation-tested.
- Private Alpha: use non-sensitive projects and review execution permissions.
- Provider reliability and available models depend on external services and local CLI versions.
- The product reports subscription token usage, not authoritative monetary cost.
- Complete public-template signing and moderation are not yet production-grade.