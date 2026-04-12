import { warning } from "$/output/log.js";

type ShutdownHook = () => void;

const _hooks: ShutdownHook[] = [];
let _registered = false;

// Register a callback to run during graceful shutdown.
function onShutdown(hook: ShutdownHook): void {
  _hooks.push(hook);
}

// Call once at startup. First SIGINT runs all hooks then exits cleanly.
// A second SIGINT (e.g. hooks are hanging) exits immediately.
function registerSigint(): void {
  if (_registered) {
    return;
  }
  _registered = true;

  process.on("SIGINT", () => {
    // Replace handler immediately so a second SIGINT force-exits.
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
