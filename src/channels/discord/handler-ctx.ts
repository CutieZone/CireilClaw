import type { Harness } from "$/harness/index.js";
import type { Client } from "oceanic.js";

export interface HandlerCtx {
  client: Client;
  owner: Harness;
  ownerId: string;
  agentSlug: string;
}
