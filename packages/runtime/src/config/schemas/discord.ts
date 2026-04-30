import * as vb from "valibot";

import { nonEmptyString } from "#config/schemas/shared.js";

const DirectMessagesModeSchema = vb.pipe(
  vb.exactOptional(vb.picklist(["owner", "public", "allowlist", "denylist"]), "owner"),
  vb.description("Who's allowed to use direct messages with this agent"),
);

const DirectMessagesSchema = vb.exactOptional(
  vb.strictObject({
    mode: DirectMessagesModeSchema,
    users: vb.exactOptional(vb.array(vb.pipe(nonEmptyString, vb.regex(/[0-9]+/))), []),
  }),
  {
    mode: "owner",
  },
);

const AccessModeSchema = vb.pipe(
  vb.exactOptional(vb.picklist(["disabled", "allowlist", "denylist"]), "disabled"),
  vb.description(
    "What kind of access restriction to apply; 'disabled' means there's no restriction",
  ),
);

const AccessSchema = vb.exactOptional(
  vb.strictObject({
    mode: AccessModeSchema,
    users: vb.pipe(
      vb.exactOptional(vb.array(vb.pipe(vb.string(), vb.regex(/[0-9]+/))), []),
      vb.description("An array of discord user IDs"),
    ),
  }),
  {
    mode: "disabled",
  },
);

const DiscordConfigSchema = vb.strictObject({
  access: vb.pipe(AccessSchema, vb.description("Optional restrictions on access to the agent")),
  directMessages: vb.pipe(
    DirectMessagesSchema,
    vb.description("How to restrict direct message access to the agent"),
  ),
  ownerId: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.regex(/[0-9]+/),
    vb.description("The ID of the 'owner' of the agent."),
  ),
  token: vb.pipe(
    nonEmptyString,
    vb.description("The bot token from https://discord.com/developers/applications"),
  ),
});

type DiscordConfig = vb.InferOutput<typeof DiscordConfigSchema>;
type DirectMessages = vb.InferOutput<typeof DirectMessagesSchema>;
type AccessConfig = vb.InferOutput<typeof AccessSchema>;

export { DiscordConfigSchema, DirectMessagesSchema, AccessSchema };
export type { DiscordConfig, DirectMessages, AccessConfig };
