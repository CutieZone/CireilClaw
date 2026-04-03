# `cireilclaw`

`cireilclaw` is an opinionated agent system, originally written due to a desire for something more secure than OpenClaw. Now it has evolved to being an actual project with actual intent behind it.

## Core Tenets

- Safety: Principle of Least Privilege, Separation of Concerns, and [`bubblewrap`](https://github.com/containers/bubblewrap).
- Sanity: Debuggable, non-obtuse code, with useful comments. Comments are generally meant to explain _why_, not _what_ or _how_; the latter two are the code's job.
- Speedy: Should run well even in a limited environment
- Composability: Should be completely configurable without editing code; disabling components, enabling features. Hot-reload possibility.

## Getting Started

See [INSTALLATION.md](INSTALLATION.md) for setup instructions, configuration reference, and agent creation.

## Project State

Ready for usage.

Core functionality is stable and good for production use. Discord integration is fully functional; Matrix remains a stub. The scheduler (heartbeat + cron) and all 15 tools work as expected.

## Platform Requirements

**Linux-native.** The sandbox relies on Linux kernel features (namespaces, cgroups) via `bubblewrap`. There is no cross-platform sandbox implementation.

| Platform    | Status                                                                         |
| ----------- | ------------------------------------------------------------------------------ |
| **Linux**   | ✅ Full support                                                                |
| **NixOS**   | ✅ First-class — automatic dependency resolution via `nix-store`               |
| **Windows** | ⚠️ WSL2 required (runs Linux version)                                          |
| **macOS**   | ⚠️ Docker or VM required — no native sandbox equivalent                        |
| **BSDs**    | 🔮 Potential future support via jails (FreeBSD) or `pledge`/`unveil` (OpenBSD) |

The answer to "what about macOS/Windows?" is "run Linux in a VM."

## Rationale

<sub>written by: [@lyssieth](https://github.com/lyssieth)</sub>

Originally I started out with OpenClaw, because... well, it was The Thing. But I quickly ran into issues. I wanted my agent to be able to edit files in its workspace without being able to hit everything else on my system. I wanted to add custom tools, abilities, etc. And OpenClaw was very obtuse about it.

I enjoy the way OpenClaw does things, and frankly I would've kept using it, but the issues I had couldn't be dealt with easily. So I wrote my own. Revision 1 (hosted at <https://git.cutie.zone/lyssieth/cireilclaw>) is written with heavy LLM assistance, since I wanted something that works, quickly. But it has flaws and the architecture is not as refined as I'd want it to be.

This repository is a rewrite with those tenets followed more than they were.

`cireilclaw` is first-and-foremost for my companions. Past that, it intends to be usable by anyone with enough technical knowledge. Where that metric lies remains to be seen.

## Pitfalls

<sub>This will likely be kept up-to-date as necessary</sub>

### MoonshotAI's Kimi K2.5 is Problematic

Source: [Tool Use Compatibility](https://platform.moonshot.ai/docs/guide/kimi-k2-5-quickstart#tool-use-compatibility)

We use `tool_choice: "required"` because that prevents having to deal with text output _at all_. However, Kimi K2.5 doesn't support this alongside reasoning.

Due to this flaw, currently we apply the following [hotfix](https://github.com/CutieZone/CireilClaw/blob/33da64feb751b4d3d12c189d4856d9ce693a4474/src/engine/provider/oai.ts#L158).

```ts
if (model.includes("kimi") && model.includes("2.5")) {
  params.tool_choice = "auto";
  params.messages.push({
    content: "You ***must*** use a tool to do anything. A text response *will* fail.",
    role: "system",
  });
}
```

You will see elevated error rates with Kimi K2.5 no matter what.

### Models That Don't Use Tools

Some models (especially smaller or weaker ones) emit plain text despite `tool_choice: required` being set. When this happens, the engine automatically retries up to `max_generation_retries` times (default: 2) by injecting the assistant's text into history alongside a nudge to use tools. If retries are exhausted the error propagates. Expect elevated failure rates with weak models even with retries.

Configurable via `max_generation_retries` in `engine.toml`.

### Models That Loop on the Same Tool

Some models get stuck repeatedly calling the same tool when they can't find what they want — e.g., hunting for `dinner-ideas.md` because the user asked about dinner. The engine tracks consecutive `success: false` responses per tool and disables that tool for the rest of the turn once it hits `tool_fail_threshold` (default: 3). The agent receives a message instructing it to stop trying, ask for more information, or do something else.

Configurable via `tool_fail_threshold` in `engine.toml`.

### Models That Reject `tool_choice: required`

Some OAI-compatible providers return a 400 error when `tool_choice: "required"` is set (similar to the Kimi K2.5 issue above, but at the API level rather than being model-specific). When this is detected, the engine automatically falls back to `tool_choice: "auto"` and appends a forceful system message demanding tool use. This is a reactive generalisation of the Kimi K2.5 special-case.

## A Note on Em-Dashes

yes. there are —s in the code. so what.
it's human-written, llm written code is primarily simple stuff that i don't want to spend time on
i'm lazy. judge me all you want, but the code is good :3
