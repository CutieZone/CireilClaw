import { warning } from "#output/log.js";

type ShutdownHook = () => void | Promise<void>;

const hooks: ShutdownHook[] = [];
let registered = false;
let shuttingDown = false;

function forceExit(): void {
  warning("Forced exit.");
  // oxlint-disable-next-line unicorn/no-process-exit -- the second signal must terminate immediately.
  process.exit(1);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.once("SIGINT", forceExit);
  process.once("SIGTERM", forceExit);

  await Promise.allSettled(
    hooks.map(async (hook) => {
      try {
        await hook();
      } catch {
        // Best-effort — don't let a bad hook block the others.
      }
    }),
  );

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

  process.on("SIGINT", () => {
    // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Signal handlers cannot await.
    shutdown().catch(() => undefined);
  });
  process.on("SIGTERM", () => {
    // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Signal handlers cannot await.
    shutdown().catch(() => undefined);
  });
}

export { onShutdown, registerSigint };
