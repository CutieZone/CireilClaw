import type { Client } from "oceanic.js";
import type { InferOutput } from "valibot";

import type { AccessSchema, DirectMessagesSchema } from "#config/schemas/discord.js";
import type { Harness } from "#harness/index.js";

export interface HandlerCtx {
  access: InferOutput<typeof AccessSchema>;
  agentSlug: string;
  client: Client;
  directMessages: InferOutput<typeof DirectMessagesSchema>;
  owner: Harness;
  ownerId: string;
}
