# Incus Sandbox

Incus is the optional persistent command-execution backend.
Instead of constructing a new filesystem namespace for every command, CireilClaw creates one Incus system container per agent and reuses it for later commands.

Incus supplies the container boundary and operating-system userspace; CireilClaw still controls the instance name, mounted agent directories, runtime identity, environment, working directory, and command invocation.

## Configuration

The per-agent configuration lives at `~/.cireilclaw/agents/{slug}/config/sandbox.toml`.

```toml
backend = "incus"

[incus]
image = "images:fedora/42"
profiles = []
# project = "cireilclaw"

[[mounts]]
source = "/home/user/projects/my-app"
target = "project"
mode = "rw"
```

`image` is any image reference accepted by the configured Incus server.
`profiles` is an optional list of Incus profiles applied when the instance is created.
`project` is optional; when omitted, the caller's current Incus project is used.

The instance name is `cireilclaw-{agent-slug}`.
The first command initializes and starts it, and CireilClaw stops active instances during runtime shutdown.
The instance itself is not destroyed during normal shutdown, so installed packages and container-local state persist.

## Mounted Paths and Identity

CireilClaw adds these disk devices to the instance:

- `/workspace` — read-write agent workspace
- `/memories` — read-write agent memories
- `/skills` — read-write agent skills
- `/blocks` — read-only agent blocks
- `/tasks` — read-write agent tasks

Configured custom mounts appear below `/workspace/` with their selected `ro` or `rw` mode.
Mount targets must not overlap; configure sibling targets rather than nesting one mount target below another.
Custom mount sources must be permitted by the selected Incus project.

The runtime maps the host process UID and GID into the instance with `raw.idmap` and executes the agent command using those numeric IDs.
This preserves access to host-owned mounted files without running the agent command as container root.

The runtime may use root inside the container during initialization to create the mapped account and configure passwordless `sudo` when `sudo` is installed in the image.
This setup authority is used only by the host-side CireilClaw runtime and is not exposed as an agent command.

Commands start in `/workspace` with `HOME=/workspace`.
The environment includes the standard locale variables, values from `workspace/.env`, and explicitly configured host passthrough variables.

## Incus Setup

The Incus daemon must be initialized before selecting this backend.
The runtime user must be allowed to access the Incus Unix socket, normally through the appropriate Incus group or project permissions.

For a restricted user project, the project must allow `raw.idmap` and permit the runtime UID and GID with `restricted.idmap.uid` and `restricted.idmap.gid`.
These settings should be limited to the one runtime identity.

## Integration Test

The Incus integration test is opt-in and creates a uniquely named instance, mounts temporary agent directories, verifies the host UID, reconciles a changed mount, restarts the instance, and destroys it afterward.

Run it with an accessible Incus project and image:

```bash
CIREILCLAW_INCUS_PROJECT=user-1000 pnpm test:incus
```

Use `CIREILCLAW_INCUS_IMAGE` and `CIREILCLAW_INCUS_PROFILES` (comma-separated) to override the defaults. The test uses `images:debian/12` and no profiles when those variables are unset. The selected project must permit the runtime UID/GID, raw ID maps, and disk sources below the user home directory. If using `newgrp incus`, check `id -g` in that shell because it changes the primary GID; the project must permit that new GID as well.

Use an explicit `project` only when the runtime is intentionally allowed to use an operator-managed project.
Profiles and project policy determine the container's root disk, network, device policy, and other container capabilities.

## Security Model

Incus provides a persistent system-container boundary, but this backend is not equivalent to the narrow Bubblewrap filesystem.
The selected image contains whatever software is installed in it, and profiles or project policy may grant additional capabilities.

Access to the local Incus socket or administrative Incus privileges grants broad authority over host containers.
Those credentials are runtime-only integration points and must never be mounted into the agent container.
Do not expose the Incus client configuration or an `incus` binary to agent commands.

Incus is useful when agents need a stable, installable Linux environment or state that survives individual commands.
Use Bubblewrap when the smaller per-command exposure and host binary allowlist are more important than persistent container state.
