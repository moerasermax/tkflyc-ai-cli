# ai-cli-mcp

[![CI](https://github.com/moerasermax/tkflyc-ai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/moerasermax/tkflyc-ai-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40tkflyc%2Fai-cli-mcp)](https://www.npmjs.com/package/@tkflyc/ai-cli-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Run local AI CLIs — Claude, Codex, Antigravity (`agy`) — and **any third-party
OpenAI-compatible API** as MCP tools, with background jobs. Self-maintained from
source, built on a registry architecture: adding an agent means adding one file.

Requires Node `^20.19.0 || >=22.12.0`.

> 完整中文文件（環境變數、設定檔、每個工具的細節）見 **[README.zh-TW.md](README.zh-TW.md)**.
> The Chinese document is the exhaustive reference; this page covers the design and
> the parts you need to get running.

## Quick start

From npm — nothing to build:

```bash
claude mcp add ai-cli -s user -- npx -y @tkflyc/ai-cli-mcp
```

From source — if you intend to change it, or want auto-update:

```bash
git clone https://github.com/moerasermax/tkflyc-ai-cli
cd tkflyc-ai-cli
npm install     # triggers build via the prepare script and produces dist/
claude mcp add ai-cli -s user -- node "$PWD/dist/server.js"
```

`dist/` is not version-controlled, so the source install has to build before first
use. `npm install` runs it through the `prepare` script, so a separate
`npm run build` is normally unnecessary.

⚠️ **The two paths differ in more than building.** Auto-update requires a clone with
`.git` and `package.json` (see **Auto-update** below), so an npm/npx install never
updates itself — moving to a new version is something you do yourself. Pin the
version in the command (`@tkflyc/ai-cli-mcp@<version>`) if you need to know exactly
which one is running.
`doctor` reports whether this installation meets the source-update precondition
in `update.supported`.

## What it does

Each supported CLI becomes a tool you can call from an MCP client. Jobs run in the
background: `run` returns a PID immediately, and `list_processes`, `peek`, `wait` and
`get_result` observe it while it works. Two surfaces expose this — the MCP server and
the `ai-cli` command line — and they differ in where job state lives.

## Architecture

```
src/
├─ agents/                one file per AI — this is the extension point
│   ├─ types.ts               AgentDefinition, the core contract
│   ├─ registry.ts            central registry
│   └─ claude.ts · codex.ts · antigravity.ts · direct-api.ts
├─ core/                  the framework; untouched when adding an agent
│   ├─ command-builder.ts     model routing and command assembly
│   ├─ process-service.ts     in-memory job management (MCP)
│   ├─ file-process-service.ts file-backed job management (CLI)
│   ├─ pty-runner.ts          ConPTY, for CLIs that need a real TTY
│   ├─ circuit-breaker.ts     start-rate and duplicate-prompt breaker
│   ├─ updater.ts             background check, subprocess apply, rollback
│   └─ user-config.ts · binary-resolver.ts · peek.ts · doctor.ts
├─ models/                model catalog, aliases, provenance and disk cache
├─ plugins/               quota lookup bridge
└─ app/                   mcp.ts (MCP server) · cli.ts (command line)
```

The split is the point: `agents/` is data about each CLI, `core/` is the machinery.
A new backend never requires editing the machinery.

Job state lives in memory for the MCP server, with short shared monitoring snapshots, and in files for the CLI, so a CLI job
can be observed by a later command. Pipe-based CLI jobs run through a detached
wrapper and outlive the command that started them. The PTY path — used for CLIs that
only produce output on a real TTY — is not detached, and `direct-api` starts no
subprocess at all: on the CLI it runs in-process and blocks until the request
finishes, while the MCP server still returns a PID immediately.

## Watching jobs across sessions

Open another terminal using the same state directory:

```sh
ai-cli jobs                  # One table across MCP sessions and CLI jobs
ai-cli jobs --watch          # Refresh every 2 seconds; Ctrl+C exits
ai-cli jobs --json           # JSON array with metadata and timing
ai-cli jobs --running        # Only running jobs; combines with watch/json
ai-cli jobs --watch --json   # One compact JSON array per refresh (NDJSON)
```

The table shows status (spinner / ✓ / ✗ / ? for lost), agent, resolved model and
reasoning effort, a 40-character task summary, elapsed m:ss, the last short event,
and the dispatching process's parent name plus the ai-cli PID. Narrow terminals
truncate columns without wrapping. Parent names can be shells or Node launchers;
if the OS cannot provide a name, the table shows `unknown`.

MCP processes publish `AI_CLI_STATE_DIR/live-jobs/<pid>-<creation-token>.json`
(default `~/.local/state/ai-cli/live-jobs/`). Version 1 snapshots contain `owner`,
`updatedAt`, and `jobs`; each job contains `pid`, `agent`, `model`,
`reasoning_effort`, `task`, `workFolder`, `status`, `startTime`, `endTime`,
`elapsedSec`, `sinceLastOutputSec`, `lastEvent`, `dispatcher`, and `source`.
Full prompts and full output logs are never copied into these snapshots.
`lastEvent` stores only an 80-character summary of the last event and may contain
a model response excerpt.
Starts and status changes publish immediately; running liveness is throttled
to at most one write per two seconds. Writes use a temporary file plus rename.
Normal process exit removes its snapshot. Readers compare the owner's PID and
OS creation token, ignoring dead owners and reused PIDs without deleting files.
When a publisher is created, the writer collects snapshots older than ten minutes
only after confirming that their owner is dead or has a different creation token.
Unchanged idle snapshots are not rewritten; running refreshes allow 50 ms of timer tolerance.
Completed/failed summaries expire after ten minutes, or earlier when their MCP
server exits or explicit cleanup removes them.

CLI detached jobs reuse existing `cwds/*/*/meta.json`, `exit-status.json`, and
output logs, so they remain visible after the launching CLI exits. New metadata
records the tracked process's creation token and dispatcher; legacy metadata
has no creation token or dispatcher and keeps its older PID-only interpretation.
CLI jobs with a live PID but unavailable creation identity remain `running` with
`identityVerified: false` in JSON and `[unverified]` in the dispatcher column.
This fallback cannot rule out PID reuse. Identity capture runs after spawn in one
batch with the dispatcher, cached per service instance; `run` emits its PID before
waiting for metadata persistence at CLI exit.
`jobs` reads these files without updating them and works in `AI_CLI_WORKER=1`.
All sessions must share `AI_CLI_STATE_DIR` to appear in one view. OS process
identity lookup uses CIM on Windows, `/proc` on Linux and `ps` on macOS; snapshots
whose owner identity cannot be verified are omitted until a later refresh.

## Adding an AI agent

1. Copy `src/agents/codex.ts` to `src/agents/<name>.ts` and implement
   `AgentDefinition`: `id`, `models`, `matchesModel`, `binary`, `reasoning`,
   `buildCommand`, `parseOutput`.
   - Needs a real TTY → set `win32SpawnMode: 'pty'` (see `antigravity.ts`).
   - Is a real `.exe` rather than an npm shim → set `win32DirectExec: true`.
2. Import it in `src/agents/registry.ts` and append it to `AGENTS`. Claude stays
   last — it is the fallback.
3. Add the new id to `AgentId` in `src/agents/types.ts`. If the agent needs a CLI
   binary, extend the `CliPaths` return in `core/doctor.ts`.
4. `npm run build`.

## Start circuit breaker

A caller-side bug can turn into an infinite loop, and an infinite loop hammering a
provider can get an account flagged for abuse. Every subprocess start therefore goes
through `src/core/circuit-breaker.ts` first, which watches for two loop signatures:

- **Rate** — starts within the sliding window exceed `AI_CLI_BREAKER_MAX_STARTS`.
- **Duplicate** — the same agent with the same prompt exceeds
  `AI_CLI_BREAKER_DUP_LIMIT` within the window.

Either one opens the breaker for `AI_CLI_BREAKER_COOLDOWN_SEC`, during which starts
are refused with an explicit error, after which it recovers on its own. Normal usage
does not trip it. Verify with `npm run build && node tests/verify-breaker.mjs`.

## Knowing whether the AI is still alive

A `wait` timeout means the observation window closed, not that the job failed — the
process keeps running. Earlier versions threw `Timed out after N seconds`, which MCP
wrapped as an InternalError, and calling models routinely read that as failure and
abandoned the PID.

Now `wait` returns the array of current results instead. Only items still `running`
at the timeout carry `timedOut: true`. An unknown PID is still an error;
`completed`, `failed` and `lost` carry neither `liveness` nor `timedOut`.

Running items from `get_result`, `wait` and `list_processes` all carry the same
`liveness` object:

| Field | Meaning |
|---|---|
| `alive` | Process is up. It does **not** promise the model is producing tokens. |
| `elapsedSec` | Seconds since start. |
| `sinceLastOutputSec` | Seconds since the last stdout/stderr chunk; `null` if there has never been output. |
| `stdoutBytes` / `stderrBytes` | Bytes received. PTY-merged output counts as stdout. |
| `lastEvent` | One-line summary of the last meaningful event, ≤120 chars. |
| `eventCount` | Complete decoded events. Blank lines, bad JSON and partial lines do not count. |
| `hint` | Plain-English advice: starting up, recently active, alive but silent, or waiting on end-of-run metadata. |

This matters because Codex and Claude emit nothing at all while reasoning. Without
`liveness`, silence is indistinguishable from death.

The file-backed path keeps a `lost` state: the PID is gone and no completion was
recorded, so the outcome is genuinely unknown — which is not the same as failed.

## Auto-update

**Precondition: this section applies only to a source clone.** The updater requires
`.git` and `package.json` in the repo root, so an npm/npx install never updates
itself and `doctor` reports `update.supported: false`.

All three MCP entry points (`dist/server.js`, `dist/bin/ai-cli-mcp.js`, and
`dist/bin/ai-cli.js mcp`) serve normally after the transport connects, then check in the
background ~3 seconds later and apply updates in a subprocess; the new version takes
effect on the next start. Nothing blocks startup, and no running server or job is
killed.

| `AI_CLI_AUTO_UPDATE` | Behavior |
|---|---|
| `on` (default) | Check in the background, apply automatically |
| `check` | Report a new version, do not apply |
| `off` | Never touch the network; still reads existing state |

Also honored: `AI_CLI_UPDATE_CHECK_INTERVAL_SEC` (default `3600`),
`AI_CLI_UPDATE_BRANCH`, and `AI_CLI_STATE_DIR` (default `~/.local/state/ai-cli`).

⚠️ **Treat a push to `master` as a deployment: `npm test` must be green before you
push.** This is a public repo, and anyone with write access can trigger that.

A source install that tracks `master` with auto-update on will try to fetch and apply
it on a later check. It does not always land: a dirty tree, a different tracked
branch (`AI_CLI_UPDATE_BRANCH`), a non-fast-forward or a held lock stops it before
the pull, and a failed install, build or `doctor` smoke test triggers a rollback
attempt — which can itself fail. So neither "it went everywhere" nor "it went
nowhere" is safe to assume.

## direct-api

Besides the three local CLIs there is a fourth path that starts no subprocess at all:
`direct-api` talks HTTP from inside the Node process, so **any OpenAI-compatible
`/chat/completions` endpoint works** — OpenRouter, DashScope, DeepSeek, NVIDIA's
hosted NIM catalog, a local Ollama, your company gateway. Adding a provider needs no
code change, only a config entry.

It is not a thin completion wrapper: it runs the full agent loop, so the model gets
`read_file` / `write_file` / `bash` and can actually change files and run commands.

### Configuring a provider

`~/.local/share/ai-cli/providers.json` (override with `AI_CLI_PROVIDERS_PATH`):

```json
{
  "providers": {
    "openrouter": { "api_key": "sk-or-v1-..." },
    "local":      { "base_url": "http://127.0.0.1:11434/v1", "api_key": "ollama" },
    "nv": {
      "base_url": "https://integrate.api.nvidia.com/v1",
      "api_key": "nvapi-...",
      "retry": { "max_retries": 3, "initial_delay_ms": 1000 },
      "extra_body": { "max_tokens": 8192 },
      "model_extra_body": {
        "nvidia/nemotron-3.5-lightning-30b-a3b": { "reasoning_effort": "none" }
      }
    }
  }
}
```

Address a model as `<provider>-<model>`, where the prefix is the key above:
`or-qwen/qwen3.7-plus`, `nv-openai/gpt-oss-20b`, `local-llama3.1`. Everything after
the prefix is sent verbatim, so slashes in model names are fine. `openrouter` and
`dashscope` have built-in base URLs and short prefixes (`or`, `ds`); every other key
must supply its own `base_url`.

> **This file is fail-closed as a whole.** One provider missing `base_url` or
> `api_key` makes the entire file throw, taking the working providers down with it.
> Back it up before editing.

### extra_body — controlling what the framework does not send

The request body is `model` / `messages` / `stream` / `stream_options` / `tools` and
nothing else, so a hosted model's defaults apply untouched — and those defaults can be
expensive. `nvidia/nemotron-3.5-lightning-30b-a3b` spends 28.0s and 318 output tokens
per tool round on its default reasoning, and 6.1s / 84 tokens with
`reasoning_effort: "none"`.

`extra_body` is the provider-wide default; `model_extra_body` overrides it field by
field, keyed by the model name as sent to the provider.

`model`, `messages`, `stream`, `stream_options` and `tools` are **rejected at load
time**, naming the provider and the offending key — not dropped silently. Overriding
`stream` would hand the SSE reader a single JSON blob; overriding `tools` would offer
the model tools `executeTool` cannot run.

Note the terminology clash: the `run` tool's `reasoning_effort` argument is a
CLI flag for claude/codex and still does not apply here. What `extra_body` sends is
the same-named *API field*, which is a different thing.

### retry — surviving a shared endpoint

Free shared endpoints throttle and shed load. NVIDIA's own troubleshooting docs say
the hosted Nemotron endpoints may return 429 or 503 under high demand, and advise a
short wait plus lower concurrency; before this, any non-200 simply failed the job.

429 and 5xx are retried with exponential backoff and jitter. Every other 4xx is not —
a request the server rejected as malformed is still malformed the second time, and
retrying only burns quota. Defaults are 2 retries and a 1s initial delay;
`max_retries: 0` turns it off. A `Retry-After` header wins over the computed backoff,
capped at 60s. A kill during backoff wakes immediately rather than sleeping it out.

Each retry emits a `retry` event on stdout — a silent retry makes "slow" and "stuck"
indistinguishable to a caller that only sees the tool result.

Retrying covers **establishing** the request. Once a 200 arrives and the stream
starts, content has already reached the caller, so a mid-stream failure is not
retried; replaying it would emit the same answer twice.

Measured on `nvidia/nemotron-3-super-120b-a12b`, 10 two-round tool loops per row:

| Request pacing | Retry | Success |
|---|---|---|
| back-to-back (~66 rpm) | off | 4/10 |
| 10 rpm | off | 8/10 |
| 15 rpm | off | 9/10 |
| **15 rpm** | **on** | **10/10** |

Slowing down alone never reached 100%; retrying did, and at the faster rate. Even
pacing trades every request's latency for a few requests' success, while backoff pays
only when the server actually refuses.


### replay_reasoning — models that want their own thinking back

Some models require the previous assistant turn to be replayed *complete*, including
its reasoning. Kimi-K3's model card: "clients must pass back the complete assistant
message, including `reasoning_content` and `tool_calls`". DeepSeek V4 goes further —
with `tools` in play, omitting it returns **400**.

```json
"nv": { "replay_reasoning": ["moonshotai/kimi-k3"] }
```

`true` covers every model of that provider; an array names them individually.

**Off by default, and deliberately not a built-in model list.** `reasoning_content`
is not part of OpenAI's assistant message schema, and "OpenAI-compatible" does not
promise unknown fields are ignored — Azure AI Model Inference defaults `extra-parameters`
to `error`. A hardcoded allow-list would also go stale the way every other hardcoded
model list here has.

The replayed value is *that turn's* reasoning, not the run's accumulated text —
otherwise each round would re-append everything before it. It applies to every
assistant turn, not only the ones carrying tool calls: the final answer is written to
the session file and becomes a prior turn when you continue with the same
`session_id`.

Measured caveat: Kimi-K3 completed a three-round tool chain correctly *without* the
replay, and the docs do not state what omitting it breaks. This follows the stated
contract; it is not a fix for an observed failure.

### Knowing what this machine can reach

`models` returns a `directApiProviders` block: each configured provider's usable
prefixes (including built-in shorthands), base URL, the models named in
`model_extra_body`, and a copy-pasteable `example`.

Without it a tool result cannot answer "what can this machine reach" — the static
`direct-api` list is four placeholder strings, and configured providers are local
state that lives in neither version control nor any static list.

The block never contains `api_key`, and never throws: an unreadable `providers.json`
comes back as a `note`, because "cannot read it" and "nothing configured" are
different answers.

### Limits

- **Sessions** — `session_id` persists under `workFolder/.tmp/api_sessions`.
- **Images** — write `[image:C:/path/to.png]` in the prompt (png/jpg/webp/gif).
- **Plain Q&A** — prefix the prompt with `[no-tools]` to drop the tool loop.
- **Per turn** — at most 30 API calls and 30 tool-loop iterations.
- **Keys** — error text is redacted to `[redacted]` before it is returned.
- Model lists are dynamic; the framework keeps no allow-list.

> Migrating from OpenCode: if `providers.json` is absent but
> `~/.local/share/opencode/auth.json` exists, it is converted once, automatically.

## Wiring into Claude Code

```bash
# bash / git bash
claude mcp add ai-cli -s user -- node "$PWD/dist/server.js"
```
```powershell
# PowerShell
claude mcp add ai-cli -s user -- node "$PWD\dist\server.js"
```

## Relationship to the original project

This project began as a clone of [mkXultra/ai-cli-mcp](https://github.com/mkXultra/ai-cli-mcp)
(MIT), which is itself derived from Peter Steinberger's `claude-code-mcp` (MIT).
**Upstream is actively maintained** — 2.23.0 shipped on 2026-09-06, and it has
roughly 680 weekly npm downloads. This is not a rescue of an abandoned project;
it is a fork that diverged on architecture. If you want the original, use
[`ai-cli-mcp`](https://www.npmjs.com/package/ai-cli-mcp). See [NOTICE](NOTICE)
for the full attribution and the retained MIT terms.

It has since been substantially rewritten. Measured against upstream v2.23.0,
299 of this tree's 1,980 substantive source lines (about 15%) are still identical —
concentrated in the MCP tool surface (tool names, descriptions, schemas) and
the CLI/MCP entry points. What is new here:

- **Registry architecture.** Upstream hard-coded five backends. Here,
  `src/agents/` holds one file per CLI and is the only extension point;
  `src/core/` is the machinery and does not change when a backend is added.
- **`direct-api`** — bring any third-party OpenAI-compatible provider, rather
  than only the CLIs someone else compiled in.
- **Circuit breaker** for start-rate and duplicate-prompt storms, so an
  orchestration loop cannot turn into anomalous traffic against a provider.
- **ConPTY runner** for CLIs that only produce output on a real TTY.
- **Model catalog with provenance** — every entry says where it came from and
  whether it is dispatchable — plus a dispatch guidance table.
- **Background self-update** with subprocess apply and rollback.
- **Honest return values.** `wait` returns liveness on timeout instead of
  throwing; job state distinguishes `lost` from `failed`; `doctor` returns
  `null` for checks it did not perform rather than `false`. The caller is an
  AI and only sees the return value, so the return value has to say what is
  actually known.

The package is published as `@tkflyc/ai-cli-mcp`; the unscoped
`ai-cli-mcp` name on npm belongs to upstream.

## License

Apache-2.0. See [LICENSE](LICENSE).

This project is a derivative work of software originally released under the
MIT License. The original copyright notices and the retained MIT terms are in
[NOTICE](NOTICE), which ships with every copy — it is in the repo and
listed in `package.json`'s `files`, so it travels with the npm package too.
