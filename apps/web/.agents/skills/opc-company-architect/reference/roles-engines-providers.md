# Roles, engines, providers

## Roles (drive the GLOBAL role prompt — behavior)

You compose behavior by choosing roles + structure, NOT by editing prompts (role prompts are global via `getRolePrompt`).

| role | behavior |
|---|---|
| `ceo` | Recognizes the task type, routes it, gives the team the goal. Does **not** micromanage or assign individual workers on research tasks. |
| `lead` | Decomposes the goal into sub-tasks, assigns workers, reviews their output (ACCEPT/REDO rounds), and **synthesizes the final answer** (must produce the answer, not a "work report"). |
| `dev` / `worker` / `coder` | Does the actual production (research, writing, coding). |
| `test` / `fact_checker` (`fact-check`) | Verifies output — tests for code, fact-check for research. |
| `code_reviewer` | Independent cross-verification target for a `code-review` verification edge. |
| `security_reviewer`, `architect`, `pm`, `security`, `ops` | Specialist roles; add only when the task needs them. |

## Frameworks (which engine runs the agent)

| framework | engine | providers / models | notes |
|---|---|---|---|
| `hermes` / `api` | OPC in-process API tool-loop | `deepseek` (deepseek-v4-pro, deepseek-chat, deepseek-reasoner), `minimax` (MiniMax-M3), `doubao` | Cheapest, reliable for **text/research**. Uses **API keys**. |
| `claude-code` | Anthropic subscription CLI (ACP) | `anthropic` — `opus` / `sonnet` / `haiku` | Strong coding. Windows needs `CLAUDE_CODE_GIT_BASH_PATH`. **Single account = serial only** (parallel = rate-limit/ban risk). Writes need the worker path's permission grant. |
| `codex` | OpenAI subscription CLI (ACP) | `openai` — `gpt-5.5` | Good independent reviewer; supports `reasoningEffort`. |
| `opencode` | other CLI | — | Third-party; not one of the three subscriptions OPC health-checks. |

## Providers & keys

- **API-key providers**: `deepseek` / `minimax` / `doubao`. Keys are resolved **env > key files > config.apiKeys**, in that order. On this machine they are **file-based**: `../../keys/deepseek.key`, `../../keys/minimax.key`, `../../keys/doubao.key` (relative to the OPCstudio repo). `config.apiKeys` is often empty — do **not** conclude "no key" from that.
- **Subscription CLIs**: `anthropic` (claude-code) and `openai` (codex) authenticate via their CLI login (a config dir, default `~/.claude`), **not** API keys. `hasKey=false` for anthropic is normal.

## Engine-selection rules of thumb

- **Research / analysis (text)** → `hermes`/`deepseek` is cheap and proven (with web-search MCP it approached opus quality in prior experiments). Use `minimax`/`doubao` to diversify.
- **Coding that must write/run files** → `claude-code`/`sonnet` (strong + reliable delivery on the fixed worker path). `haiku` when you want a weaker/cheaper coder (e.g., to test whether a reviewer adds value).
- **Independent reviewer** → a *different* provider from the producer (e.g., producer `claude-code`/sonnet + reviewer `codex`/gpt-5.5) so the cross-check is genuinely independent.
- **Clean "does collaboration help" experiment** → hold model constant across every role (all deepseek) so single-vs-team is the only variable.

## Optional agent fields

- `reasoningEffort`: `low|medium|high|xhigh|max` (codex honors it).
- `cliConfigDir`: point a claude-code agent at an alternate login dir — the mechanism for **multi-account concurrency** (spread parallel CLI calls across accounts to avoid the single-account serial limit).
- `uiPosition`: `{x,y}` for the canvas (cosmetic).
