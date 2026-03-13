import type { DirectMessagesConfig } from "$/config/schemas.js";
import type { Harness } from "$/harness/index.js";
import type { Client } from "oceanic.js";

export interface HandlerCtx {
  agentSlug: string;
  client: Client;
  directMessages: DirectMessagesConfig;
  owner: Harness;
  ownerId: string;
}
