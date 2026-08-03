# OPC Studio for Claude Code

Local marketplace: `opc-studio-claude`. This package exposes the same three standard Skills and the same 17 `opc-mcp` tools as the other host adapter.

## Prerequisites

- OPC Studio is installed, or installation receives an explicit absolute MCP runtime path.
- The installer verifies the runtime through an MCP identity handshake before registering it; bare PATH commands are rejected.
- Configure an OPC session token only through OPC Studio or the existing CLI environment; this package never stores it.

## Install

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Scope user
```

The install script is the only operation that changes host plugin configuration. It supports PowerShell `-WhatIf`.

## Doctor and smoke

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\smoke.ps1
```

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -Scope user
```

Uninstall removes only the host adapter. OPC Studio companies, runs, memories, artifacts, credentials, and keys remain owned by OPC Studio.

## Permission and data boundary

The plugin itself has no direct filesystem, network, shell, memory, or credential permission. It starts only the absolute OPC Studio MCP runtime pinned after an identity handshake. Read and write behavior is enforced by the MCP server; start/cancel operations require confirmation, authentication, idempotency, and audit. The package contains metadata, MCP configuration, and standard Skill instructions only.
