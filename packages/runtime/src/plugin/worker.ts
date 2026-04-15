// Bootstrap: register tsx's default ESM loader hook before importing the real worker.
// Without this, plugin worker threads can't resolve .ts files or workspace TS packages.
// Static imports hoist, so we must dynamic-import the implementation after register().
import { register } from "tsx/esm/api";

register();

await import("./worker-main.js");
