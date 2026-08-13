# Bubblewrap Sandbox

Bubblewrap (`bwrap`) is the default CireilClaw command-execution backend.
It creates a fresh Linux namespace sandbox for each `exec` command and exposes only the files, devices, environment variables, and host binaries selected by the agent configuration.

## Configuration

The per-agent configuration lives at `~/.cireilclaw/agents/{slug}/config/sandbox.toml`.

```toml
backend = "bwrap"

[bwrap]
binaries = ["git", "python3"]

[[mounts]]
source = "/home/user/projects/my-app"
target = "project"
mode = "rw"
```

`backend` defaults to `"bwrap"`.
The `binaries` list is an allowlist of host commands made available to `exec`.
Arguments are passed separately; commands containing shell metacharacters or spaces are rejected.

Mount sources must be absolute paths or begin with `~/`.
Mount targets are relative paths below `/workspace/` and can be read-only (`ro`) or read-write (`rw`).

## Filesystem

Each command receives these standard paths:

- `/workspace` — read-write agent workspace
- `/memories` — read-write agent memories
- `/skills` — read-write agent skills
- `/tasks` — read-write agent tasks
- `/tmp` — fresh 64 MiB temporary filesystem
- `/proc` and `/dev` — sandbox-created minimal pseudo-filesystems

Custom mounts appear below `/workspace/`.
The host's basic account files, certificate files, and required system libraries are exposed read-only so configured commands can run.

The command starts in `/workspace` with `HOME=/workspace`.
The environment is cleared and rebuilt with a minimal `PATH`, locale settings, values from `workspace/.env`, and explicitly configured passthrough variables.

## Devices and Network

By default, the sandbox does not share the host PID, IPC, or UTS namespaces and has no host device passthrough.
The hostname is `{agent-slug}-sandbox`.

Device access is opt-in:

```toml
[devices]
usb = true   # expose /dev/bus/usb when present
all = true   # expose the host /dev when present
```

`all` is substantially broader than `usb` and should only be enabled when the command requires it.
Network behavior follows Bubblewrap and the host setup; CireilClaw does not configure a separate network namespace in this backend.

## Security Model

The backend is intended to be the least-privilege command boundary between an agent and the host.
The boundary depends on Linux namespaces, filesystem bind mounts, the configured binary allowlist, and the security of the host `bwrap` installation and kernel.

The `exec` tool is not the same boundary as conditional file-access rules.
Once a command is allowed to run, the command can inspect, copy, or transform anything visible inside its sandbox.

Plugins are not placed inside this sandbox; plugin code is trusted runtime code.

The environment variable `CIREILCLAW_RUNTIME_INSECURE_DISABLE_SANDBOX_I_AM_100_PERCENT_SURE` can intentionally bypass Bubblewrap, but this runs commands directly on the host and removes the protection described here.

## Requirements

Linux and a working `bwrap` binary are required.
On NixOS, CireilClaw resolves the configured binaries and their Nix store requisites before constructing the sandbox.
On other Linux systems, the required binaries and standard system directories must be available on the host.
