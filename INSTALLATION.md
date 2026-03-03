# Installation

## Prerequisites

- **Linux** — cireilclaw relies on Linux kernel namespaces via [bubblewrap](https://github.com/containers/bubblewrap) for sandboxing. macOS/Windows users need a Linux VM or WSL2.
- **Node.js** — v22+ recommended.
- **pnpm** — Package manager.
- **bubblewrap** (`bwrap`) — Must be available on `PATH`.

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

This gives you `node`, `pnpm`, `bwrap`, and `vips` (needed by sharp).

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
3. **Tool preset** — Controls which tools are available:
   - `minimal` — File I/O and respond only.
   - `standard` — Adds write, search, scheduling, reactions.
   - `full` — Adds sandboxed command execution (prompts for an allowed binaries whitelist).
4. **API endpoint** — Base URL of any OpenAI-compatible API (e.g. `https://api.openai.com/v1`).
5. **Model name** — The model identifier to use.
6. **API key** — Leave blank if the endpoint doesn't require one.
7. **Brave Search key** — Optional. Required if the `brave-search` tool is enabled.
8. **Channel** — `none` or `discord`. Discord requires a bot token and your user ID.

This creates the full directory tree at `~/.cireilclaw/agents/{slug}/`:

```
blocks/              # Memory blocks (person.md, identity.md, long-term.md, soul.md, style-notes.md)
config/              # engine.toml, tools.toml, heartbeat.toml, cron.toml, channels/discord.toml
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
apiBase = "https://api.openai.com/v1"   # OpenAI-compatible base URL
model   = "gpt-4o"                       # Model identifier
apiKey  = "sk-..."                       # Optional, defaults to "not-needed"
```

Per-guild model overrides are supported:

```toml
[channel.discord.guild]
"guild-id" = { model = "gpt-4o-mini" }
```

</details>

<details>
<summary><code>config/integrations.toml</code> (global, optional)</summary>

```toml
[brave]
apiKey = "BSA..."
```

</details>

<details>
<summary><code>config/tools.toml</code> (per-agent, required)</summary>

Each key is a tool name; value is `true`/`false`. Unspecified tools default to enabled.

```toml
respond       = true
read          = true
write         = true
open-file     = true
close-file    = true
list-dir      = true
str-replace   = true
brave-search  = true
read-skill    = true
schedule      = true
session-info  = true
react         = true
no-response   = true

[exec]
enabled  = true
binaries = ["git", "python3"]    # Allowed commands whitelist
timeout  = 60000                 # ms, minimum 1000
```

</details>

<details>
<summary><code>config/channels/discord.toml</code> (per-agent, required for Discord)</summary>

```toml
token   = "your-bot-token"
ownerId = "your-discord-user-id"
```

</details>

<details>
<summary><code>config/heartbeat.toml</code> (per-agent, optional)</summary>

Runs a periodic checklist from `workspace/HEARTBEAT.md`:

```toml
enabled  = false
interval = 1800           # Seconds between pulses, minimum 60

[activeHours]
start    = "08:00"
end      = "22:00"
timezone = "America/New_York"

[visibility]
showAlerts   = true       # Send non-OK results to channel
showOk       = false      # Send OK results to channel
useIndicator = true       # Show typing indicator
```

</details>

<details>
<summary><code>config/cron.toml</code> (per-agent, optional)</summary>

```toml
[[jobs]]
id        = "daily-summary"
prompt    = "Generate a daily summary"
execution = "isolated"     # "main" or "isolated"
delivery  = "announce"     # "announce", "webhook", or "none"
target    = "last"         # Session target for announce delivery

# Schedule — pick one:
every = 86400              # Every N seconds
# cron  = "0 9 * * *"     # Cron expression
# at    = "2026-03-05T09:00:00Z"   # One-shot
```

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
