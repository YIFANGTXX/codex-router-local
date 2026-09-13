[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet("codex")]
  [string]$Target,

  [Parameter(Position = 1, Mandatory = $true)]
  [string]$Command,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CommandArguments
)

$ErrorActionPreference = "Stop"
$env:MODEL_ROUTER_TARGET = $Target
if ($Command -eq "project-route") {
  & node (Join-Path $PSScriptRoot "src\project-route.mjs") @CommandArguments
  exit $LASTEXITCODE
}
& (Join-Path $PSScriptRoot "codex-router.ps1") $Command @CommandArguments
exit $LASTEXITCODE
