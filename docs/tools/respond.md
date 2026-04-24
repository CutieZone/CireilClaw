# respond Tool

The `respond` tool is the primary way for agents to communicate with users. It sends messages to channels and supports file attachments on platforms that support them.

## Parameters

| Parameter     | Type     | Required | Default     | Description                                                                                       |
| ------------- | -------- | -------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `content`     | string   | Yes      | -           | The message content in plain Markdown                                                             |
| `channel`     | string   | No       | `"current"` | Target channel for the message (see [Channel Resolution](#channel-resolution))                    |
| `final`       | boolean  | No       | `true`      | Whether this is the final message of the turn. Set to `false` to send intermediate status updates |
| `attachments` | string[] | No       | -           | Sandbox file paths to attach (e.g., `["/workspace/report.pdf"]`)                                  |

## Channel Resolution

The `channel` parameter allows agents to send messages to different conversation contexts. The channel generally must be prefixed with the session type (for example, `discord:owner`):

| Value                 | Description                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `"current"` (default) | Send to the current conversation                                                         |
| `"last"`              | Send to the most recently active session across all channels                             |
| `"owner"`             | Send a DM to the bot owner (requires `ownerId` to be configured)                         |
| Explicit session ID   | Send to a specific channel using its session ID (e.g., `"discord:123456789\|987654321"`) |

## Important Notes

- Agents **must** call this tool at least once per turn — text written to files is not delivered to users
- Every turn must end with either a `final: true` respond call or a `no-response` call
- File attachments only work on platforms that support them (Discord; not TUI)
- The `channel` parameter requires channel handler support for `resolveChannel`

## Usage Examples

### Basic message to current channel

```json
{
  "content": "Here's the information you requested.",
  "final": true
}
```

### Intermediate status update

```json
{
  "content": "Looking into that for you...",
  "final": false
}
```

### Send to bot owner

```json
{
  "content": "Alert: Something needs attention",
  "channel": "owner"
}
```

### Send to specific Discord channel

```json
{
  "content": "Notification for another channel",
  "channel": "discord:123456789|987654321"
}
```

### With file attachments

```json
{
  "content": "Here's the report you asked for",
  "attachments": ["/workspace/report.pdf", "/workspace/data.csv"]
}
```

## Return Value

```typescript
{
  final: boolean;  // Whether this was the final message of the turn
  sent: boolean;   // Whether the message was sent successfully
  error?: string;  // Error message if sending failed
}
```
