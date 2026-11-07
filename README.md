# ai-cli-mcp

[![CI](https://github.com/moerasermax/tkflyc-ai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/moerasermax/tkflyc-ai-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40tkflyc%2Fai-cli-mcp)](https://www.npmjs.com/package/@tkflyc/ai-cli-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Run local AI CLIs — Claude, Codex, Grok, Antigravity (`agy`) — and **any third-party
OpenAI-compatible API** as MCP tools, with background jobs. Self-maintained from
source, built on a registry architecture: adding an agent means adding one file.

Requires Node `^20.19.0 || >=22.12.0`.

> 完整中文文件（環境變數、設定檔、每個工具的細節）見 **[README.zh-TW.md](README.zh-TW.md)**.
> The Chinese document is the exhaustive reference; this page covers the design and
> the parts you need to get running.

## What it does

Each supported CLI becomes a tool you can call from an MCP client. Jobs run in the
background: `run` returns a PID immediately, and `list_processes`, `peek`, `wait` and
`get_result` observe it while it works. Two surfaces expose this — the MCP server and
the `ai-cli` command line — sharing durable state for Claude, Codex, Grok and Windows Antigravity.

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

## Wiring into Claude Code

```bash
# bash / git bash
claude mcp add ai-cli -s user -- node "$PWD/dist/server.js"
```
```powershell
# PowerShell
claude mcp add ai-cli -s user -- node "$PWD\dist\server.js"
```

## Agents

Usage notes for each backend. Maintainer acceptance procedures are in [tools/acceptance/README.md](tools/acceptance/README.md).

### Grok CLI

Grok is a separate xAI CLI backend for coding and text work. Select `grok-4.7`,
`grok-4.7-build-fast`, `grok-4.6`, or `grok-4.5`; `models` and `ai-cli models`
query `grok models` with a 15-second timeout and retain successful cache values or
label the builtin fallback on failure (including an unauthenticated CLI).
`GROK_CLI_NAME` overrides the binary; otherwise PATH wins, with
`~/.grok/bin/grok.exe` (Windows) or `~/.grok/bin/grok` as fallback. Doctor lists Grok.

Prompts use `--prompt-file` to preserve long Windows prompts. Native Windows
execution bypasses cmd.exe; `--rules` receives the shared `WORKER_CONTEXT` first,
then an optional `run.system_prompt`, separated by a blank line. Every resume
reinjects the lock with `--resume`; `--no-subagents` is always set. Normal mode
uses `--always-approve`. `reasoning_effort` accepts only `low`, `medium`, `high`, `xhigh` (live verified: grok 1.0.50).

Grok results with `subtype: error_during_execution` or `stop_reason: cancelled`
fail even with exit 0; the error includes both fields.

Grok uses the same durable JobStore/runner, restart recovery and 30-minute finished
job retention as Claude/Codex. Messages JSON result usage includes cache tokens in
normalized input and exposes `cost_usd_nominal` (vendor estimate, not a billing statement).

The strict read-only `capabilities` flags, their live verification and the F2 live-verification checklist are maintainer acceptance steps; see [tools/acceptance/README.md](tools/acceptance/README.md). Empty and unsupported capabilities are refused.

### Antigravity model list

Antigravity's top-level model list uses routable vendor results (including successful
cached results) plus `agy` / `agy-default`. Without a usable result, its fallback is
`agy`, `agy-default`, `gemini-3.1-pro-high`, and `gemini-3.8-flash-high`.

### direct-api

Besides the three local CLIs there is a fourth path that starts no subprocess at all:
`direct-api` talks HTTP from inside the Node process, so **any OpenAI-compatible
`/chat/completions` endpoint works** — OpenRouter, DashScope, DeepSeek, NVIDIA's
hosted NIM catalog, a local Ollama, your company gateway. Adding a provider needs no
code change, only a config entry.

It is not a thin completion wrapper: it runs the full agent loop, so the model gets
`read_file` / `write_file` / `bash` and can actually change files and run commands.

#### Configuring a provider

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

#### extra_body — controlling what the framework does not send

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

#### max_tool_loops — tool loop budget

Each provider may set `"max_tool_loops": 60` in providers.json. It must be an
integer from 1 to 200 (default: 30). This limits both tool-loop iterations and
API completion calls; HTTP retries do not count toward the limit. Reaching the
limit returns `finish_reason: "tool_loop_limit"` and logs the effective limit
to stderr. Invalid values report the provider name and providers.json path.
The job still ends as `completed` with exit code 0 and `get_result` does not
show that stderr line, so check `agentOutput.finish_reason` before treating the
reply as a finished answer.

#### retry — surviving a shared endpoint

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

#### replay_reasoning — models that want their own thinking back

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

#### Knowing what this machine can reach

`models` returns a `directApiProviders` block: each configured provider's usable
prefixes (including built-in shorthands), base URL, the models named in
`model_extra_body`, and a copy-pasteable `example`.

Without it a tool result cannot answer "what can this machine reach" — the static
`direct-api` list is four placeholder strings, and configured providers are local
state that lives in neither version control nor any static list.

The block never contains `api_key`, and never throws: an unreadable `providers.json`
comes back as a `note`, because "cannot read it" and "nothing configured" are
different answers.

#### Limits

- **Sessions** — `session_id` persists under `workFolder/.tmp/api_sessions`.
- **Images** — write `[image:C:/path/to.png]` in the prompt (png/jpg/webp/gif).
- **Plain Q&A** — prefix the prompt with `[no-tools]` to drop the tool loop.
- **Per turn** — at most 30 API calls and 30 tool-loop iterations.
- **Keys** — error text is redacted to `[redacted]` before it is returned.
- Model lists are dynamic; the framework keeps no allow-list.

> Migrating from OpenCode: if `providers.json` is absent but
> `~/.local/share/opencode/auth.json` exists, it is converted once, automatically.

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

### Trust model: what `on` means

`AI_CLI_AUTO_UPDATE=on` (the default) means **trusting every push to `origin`**:

- Anyone who can push to `origin` — or anyone who has taken over the repo owner's
  GitHub account or token — can get this machine to run their code on its next check,
  **with no action from you**.
- "Takes effect on the next start" refers to the MCP server switching versions. The new
  code **already runs during the background update**: when package files change,
  `npm install` runs the lifecycle scripts of the dependencies and of this repo (such as
  `prepare`), and the build and `doctor` smoke test that follow run the new code too.
- This server is powerful to begin with: a `run` without `capabilities` starts each agent
  with its vendor's permission bypass (`--dangerously-skip-permissions` for claude and
  agy, `--dangerously-bypass-approvals-and-sandbox` for codex, `--always-approve` for
  Grok), using your local CLI logins.

