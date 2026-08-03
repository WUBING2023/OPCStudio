# This removes only the host adapter and preserves OPC Studio companies, runs, memories, and artifacts.
[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [ValidateSet("user", "project", "local")][string]$Scope = "user",
  [switch]$RemoveMarketplace
)
$ErrorActionPreference = "Stop"
$MarketplaceName = "opc-studio-claude"
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "Claude Code CLI is not available on PATH." }
if ($PSCmdlet.ShouldProcess("Claude Code", "Uninstall OPC Studio plugin at $Scope scope")) {
  $installed = (& claude plugin list --json 2>$null | Out-String)
  if ($installed -match [regex]::Escape("opc-studio")) {
    & claude plugin uninstall "opc-studio@$MarketplaceName" --scope $Scope --keep-data
    if ($LASTEXITCODE -ne 0) { throw "Could not uninstall the OPC Studio Claude plugin." }
  }
  if ($RemoveMarketplace) {
    $known = (& claude plugin marketplace list --json 2>$null | Out-String)
    if ($known -match [regex]::Escape($MarketplaceName)) {
      & claude plugin marketplace remove $MarketplaceName --scope $Scope
      if ($LASTEXITCODE -ne 0) { throw "Plugin was removed, but the marketplace could not be removed." }
    }
  }
}
