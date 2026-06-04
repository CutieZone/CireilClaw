import { warning } from "#output/log.js";

type ShutdownHook = () => void;

const _hooks: ShutdownHook[] = [];
let _registered = false;

function onShutdown(hook: ShutdownHook): void {
  _hooks.push(hook);
}

function registerSigint(): void {
  if (_registered) {
    return;
  }
  _registered = true;

  process.on("SIGINT", () => {
    process.on("SIGINT", () => {
      warning("Forced exit.");
      process.exit(1);
    });

    for (const hook of _hooks) {
      try {
        hook();
      } catch {
        // Best-effort — don't let a bad hook block the others.
      }
    }

    process.exit(0);
  });
}

export { onShutdown, registerSigint };
