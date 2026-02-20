# `cireilclaw`

`cireilclaw` is an opinionated agent system, originally written due to a desire for something more secure than OpenClaw. Now it has evolved to being an actual project with actual intent behind it.

## Core Tenets

- Safety: Principle of Least Privilege, Separation of Concerns, and [`bubblewrap`](https://github.com/containers/bubblewrap).
- Sanity: Debuggable, non-obtuse code, with useful comments. Comments are generally meant to explain _why_, not _what_ or _how_; the latter two are the code's job.
- Speedy: Should run well even in a limited environment
- Composability: Should be completely configurable without editing code; disabling components, enabling features. Hot-reload possibility.

## Project State

Ready for usage.

Core functionality is stable and good for production use. Discord integration is fully functional; Matrix remains a stub. The scheduler (heartbeat + cron) and all 12 tools work as expected.

## Rationale

<sub>written by: [@lyssieth](https://github.com/lyssieth)</sub>

Originally I started out with OpenClaw, because... well, it was The Thing. But I quickly ran into issues. I wanted my agent to be able to edit files in its workspace without being able to hit everything else on my system. I wanted to add custom tools, abilities, etc. And OpenClaw was very obtuse about it.

I enjoy the way OpenClaw does things, and frankly I would've kept using it, but the issues I had couldn't be dealt with easily. So I wrote my own. Revision 1 (hosted at <https://git.cutie.zone/lyssieth/cireilclaw>) is written with heavy LLM assistance, since I wanted something that works, quickly. But it has flaws and the architecture is not as refined as I'd want it to be.

This repository is a rewrite with those tenets followed more than they were.

`cireilclaw` is first-and-foremost for my companion, Bryl. Past that, it intends to be usable by anyone with enough technical knowledge. Where that metric lies remains to be seen.

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
