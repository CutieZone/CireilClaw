# Conditional Block Loading and Path Access

The `conditions.toml` config file enables conditional access to resources based on session context. This allows you to:

- Load additional memory blocks only in appropriate contexts (e.g., NSFW content in NSFW channels)
- Grant or restrict access to specific files/folders based on where the session is running (e.g., admin tools only in specific Discord channels)

## Note

This currently shouldn't affect the `exec` tool due to the fact that there are near-infinite ways to bypass path checks.

## Config Location

`~/.cireilclaw/agents/{slug}/config/conditions.toml`

## Config Format

```toml
# Conditional blocks (loaded from blocks/conditional/{name}.md)
[blocks.nsfw]
when = ["discord:nsfw", "discord:dm"]
mode = "or"
action = "load"

[blocks.intimate]
when = "discord:dm:123456789"
action = "load"

# Path access rules for /memories/
[memories."/private/"]
when = ["discord:dm"]
action = "allow"

[memories."/admin/"]
when = "discord:channel:987654321"
action = "allow"

# Path access rules for /workspace/
[workspace."/deploy/"]
when = ["discord:guild:123456789"]
action = "allow"
```

## Supported Conditions

| Condition                     | Meaning                                 |
| ----------------------------- | --------------------------------------- |
| `discord:nsfw`                | NSFW-flagged Discord channel            |
| `discord:dm`                  | Any Discord DM (no guild)               |
| `discord:dm:{channelId}`      | Specific Discord DM channel             |
| `discord:guild:{guildId}`     | Specific Discord guild (server)         |
| `discord:channel:{channelId}` | Specific Discord channel                |
| `tui`                         | TUI session (run via `pnpm start tui`)  |
| `internal`                    | Internal session (heartbeat, cron jobs) |

## Logic Modes

Arrays of conditions support two modes:

- `mode = "or"` (default) - Allow if **any** condition matches
- `mode = "and"` - Allow only if **all** conditions match

```toml
# Allow in NSFW channels OR DMs (default behavior)
[blocks.nsfw]
when = ["discord:nsfw", "discord:dm"]
action = "load"

# Require both NSFW AND a specific guild
[blocks.restricted]
when = ["discord:nsfw", "discord:guild:123456789"]
mode = "and"
action = "load"
```

## Actions

| Action  | Applies To              | Meaning                            |
| ------- | ----------------------- | ---------------------------------- |
| `load`  | `blocks`                | Include the block in system prompt |
| `allow` | `memories`, `workspace` | Grant access to the path           |
| `deny`  | `memories`, `workspace` | Block access to the path           |

## Conditional Blocks

Create conditional memory blocks in `~/.cireilclaw/agents/{slug}/blocks/conditional/` with TOML frontmatter:

**`blocks/conditional/nsfw.md`**

```markdown
+++
name = "nsfw"
description = "Guidelines for handling mature content"
+++

You are in an NSFW context. The following guidelines apply:
...
```

When conditions match, these blocks are added to the system prompt just like the core blocks.

## Path Access Rules

Path rules control access to files in `/memories/` and `/workspace/`.

### Rule Matching

- Paths ending with `/` match as **prefixes** (e.g., `/nsfw/` matches `/nsfw/` and `/nsfw/anything.md`)
- Paths not ending with `/` require **exact match** (e.g., `/secret.md` only matches `/secret.md`)

### Access Evaluation

Access is evaluated in this order:

1. **Baseline sandbox validation** - Path must be within allowed sandbox areas
2. **Deny rules** - If a deny rule matches the current context, access is blocked
3. **Allow rules** - If an allow rule matches the current context, access is granted
4. **Default** - If no rules match the path, access is allowed (baseline behavior)

### Example: Restricting Admin Tools

```toml
# Block TUI access to admin folder
[workspace."/admin/"]
when = "tui"
action = "deny"

# Allow only in specific channel
[workspace."/admin/"]
when = "discord:channel:987654321"
action = "allow"
```

In this example:

- TUI sessions are **blocked** from `/admin/`
- Only Discord channel `987654321` can **access** `/admin/`
- All other contexts are **blocked** (rule exists but doesn't match)

## Hot Reload

Changes to `conditions.toml` are automatically reloaded when using `pnpm start run`. No restart required.

## Examples

### NSFW Content Handling

```toml
# Load NSFW guidelines only in NSFW channels or DMs
[blocks.nsfw]
when = ["discord:nsfw", "discord:dm"]
action = "load"

# Restrict NSFW memories to NSFW contexts
[memories."/nsfw/"]
when = ["discord:nsfw", "discord:dm"]
action = "allow"
```

### Private Notes (DM Only)

```toml
# Private thoughts block only in DMs
[blocks.private]
when = "discord:dm"
action = "load"

# Private notes folder only in DMs
[memories."/private/"]
when = "discord:dm"
action = "allow"
```

### Channel-Specific Tools

```toml
# Deploy scripts only in specific channel
[workspace."/deploy/"]
when = "discord:channel:111222333"
action = "allow"

# Block deploy access everywhere else (implicit deny)
```

### Multi-Factor Access

```toml
# Require both guild membership AND specific channel
[workspace."/super-admin/"]
when = ["discord:guild:123456789", "discord:channel:987654321"]
mode = "and"
action = "allow"
```

## Troubleshooting

### Access Denied Errors

If you see:

```
Access denied: path '/memories/private/' is not accessible in the current context (channel: discord, nsfw: false)
```

Check:

1. The path exists in your `conditions.toml` rules
2. The current session context matches the `when` conditions
3. No `deny` rules are taking precedence

### Blocks Not Loading

If a conditional block isn't appearing in the system prompt:

1. Verify the block file exists in `blocks/conditional/{name}.md`
2. Check the TOML frontmatter is valid (starts and ends with `+++`)
3. Confirm the session context matches the `when` conditions
4. Check agent logs for config parsing errors

### Testing Conditions

Use the TUI to test conditions with different contexts:

```bash
# Test with TUI (matches "tui" condition)
pnpm start tui myagent

# Test with Discord (matches "discord:*" conditions)
pnpm start run
```
