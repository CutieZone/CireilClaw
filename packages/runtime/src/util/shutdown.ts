import { warning } from "#output/log.js";

type ShutdownHook = () => void;

const hooks: ShutdownHook[] = [];
let registered = false;

function forceExit(): void {
  warning("Forced exit.");
  // oxlint-disable-next-line unicorn/no-process-exit -- the second signal must terminate immediately.
  process.exit(1);
}

function shutdown(): void {
  process.once("SIGINT", forceExit);
  process.once("SIGTERM", forceExit);

  for (const hook of hooks) {
    try {
      hook();
    } catch {
      // Best-effort — don't let a bad hook block the others.
    }
  }

  // oxlint-disable-next-line unicorn/no-process-exit -- shutdown hooks are synchronous and complete before exit.
  process.exit(0);
}

function onShutdown(hook: ShutdownHook): void {
  hooks.push(hook);
}

function registerSigint(): void {
  if (registered) {
    return;
  }
  registered = true;

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { onShutdown, registerSigint };
