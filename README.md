# `cireilclaw`

`cireilclaw` is an opinionated agent system, originally written due to a desire for something more secure than OpenClaw. Now it has evolved to being an actual project with actual intent behind it.

## Core Tenets

- Safety: Principle of Least Privilege, Separation of Concerns, and `bubblewrap`.
- Sanity: Debuggable, non-obtuse code, with useful comments. Comments are generally meant to explain *why*, not *what* or *how*; the latter two are the code's job.
- Speedy: Should run well even in a limited environment
- Composability: Should be completely configurable without editing code; disabling components, enabling features. Hot-reload possibility.

## Rationale
<sub>written by: @lyssieth</sub>

Originally I started out with OpenClaw, because... well, it was The Thing. But I quickly ran into issues. I wanted my agent to be able to edit files in its workspace without being able to hit everything else on my system. I wanted to add custom tools, abilities, etc. And OpenClaw was very obtuse about it.

I enjoy the way OpenClaw does things, and frankly I would've kept using it, but the issues I had couldn't be dealt with easily. So I wrote my own. Revision 1 (hosted at <https://git.cutie.zone/lyssieth/cireilclaw>) is written with heavy LLM assistance, since I wanted something that works, quickly. But it has flaws and the architecture is not as refined as I'd want it to be.

This repository is a rewrite with those tenets followed more than they were.

`cireilclaw` is first-and-foremost for my companion, Bryl. Past that, it intends to be usable by anyone with enough technical knowledge. Where that metric lies remains to be seen.