So:

- **Use `on` only on machines where you trust whoever can write to `origin`**, such as
  your own machines tracking your own repo.
- Otherwise — `origin` points at someone else's repo, the machine is shared, or you are
  not sure who has write access — use `check`: it only reports a new version, and you
  review the changes before applying them yourself.
- On the maintainer side: turn on two-factor authentication for the GitHub account, give
  write access only to the people who need it, and protect the `master` branch.

npm/npx installs are unaffected; they never update themselves.

## Architecture

```
src/
├─ agents/                one file per AI — this is the extension point
│   ├─ types.ts               AgentDefinition, the core contract
│   ├─ registry.ts            central registry
│   └─ claude.ts · codex.ts · grok.ts · antigravity.ts · direct-api.ts
├─ core/                  the framework; untouched when adding an agent
│   ├─ command-builder.ts     model routing and command assembly
│   ├─ process-service.ts     MCP job management
│   ├─ file-process-service.ts file-backed job management (CLI)
│   ├─ job-store.ts · job-runner.ts shared durable store and detached runner
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

Claude, Codex, Grok and Windows Antigravity (ConPTY) jobs run under a detached runner and outlive their MCP server or
CLI launcher. A restarted MCP server recovers only jobs dispatched by the same
principal process, verified by PID plus OS creation time; recovered results include
`recovered: true`. Recovery observes existing work and never reruns or retries it.
A recorded exit determines completion; a live verified runner stays running; if
both runner and worker are gone without an exit record, the job becomes `lost`
and its output remains available. The public PID identifies the runner.
POSIX Antigravity and `direct-api` remain unrecoverable across MCP
restarts and cannot be adopted. Windows ConPTY workers are held by the detached runner;
PTY stdout combines both streams and strips ANSI, while stderr holds runner errors.
`direct-api` starts no subprocess at all: on the CLI it runs in-process and blocks until the request
finishes, while the MCP server still returns a PID immediately.

The principal is the first ancestor outside the package launcher chain. Command-line
inspection skips `npx-cli.js`, `npm-cli.js exec`/`x`, and the `cmd.exe` or POSIX `sh`
wrappers invoking npx/npm exec. It retains a Node process running Claude Code itself.
This supports both direct Node registration and the npx registration shown above.
Unavailable server/principal identity is reported on stderr and retried on later checks.
Command lines are used for identification only and are never saved in job metadata.

## Watching jobs across sessions

Open another terminal using the same state directory:

```sh
ai-cli jobs                  # One table across MCP sessions and CLI jobs
ai-cli jobs --watch          # Refresh every 2 seconds; Ctrl+C exits
ai-cli jobs --json           # JSON array with metadata and timing
ai-cli jobs --running        # Only running jobs; combines with watch/json
ai-cli jobs --watch --json   # One compact JSON array per refresh (NDJSON)
ai-cli adopt                 # Read-only JSON candidates for MCP session adoption
```

The table shows status (spinner / ✓ / ✗ / ? for lost), agent, resolved model and
reasoning effort, a 40-character task summary, elapsed m:ss, the last short event,
and the dispatching process's parent name plus the ai-cli PID. Narrow terminals
truncate columns without wrapping. Parent names can be shells or Node launchers;
if the OS cannot provide a name, the table shows `unknown`.

Claude/Codex/Grok and Windows agy (ConPTY) use `AI_CLI_STATE_DIR/jobs/<UUID>/` (default
`~/.local/state/ai-cli/jobs/`). `meta.json` records the agent, model, effort,
40-character task summary, work folder, session and principal/server/runner/worker
identities. It contains no full prompt. The runner writes metadata and `exit.json`
atomically once each; the exit record includes code, signal, end time, timeout and
kill flags. For lost jobs, the writer records the first confirmed loss in
`lost.json` so a long-silent job's output still gets 30 minutes of retention.
Worker stdout/stderr go directly to open `stdout.log`/`stderr.log` file descriptors.
On Windows, a short-lived launcher starts the runner and exits before the job is
dispatched. The returned PID remains the runner PID. This keeps durable jobs alive
when Claude Code terminates the MCP server's entire process tree on shutdown.
POSIX keeps its existing detached runner; POSIX agy and direct-api remain unrecoverable.
A temporary stdin file carries the prompt independently of the server
and is removed on completion. Logs can contain prompts or model response excerpts.
`bootstrap.json` contains only startup metadata and the runner PID, so a failed meta
write does not make the job invisible. Runner identity lookup retries three times with
250/500 ms backoff; failure records a failed exit, removes stdin, and starts no worker.
A job still missing meta after 30 seconds is reported as lost. If meta cannot be saved
after spawning, the runner stops its newly spawned worker and attempts an error exit.
Grok's prompt file moves into this job directory and follows job retention; unclaimed
staging files have exit/timer cleanup and are swept by GC after six hours.

Readers retain byte offsets, parser progress and a 4 KiB tail per stream. They read
only appended bytes; verbose results read at most 8 MiB per stream on demand and return
`stdoutTruncated`/`stderrTruncated` byte counts when capped. Oversized parsed replies
also carry `agentOutputTruncated`. Read the disk logs for larger output. `ai-cli run`,
`ps`, `result`, `wait` and `jobs` use this same store, so durable jobs need no second
monitoring snapshot. CLI `run` waits up to 15 seconds for the metadata handshake;
timeout still returns PID/jobId, a warning and exit 0. Track that job; do not dispatch again.
`jobs` is read-only and also works with `AI_CLI_WORKER=1`.

### Automatic takeover of orphaned jobs

MCP sessions automatically take over eligible jobs from the same project when the
original dispatching session ends. It runs in the background right after the new
server starts (usually within a few seconds; it never delays `ready` or the first tool
call, and adopted jobs appear on the next `list_processes` / `get_result`), then once
per 60-second GC cycle, including when the new session starts before the old
one closes. No prompt or tool call is normally needed.

The project directory is the MCP server's cwd, captured at construction and stored
as `projectDir` on new MCP jobs. That the stdio MCP cwd equals the session's working
directory was verified only on Claude Code 2.1.296; other versions and MCP clients are
unverified. If the cwd cannot be read (for example, it was deleted), automatic takeover
is disabled; manual adoption is unaffected. New jobs must match that directory exactly;
older jobs without `projectDir` qualify when `workFolder` equals it or is underneath
it, respecting path boundaries. When the project directory is a filesystem root or the
home directory, older jobs qualify only when `workFolder` is exactly that directory
(otherwise every project below it would match); if the home directory cannot be
resolved, only the root rule applies. Windows comparisons ignore case; other
platforms preserve case. This prevents another project's active session from taking your jobs.

Set `AI_CLI_AUTO_ADOPT` to `off`, `0`, `false` or `no` (trimmed, case-insensitive) to
disable automatic takeover; manual adoption remains available. Put it in the **MCP
server's env configuration** (for example Claude Code's MCP config, or
`[mcp_servers.<name>.env]` in codex `config.toml`): codex forwards only allowlisted
environment variables to MCP servers, so a shell export may not reach it.

Workers dispatched by ai-cli (claude / codex / grok) also load the ai-cli MCP, often
with the same project as cwd. **An MCP running under a worker never adopts**: automatic
takeover is disabled and manual `adopt` is refused; otherwise, once the original session
closes, the worker would capture the project's orphans, including its own parent job,
and the user's new session could not get them. Detection has two layers: the
environment has `AI_CLI_WORKER=1` (not blocking when `AI_CLI_ALLOW_NESTED=1`, matching
the dispatch guard), or a runner/worker of an unfinished job is among the MCP process's
ancestors (a fallback for when codex drops the marker; a principal that is itself a
job's worker is matched directly, otherwise at most 4 levels above the principal are
checked, since a runner cannot sit higher). If the ancestor chain cannot be confirmed,
only automatic takeover is disabled.

| Interface | Action |
| --- | --- |
| MCP `adopt` | Manual fallback for cross-project takeover. Omit `pid` and `jobId` to list candidates, or provide either or both to adopt. A PID selects its latest job, and both selectors must agree. |
| CLI `ai-cli adopt` | Read-only candidate JSON. PID/jobId arguments are rejected; use the receiving MCP session's tool. CLI `ps` / `result` / `wait` / `kill` already see all jobs. |

Candidates include `projectDir` (`null` for older jobs) and `autoAdopt`, indicating
whether this MCP would adopt them automatically: within its automatic scope, with the
switch on, and not running under a worker (CLI previews use the current cwd, the switch
and the environment marker). Candidate `model` matches list rows (requested model first),
and `status` comes only from `exit.json` / `lost.json`.

Only durable MCP jobs (Claude, Codex, Grok, and Windows Antigravity/ConPTY) with
`meta.json` and a verified runner identity are eligible. POSIX Antigravity and
`direct-api` cannot be adopted; CLI jobs are visible globally but cannot be adopted.
The original dispatching session must have ended: an absent PID or a different OS
creation identity proves this; identity lookup failure refuses adoption. When the
principal is null (principal identification failed at dispatch), the dispatching MCP
server decides instead: the job is adoptable only once that server is confirmed ended;
if it is still alive or cannot be confirmed, both automatic and manual adoption are
refused, and the error says the dispatching MCP server is still present. Jobs with
neither principal nor server are never adopted automatically (their candidate `autoAdopt`
is false); manual adoption is allowed. Adoption works throughout execution and for
30 minutes after completion, subject to the shared capacity limits below; it never
restarts execution or extends retention. Adopted jobs immediately appear in this
session's `list_processes`, `get_result`, `wait`, `peek` and `kill_process`.
List/result items carry `adopted: true` (not `recovered`, which means the same principal reconnected); list items also include `model`. Verbose results include the complete
`adoptedFrom` history of original principal/server identities and adoption times.

An existing `adopt.lock` always refuses adoption. Automatic takeover skips it and
logs it once per job per server process; a competing completed takeover is skipped
silently. The manual error gives its full path,
holder PID and creation time (or `unknown`). Only after confirming that no session
is adopting this job, such as after the adopting MCP crashed, manually delete that
file and retry. Stale locks are never removed automatically: concurrent stale-lock
removal could delete another session's new lock and let both transfers succeed.

Finished and lost jobs are retained for 30 minutes. Writers collect at startup and
every 60 seconds on an unref timer, removing the oldest finished jobs when the shared store exceeds
100 finished jobs or 500 MiB. Running jobs are preserved. `cleanup_processes`
removes finished jobs immediately, including files. Antigravity/direct-api memory
entries also expire after 30 minutes. Killing a durable job verifies its runner
identity and requests tree termination; the runner records `killed: true` and exits.
Identity lookup failure leaves termination retryable, with kill/timeout flags set only
after a successful termination request. GC renames directories to `<UUID>.deleting`
before deleting; locked deletions are retried, and stale orphan directories are swept
only after the startup grace period and when their runner is absent. Two-second checks
track this server's active jobs; OS identities are cached for up to 60 seconds and shared
with GC, with `kill(pid, 0)` used first for liveness. Kill always rechecks creation identity.

Quota queries stop automatic keys only for interactive update menus (an available-update
heading plus menu choices/cursor, or “Press Enter to update”). Passive npm-to-native
installer hints and update progress do not block queries. Codex can fall back to a recent
session rate-limit record if an update menu blocks its TUI, including a refresh query.

The `live-jobs/` snapshots remain for unrecoverable POSIX Antigravity/direct-api and
6.7.0 compatibility; legacy CLI `cwds/` files can still be read. Their summaries
expire after 30 minutes, and snapshots require a verified live owner. All sessions
must share `AI_CLI_STATE_DIR`. Identity lookup uses CIM on Windows, `/proc` on Linux
and `ps` on macOS; unavailable identity data cannot authorize recovery or killing.
Monitoring summaries keep an 80-character `lastEvent` excerpt that can include a
model response. Legacy CLI jobs with a live PID but unavailable creation identity
remain running with `identityVerified: false` and `[unverified]` in the dispatcher
column; this legacy fallback cannot rule out PID reuse.

### Recovery acceptance and monitoring fixes

Durable jobs are keyed by UUID `jobId`; reusing an OS PID keeps all retained jobs.
PID-based wait/result/peek/kill selects the latest job and returns its `jobId`.
Use MCP `get_result` with both `pid` and `jobId` to read an older retained result.
TTY `jobs --watch` uses the alternate screen and restores the cursor/screen on exit;
non-TTY and JSON watch output remains append-only.

Codex `query_usage` reads live quota via `codex app-server` stdio JSON-RPC first, for both fresh and non-fresh queries. It does not create a thread or spend model tokens. On RPC failure, non-fresh queries may use a session event up to 10 minutes old; otherwise the final fallback opens the TUI. `/status` must echo in the rendered input line before Enter is sent. Existing 120-second service caching remains; `refresh=true` bypasses that cache. Results include `source`, `asOf` (RPC/session), `cliVersion`, failure `fallbackReasons`, and warnings for untested TUI versions (tested: 0.162.1). RPC quota windows include used/remaining percentages, readable `resetAt`, ISO `resetAtIso`, plan, reset credits, and a readable `raw` summary. Missing quota always returns error.

`query_usage` launches Codex with `-c check_for_update_on_startup=false`, including
its fallback without `--no-daemon`. Codex and Claude update prompts stop automated
keys and return an error. This does not alter the user's global configuration.

## Claude Code job panel（optional plugin）

The `ai-cli-jobs` plugin shows jobs as a table above the input box and a one-line
summary in the hint line below it. The columns are status, source, model, task
and time: the status is spelled out (✅ 成功 done, ❌ 失敗 failed, ❔ 中斷 lost = the
process vanished without a result, ➖ 不追蹤 untracked), a coloured dot before the
model marks the vendor (🟠 claude, 🟢 codex, ⚫ grok, 🔵 gemini, 🟣 other APIs), a
running job shows its elapsed time and a finished one how long ago it ended.

- **Jobs this session dispatched**: polled through `list_processes` every 0.5
  seconds while any is running; a finished one stays 2 minutes.
- **Jobs from other sessions, subagents and other projects**: read straight from
  the job store (`AI_CLI_STATE_DIR` or `~/.local/state/ai-cli/jobs/`) every 5
  seconds, the source column saying same project or other project; a finished
  one stays 10 minutes, and 💤 marks a running job whose stdout has not moved for
  5 minutes. A job this session's subagent dispatched cannot be told apart in the
  store and counts as same project.

Neither consumes model tokens. The ai-cli MCP server must be configured with the
name `ai-cli`.

### Install

From the prompt in a Claude Code terminal session:

```text
/plugin install ai-cli-jobs --marketplace moerasermax/tkflyc-ai-cli
```

When asked whether to add the marketplace, press `y`, then select the install
scope. That marketplace is this repository (`.claude-plugin/marketplace.json`),
**not** Anthropic's official plugin directory.

### Updating: on every machine, by hand

**The panel does not update with ai-cli.** It is not in the npm package
(`files` in `package.json` leaves out `plugins/`), and ai-cli's auto-update (a
git pull) does not reach it either: Claude Code runs the copy it placed in
`~/.claude/plugins/cache/` at install time. Install it once on each machine,
then update it there after each release:

```text
claude plugin marketplace update tkflyc-ai-cli
claude plugin update ai-cli-jobs@tkflyc-ai-cli
```

Restart Claude Code for the update to apply; `claude plugin list` shows the
installed version. The `/plugin` menu inside Claude Code does the same.

### `auto` permission mode and uninstalling

If Claude Code runs in `auto` permission mode, add `mcp__ai-cli__list_processes`
to `permissions.allow` in `~/.claude/settings.json`. The panel polls in the
background, where there is no auto-mode classifier to ask, so Claude Code denies
the call (fail closed): the row keeps spinning and shows `輪詢失敗：… refused`.

Uninstall from the Claude Code prompt:

```text
/plugin uninstall ai-cli-jobs@tkflyc-ai-cli
```

### Optional: a status line instead

Without the plugin, or to keep seeing every job while the MCP is disconnected,
use `tools/statusline/ai-cli-status.mjs`: a Claude Code `statusLine` command that
reads the job store and prints one line at the bottom of the screen. Its header
says how to enable it (a `statusLine` entry in `~/.claude/settings.json`). It is
not in the npm package either; get it from git.

## ai-cli_kernel: supervised agent runs

`ai-cli kernel dashboard` opens a full-screen terminal dashboard with confirmation before changes; `--new-tab` supports Windows Terminal only. Existing real CLI use has been on Windows only; this dashboard has not had live TTY/Windows Terminal or other-platform validation.

Give it a goal and a mandate. It plans with a tool-less model call, dispatches workers, verifies the deliverable with deterministic checks, and recovers across restarts without re-dispatching finished steps. The default read-only template checks every cited `path:line`. Workers are **not isolated**.

```
ai-cli kernel probe --agent codex
ai-cli kernel start --goal "Audit X for Y" --cwd /path/to/repo
ai-cli kernel approve <run>
ai-cli kernel wait <run>
ai-cli kernel result <run>
```

Two templates exist. `readonly-audit` (default) uses tool-limited read-only mode. `develop` changes code: each run gets its own git worktree and branch, and the kernel itself runs your test command and only accepts a commit that passes it. It does not automatically merge or push the delivery branch. Before work starts, the default checkpoint uses a dedicated ref and pushes it when an `origin` exists; a failed checkpoint push stops work. Workers in `develop` run with your full user permissions and your full CLI configuration, including MCP servers. **It is not isolated**, and approving it requires an explicit acknowledgement. Only use it on projects you trust.

Version 7.0.0 is not yet published to npm. Obtain the source from GitHub and run `npm install` and `npm run build` (see [Quick start](#quick-start)); Node `^20.19.0 || >=22.12.0`, an installed and authenticated Codex CLI, and ai-cli MCP registration are prerequisites. Kernel has only been exercised on one Windows machine; Linux and macOS have not been practically tested. Stub coverage does not establish those platforms' behavior.

Reusable mandates support `kernel mandate save/approve/list/show/revoke`. Approval expires after 30 days by default; saving again or revoking clears it. One-shot `kernel trigger <name>` uses an independent, default-off `kernel triggers on|off` switch and a persistent daily run/token ledger. `kernel schedule <name> --daily HH:MM` previews the command; Windows registers it only with `--apply`, while POSIX only prints a crontab line. Triggered runs cannot disable checkpoints or use single-use release. See the tutorial for commands and operational limits.

Memory always starts as a candidate, including a human request to remember something; it becomes active only after the user promotes it. Archive packets collect recorded facts for you to read or have an AI organize into your own notes; marking a run archived writes only local state, not external services. A worktree and branch isolate delivery history, not permissions: full-permission workers and hooks can affect other locations, so review the report and diff before accepting.

The MCP tools (`ai-cli_kernel_*`) are off by default and reject calls while disabled; `ai-cli kernel enable` turns them on, then reconnect the MCP client. `AI_CLI_KERNEL=on|off` overrides the saved setting. The CLI is available independently of this switch. Existing MCP tool names and parameter interfaces remain compatible. Kernel integration adds the CLI subcommand, default-off MCP tools, and a guard in `JobStore.start`: an ai-cli process with `AI_CLI_WORKER=1` and without `AI_CLI_ALLOW_NESTED=1` rejects dispatch even through direct JobStore calls (also reached by FileProcessService and ProcessService). Ordinary main sessions without that worker marker are not blocked by this guard. CLI run/exec and MCP run already had entry guards; `spawnPty` is intentionally unchanged because the authorized runner also carries the worker marker. This checks the current ai-cli environment, not every vendor process, and is not an OS sandbox. Other 7.0.0 changes to direct-api routing/settings and updater notices are documented separately in [CHANGELOG](CHANGELOG.md#700---2026-11-07). Docs (Traditional Chinese): [tutorial](https://github.com/moerasermax/tkflyc-ai-cli/blob/master/docs/ai-cli_kernel/教學手冊.md), [technical manual](https://github.com/moerasermax/tkflyc-ai-cli/blob/master/docs/ai-cli_kernel/技術手冊.md).

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

Durable MCP/CLI jobs become `lost` when both tracked processes disappear without
a completion record. The output remains available and the outcome is unknown.

## Relationship to the original project

This project began as a clone of [mkXultra/ai-cli-mcp](https://github.com/mkXultra/ai-cli-mcp)
(MIT), which is itself derived from Peter Steinberger's `claude-code-mcp` (MIT).
**Upstream is not abandoned** — its latest release is `3.1.0`, published on 2026-09-30
(checked 2026-11-07). This is not a rescue of an abandoned project; it is a fork that
diverged on architecture. If you want the original, use
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

Maintainer acceptance procedures (worker identity, restart recovery, Grok read-only enforcement) are in [tools/acceptance/README.md](tools/acceptance/README.md).
