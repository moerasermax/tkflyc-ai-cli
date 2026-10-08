# Security Policy

## Threat model

ai-cli-mcp is designed to run **on the operator's own machine**, spawning local AI
CLIs on their behalf. It is not a network service and has no authentication layer,
because it is not intended to be reachable by anyone but the local user.

Two consequences follow, and they are the security-relevant facts about this project:

1. **It executes local binaries.** A caller that can reach the MCP surface can start
   the configured CLIs with attacker-chosen prompts and arguments. Do not expose the
   MCP server, the `ai-cli` command, or the detached runner to untrusted input or to
   a network boundary.
2. **It reads provider credentials.** API keys for third-party OpenAI-compatible
   providers live in `providers.json` under the user's data directory, in plaintext,
   by design. Anything that can read that file can use those keys, including any
   process running as you, such as a dispatched agent. Protecting them is the
   operator's job: put a spending limit on each key, keep the file out of backups,
   synced folders and repositories, and `chmod 600` it on shared POSIX hosts.
   The reasoning is in [#9](https://github.com/moerasermax/tkflyc-ai-cli/issues/9).

If you are considering running this in a shared, multi-tenant, or CI context, the
answer is that it was not built for that.

## Supported versions

| Version | Supported |
|---|---|
| 6.x | ✅ |
| ≤ 5.x | ❌ |

Fixes land on `master` and ship in the next release. There are no backports.

## Reporting a vulnerability

Email **tkflyc0509@gmail.com** with `[ai-cli-mcp security]` in the subject.

Please include what you ran, what happened, and what you expected — a minimal
reproduction is worth more than a severity rating. I am a solo maintainer, so
expect an acknowledgement within about a week rather than within hours.

Please do not open a public issue for anything that lets an attacker read
credentials or execute code outside the intended local-user boundary. For
everything else, a normal issue is fine and usually faster.
