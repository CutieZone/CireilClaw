# Installation

CireilClaw exists so agents can act freely without making their mistakes catastrophic. It is designed as a guarantor: sandboxing, tool allowlists, and per-agent configuration give the agent room to operate while keeping the operator safe when the agent gets something wrong.

## Prerequisites

- **Linux** — CireilClaw relies on Linux kernel namespaces via [bubblewrap](https://github.com/containers/bubblewrap) or [Incus](https://linuxcontainers.org/incus/) for sandboxing. macOS/Windows users need a Linux VM or WSL2.
- **Node.js** — v22+ recommended.
- **pnpm** — Package manager.
- **bubblewrap** (`bwrap`) — Must be available on `PATH`.
- **Incus** (`incus`) — Required only when `backend = "incus"`. Initialize its daemon and restrict Unix-socket access to the trusted runtime user.

<details>
<summary>NixOS (recommended)</summary>

The included `flake.nix` provides everything. With [direnv](https://direnv.net/) configured:

```sh
cd cireilclaw
direnv allow   # automatically enters the dev shell
```

Or manually:

```sh
nix develop
```

This gives you `node`, `pnpm`, `bwrap`, `incus`, and `vips` (needed by sharp).

</details>

<details>
<summary>Debian / Ubuntu</summary>

```sh
sudo apt install nodejs npm bubblewrap libvips-dev
npm install -g pnpm
```

</details>

<details>
<summary>Fedora</summary>

```sh
sudo dnf install nodejs npm bubblewrap vips-devel
npm install -g pnpm
```

</details>

<details>
<summary>Arch Linux</summary>

```sh
sudo pacman -S nodejs npm bubblewrap libvips
npm install -g pnpm
```

</details>

<details>
<summary>Running in a container (advanced)</summary>

If you are running CireilClaw inside a container that already provides isolation, you can disable the bubblewrap sandbox and run commands directly in the container environment:

```sh
CIREILCLAW_RUNTIME_INSECURE_DISABLE_SANDBOX_I_AM_100_PERCENT_SURE=i-am-in-a-container pnpm start
```

This bypasses `bwrap` entirely. Only use this when the container itself is the security boundary; in that mode, the container is taking over the guarantor role that CireilClaw normally assigns to bubblewrap.

</details>

## Clone and install

```sh
git clone https://github.com/CutieZone/CireilClaw.git
cd CireilClaw
pnpm install
```

## Create an agent

The interactive `init` wizard sets up a new agent with all required files:

```sh
pnpm start init
```

You will be prompted for:

1. **Agent name** — Slugified to a filesystem-safe identifier (e.g. "My Bot" becomes `my-bot`).
2. **Short description** — Optional. Seeded into the identity block.
3. **Tool preset** — Writes the initial `tools.toml` tool configuration:
   - `minimal` — Core file/context tools plus `respond`/`no-response`.
   - `standard` — Enables the core tools plus non-exec built-ins such as write/edit, session/history lookup, attachment download, scheduling, and reactions.
   - `full` — Standard plus sandboxed command execution (prompts for the Bubblewrap binary allowlist in `sandbox.toml`).

   Core tools start enabled in generated configs, but they are not immutable. You can explicitly set any core tool to `false` in `tools.toml` if you accept the consequences; disabling `respond`/`no-response` prevents normal turns from completing.

4. **API endpoint** — Base URL of any OpenAI-compatible API (e.g. `https://api.openai.com/v1`).
5. **Model name** — The model identifier to use.
6. **API key** — Leave blank if the endpoint doesn't require one.
7. **Brave Search key** — Optional. Required if the `brave-search` plugin is enabled.
8. **Channel** — `none` or `discord`. Discord requires a bot token and your user ID.

This creates the full directory tree at `~/.cireilclaw/agents/{slug}/`:

```
blocks/              # Memory blocks (person.md, identity.md, long-term.md, soul.md, style-notes.md)
config/              # engine.toml, tools.toml, heartbeat.toml, cron.toml, sandbox.toml, conditions.toml, channels/discord.toml
core.md              # Base system instructions
skills/              # Reusable skill documents
workspace/           # Sandboxed working directory
memories/            # Agent-managed persistent files
```

All five block files and `core.md` are **required** — the engine will refuse to start without them. The init wizard creates templates for each.

## Configuration reference

All configuration lives under `~/.cireilclaw/`. Global configs apply to all agents; per-agent configs override them.

<details>
<summary><code>config/engine.toml</code> (per-agent, required)</summary>

```toml
[default]
apiBase = "https://api.openai.com/v1"   # OpenAI-compatible base URL
apiKey = "sk-..."                       # Optional, defaults to "not-needed"
defaultModel = "gpt-4o"                 # Model identifier
isGlobalDefault = true                  # One provider must have this set to true
kind = "openai"                         # "openai", "anthropic", or "openai-codex"
maxTurns = 30                           # Conversation turns sent to the API
```

For ChatGPT subscription-backed Codex access, authenticate once and use the `openai-codex` provider:

```bash
cireilclaw codex
```

```toml
[codex]
kind = "openai-codex"
apiBase = "https://chatgpt.com/backend-api"
authId = "default"
defaultModel = "gpt-5.1-codex-medium"
isGlobalDefault = true
availableModels = ["gpt-5.1-codex-medium", "gpt-5.2-codex-high", "gpt-5.5-codex-high"]
```

Per-guild model overrides are supported:

```toml
[channel.discord.guild]
"guild-id" = { model = "gpt-4o-mini" }
```

Provider requests use fixed internal deadlines rather than configuration fields.
Single-response requests have a ten-minute hard deadline.
Codex streaming requests have a 30-second initial-response deadline and a 120-second idle deadline between stream chunks, so long-running reasoning streams are not cut off by a total duration limit.

</details>

<details>
<summary><code>config/plugins.toml</code> (global, optional)</summary>

```toml
[[plugins]]
package = "@cireilclaw/plugin-brave-search"
```

</details>

<details>
<summary><code>config/tools.toml</code> (per-agent, required)</summary>

Each key is a tool name. Simple tools use `true`/`false`; `exec` either uses `false` or its config table. A tool is enabled only when it is present and set to `true` (or, for `exec`, when `enabled = true`).

Core tools are generated as enabled by every preset because the agent needs them for normal operation, but they can still be explicitly disabled by setting them to `false`.

```toml
# Core tools: generated enabled, but explicitly configurable.
respond      = true
no-response  = true
read         = true
open-file    = true
close-file   = true
list-dir     = true
read-skill   = true
session-info = true

# Non-exec built-ins enabled by the standard/full presets.
write                = true
str-replace          = true
read-sections        = true
schedule             = true
react                = true
download-attachments = true
read-history         = true
list-sessions        = true
query-sessions       = true
read-session         = true
prune-boundaries     = true

[exec]
enabled  = true
inline   = true                  # Inline small output; default: true
inlineThresholdBytes = 16384     # Combined stdout/stderr threshold
timeout  = 60000                 # ms, minimum 1000
hostEnvPassthrough = []          # Host env vars to pass through
```

</details>

<details>
<summary><code>config/channels/discord.toml</code> (per-agent, required for Discord)</summary>

```toml
token = "your-bot-token"
ownerId = "your-discord-user-id"
# timeout = 60000 # Discord REST request timeout in ms. Default: 60000

[access]
mode = "disabled"             # "disabled", "allowlist", or "denylist"
users = []                    # Array of Discord user IDs

[directMessages]
mode = "owner"                # "owner", "public", "allowlist", or "denylist"
users = []                    # Array of Discord user IDs
```

</details>

<details>
<summary><code>config/heartbeat.toml</code> (per-agent, optional)</summary>

Runs a periodic checklist from `workspace/HEARTBEAT.md`:

```toml
enabled = false
interval = 1800           # Seconds between pulses, minimum 60
target = "last"           # "last", "none", or a session ID

[activeHours]
start = "08:00"
end = "22:00"             # Use "00:00" for end of day
timezone = "America/New_York"

[visibility]
showAlerts = true         # Send non-OK results to channel
showOk = false            # Send OK results to channel
useIndicator = true       # Show typing indicator
```

</details>

<details>
<summary><code>config/cron.toml</code> (per-agent, optional)</summary>

```toml
[[jobs]]
id = "daily-summary"
prompt = "Generate a daily summary"
enabled = true
execution = "isolated"     # "main" or "isolated"
delivery = "announce"      # "announce", "webhook", or "none"
target = "last"            # Session target for announce delivery

# Schedule — pick one:
schedule = { every = 86400 }
# schedule = { cron = "0 9 * * *" }
# schedule = { at = "2026-03-05T09:00:00Z" }
```

</details>

<details>
<summary><code>config/sandbox.toml</code> (per-agent, optional)</summary>

Defines the command-execution backend and custom bind mounts that appear under `/workspace/` in the sandbox.

See the backend references for the complete behavior and security model: [Bubblewrap](docs/sandbox/bwrap.md) and [Incus](docs/sandbox/incus.md).

```toml
[bwrap]
binaries = ["git", "python3"]

[[mounts]]
source = "/home/user/projects/my-app"
target = "project"
mode = "rw"
```

`backend` defaults to `"bwrap"`. To give an agent a persistent Incus system container, select `"incus"` and supply an image reference:

```toml
backend = "incus"

[incus]
image = "images:fedora/42"
profiles = []
```

The first command creates an instance named `cireilclaw-<agent slug>` and sets its runtime hostname to the agent slug before each agent command; later commands execute in the same instance. The runtime adds read-write disk devices for `/workspace`, `/memories`, `/skills`, and `/tasks`, and a read-only device for `/blocks`. It maps the caller's host UID/GID to the same IDs in the container, preserving two-way access to those host-owned directories. Incus executes whatever is installed in the selected image; the `[bwrap]` binary list applies only to Bubblewrap. Custom mount sources must be allowed by the selected Incus project.

Omit `project` to use the caller's Incus project (normally the restricted `user-<uid>` project for an `incus` group member). That project must allow `raw.idmap` and permit the runtime user's UID/GID with `restricted.idmap.uid` and `restricted.idmap.gid`; this remains limited to that one user identity. Set `project` only when the runtime has access to a specific operator-managed project. Incus's local Unix socket and `incus-admin` membership grant broad host authority. They are runtime-only integration points: never expose them, the client configuration, or an `incus` binary to the agent container.

</details>

<details>
<summary><code>config/conditions.toml</code> (per-agent, optional)</summary>

Controls conditional block loading and path access based on session context. See <a href="docs/conditions.md">docs/conditions.md</a> for the full reference.

</details>

<details>
<summary>Sandbox environment variables</summary>

The agent's `workspace/.env` file is injected into sandboxed `exec` commands. Standard `KEY=VALUE` format. This does **not** affect the main process.

</details>

## Run

```sh
pnpm start                     # Start with default log level (debug)
pnpm start run --logLevel info # Start with info-level logging
```

Logs are written to `~/.cireilclaw/logs/cireilclaw.log`.

The database (`sessions.db`) is created automatically per agent and migrations run on every startup — no manual migration step is needed.

## Managing sessions

Clear sessions for an agent:

```sh
pnpm start clear                   # Prompts for agent if multiple exist
pnpm start clear --agent my-bot    # Target a specific agent
```

You can clear individual sessions or all sessions at once.

## Writing memory blocks

Each block file in `blocks/` uses TOML frontmatter between `+++` delimiters followed by markdown content:

```markdown
+++
summary = "Brief description of this block"
+++

Content goes here.
```

The five required blocks:

| File             | Purpose                            |
| ---------------- | ---------------------------------- |
| `person.md`      | Info about the person being served |
| `identity.md`    | The agent's own identity           |
| `long-term.md`   | Curated long-term memory           |
| `soul.md`        | Core personality and philosophy    |
| `style-notes.md` | Communication style guidelines     |

## Writing skills

Skills live in `skills/` and follow the same frontmatter format with additional required fields:

```markdown
+++
summary = "What this skill does"
whenToUse = "When the agent should use this skill"
+++

Skill instructions here.
```

The agent can load skills on demand via the `read-skill` tool.
