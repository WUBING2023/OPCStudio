<#
  OPC Studio — 新机器一键引导(Windows / PowerShell)
  目标:把一份「不含密钥」的 OPC Studio 代码,在一台干净机器上跑起来(BYOK,自带密钥)。
  用法:在 OPC Studio 项目根目录执行  ./scripts/setup.ps1
        可选:-Build(构建 web 产物)  -StartHermes(检测/安装 Hermes 执行层)
#>
[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot   # 项目根 = scripts 的上一级
function Info($m){ Write-Host "[setup] $m" -ForegroundColor Cyan }
function Ok($m){ Write-Host "[ ok ] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "[warn] $m" -ForegroundColor Yellow }

Info "项目根: $root"
Set-Location $root

# 1) 运行时:node + pnpm
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Warn "未检测到 Node.js。请先安装 Node 20+(https://nodejs.org)后重跑。"; exit 1 }
Ok "Node $(node -v)"
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Info "未检测到 pnpm,尝试用 corepack 启用…"
  try { corepack enable; corepack prepare pnpm@latest --activate } catch { Warn "corepack 启用 pnpm 失败,请手动 `npm i -g pnpm` 后重跑。"; exit 1 }
}
Ok "pnpm $(pnpm -v)"

# 2) 依赖(electron 打包需 hoisted 布局;开发用普通安装即可)
if (-not $SkipInstall) {
  Info "安装依赖(pnpm install)…"
  pnpm install
  Ok "依赖安装完成"
} else { Warn "跳过依赖安装(-SkipInstall)" }

# 3) Hermes 执行层(非 Claude/GPT 的 agent 都经 Hermes 运行;系统级安装,不随项目分发)
$hermes = (Get-Command hermes -ErrorAction SilentlyContinue)
if ($hermes) {
  Ok "Hermes 已安装:$(hermes --version 2>$null | Select-Object -First 1)"
} else {
  Warn "未检测到 Hermes。它是 OPC 的执行层(员工/记忆/技能)。"
  if (Get-Command uv -ErrorAction SilentlyContinue) {
    Info "检测到 uv,尝试安装:uv tool install --python 3.12 hermes-agent"
    try { uv tool install --python 3.12 hermes-agent; Ok "Hermes 安装完成(可能需重开终端使 PATH 生效)" }
    catch { Warn "自动安装失败,请参考 Hermes 官方说明手动安装。" }
  } else {
    Warn "未检测到 uv。请先装 uv(https://docs.astral.sh/uv) 再 `uv tool install --python 3.12 hermes-agent`,"
    Warn "或参考 Hermes 官方安装方式。装好后:hermes auth add <provider> --api-key sk-..."
  }
}

# 4) 密钥(BYOK)——三选一,全部不进库/不进 exe
$keysDir = Join-Path $root ".opc/keys"
if (-not (Test-Path $keysDir)) { New-Item -ItemType Directory -Force -Path $keysDir | Out-Null }
Info "密钥(任选其一,均已被 .gitignore 忽略):"
Write-Host "  A) 环境变量:  setx DEEPSEEK_API_KEY sk-...   (推荐;MINIMAX_/DOUBAO_/OPENAI_/ANTHROPIC_ 同理)" -ForegroundColor Gray
Write-Host "  B) 项目内文件:把密钥写进  $keysDir\<provider>.key  (如 deepseek.key)" -ForegroundColor Gray
Write-Host "  C) 启动后在 UI 的供应商设置页填写(写入本地 .opc/config.json)" -ForegroundColor Gray
Write-Host "  注意:Hermes 自身的 provider 凭证用 `hermes auth add` 单独配置(在用户机器本地)。" -ForegroundColor Gray

# 5) 构建 web(可选;开发直接用 pnpm dev 即可)
if ($Build) {
  Info "构建(pnpm build:shared + web)…"
  pnpm build
  Ok "构建完成(apps/web/dist)"
}

Ok "完成。开发启动:pnpm dev   |   仅后端:pnpm --filter @opc/server dev"
Write-Host "首启动后,在 UI 看各引擎可用性(Hermes/claude-code/codex);不可用项会显示安装/登录指引。" -ForegroundColor Gray
