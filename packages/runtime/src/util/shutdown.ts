import { warning } from "#output/log.js";

type ShutdownHook = () => void;

const hooks: ShutdownHook[] = [];
let registered = false;

function onShutdown(hook: ShutdownHook): void {
  hooks.push(hook);
}

function registerSigint(): void {
  if (registered) {
    return;
  }
  registered = true;

  process.on("SIGINT", () => {
    process.on("SIGINT", () => {
      warning("Forced exit.");
      process.exit(1);
    });

    for (const hook of hooks) {
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
