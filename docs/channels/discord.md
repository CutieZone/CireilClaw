# Discord Channel

The Discord channel handler connects an agent to a Discord bot. It handles message sending, receiving, history, reactions, slash commands, and attachments — everything needed for the agent to operate in guild channels and DMs.

## Configuration

The channel is configured per-agent at `~/.cireilclaw/agents/<slug>/config/channels/discord.toml`.

### Minimal

```toml
token = "MTxxxxxxxxxxxxxxxxxxxxxxxx.xxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
ownerId = "123456789012345678"
```

### Full

```toml
token = "MTxxxxxxxxxxxxxxxxxxxxxxxx.xxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
ownerId = "123456789012345678"

# REST request timeout in ms (default 60000)
timeout = 30000

# Restrict which users can send messages the agent sees
access = { mode = "allowlist", users = ["123456789012345678"] }

# Restrict DM access
directMessages = { mode = "owner", users = [] }
```

### Fields

| Field            | Required | Default    | Description                                             |
| ---------------- | -------- | ---------- | ------------------------------------------------------- |
| `token`          | Yes      | —          | Bot token from the Discord Developer Portal             |
| `ownerId`        | Yes      | —          | Discord user ID of the bot operator (numeric snowflake) |
| `timeout`        | No       | `60000`    | REST request timeout in milliseconds                    |
| `access`         | No       | `disabled` | Access restriction for guild channels (see below)       |
| `directMessages` | No       | `"owner"`  | DM access mode (see below)                              |

### Access Modes

Controls who can interact with the agent in guild channels.

| Mode        | Behavior                                           |
| ----------- | -------------------------------------------------- |
| `disabled`  | Anyone can interact (default)                      |
| `allowlist` | Only users in `users` can interact, plus the owner |
| `denylist`  | Everyone can interact except users in `users`      |

The `ownerId` user always bypasses access control regardless of mode.

### Direct Message Modes

Controls who can DM the agent.

| Mode        | Behavior                                     |
| ----------- | -------------------------------------------- |
| `owner`     | Only the owner can DM (default)              |
| `public`    | Anyone can DM                                |
| `allowlist` | Only users in `users` can DM, plus the owner |
| `denylist`  | Everyone can DM except users in `users`      |

## Message Processing

Messages are processed when the agent is mentioned, replied to, or sent via DM (depending on DM mode). The bot reads the last 50 messages for context on each turn, crawling reply chains for full thread context.

The bot responds in the same channel. Long responses are automatically split at sensible boundaries (code fences, line breaks) to stay under Discord's 2000-character limit.

### History

Messages maintain session history across turns. If a message is deleted from Discord (by anyone with permission), the bot removes it from its internal history on the next turn. This keeps the agent from referencing deleted content.

## Slash Commands

All slash commands are restricted to the configured `ownerId`.

| Command        | Description                                |
| -------------- | ------------------------------------------ |
| `/clear`       | Reset conversation history for the channel |
| `/close`       | Close an open file in the current session  |
| `/invite`      | Get an invite link for the bot             |
| `/model`       | Switch the provider/model for this session |
| `/repair`      | Repair corrupted Discord media attachments |
| `/stop`        | Gracefully stop the current generation     |
| `/summarize`   | Summarize the conversation history         |
| `/unsummarize` | Remove the most recent summary             |

## Owner Reactions

The owner (user matching `ownerId`) can react to the bot's messages to trigger actions. These work in any channel the bot can see.

| Reaction | Behavior                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| ✨       | **Delete error messages only.** If the bot's message is an engine or Discord error, delete it. No reroll.                         |
| ❌       | **Delete single message.** Delete the message from Discord and remove it from session history. Does not touch other messages.     |
| 🔄       | **Delete + reroll.** Delete the message from Discord, remove it and everything after it from history, then regenerate a response to the preceding user message. |

The ✨ reaction only acts on error messages (starting with "⚠️ Engine error", ":warning: Engine error", "⚠️ Discord error", or ":warning: Discord error"). ❌ and 🔄 work on any bot message.

❌ removes only the single reacted-to message from history — conversation entries before and after are left intact.

🔄 removes the reacted-to message plus everything after it (rewinding to that point), then generates a new response. If no user message remains after the splice (e.g., reacting to the very first message in a session), the deletion happens but no reroll occurs.

Reactions from non-owner users are silently ignored. Reactions on non-bot messages are ignored.

## Required Intents

The bot registers the following gateway intents:

- `GUILD_MESSAGES`
- `DIRECT_MESSAGES`
- `MESSAGE_CONTENT`
- `GUILD_MESSAGE_REACTIONS`
- `DIRECT_MESSAGE_REACTIONS`

These must be enabled in the Discord Developer Portal under the bot's settings.

## Supported Content

### Images

The bot accepts common image formats (PNG, JPEG, GIF, WebP). Images are converted to WebP before being sent to the model. Stickers are also fetched and converted to WebP (LOTTIE format stickers are skipped as they cannot be rasterized).

### Videos

The bot accepts videos from providers that support vision (configured with `supportsVideo` in the engine config). Videos larger than the configured cap are skipped with a warning.

### Attachments

File and text attachments are sent with metadata so the model knows what's available, but only images and videos are fetched and sent to the model — plain file contents are not ingested.

## Message Splitting

Messages exceeding Discord's 2000-character limit are split into multiple messages. The splitter is fence-aware: if a split falls inside a code block, the chunk is closed with ``` and re-opened with the same fence on the next chunk.
