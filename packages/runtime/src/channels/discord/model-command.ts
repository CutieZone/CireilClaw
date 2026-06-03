import { ApplicationCommandOptionTypes, ApplicationCommandTypes, MessageFlags } from "oceanic.js";
import type {
  AutocompleteInteraction,
  CommandInteraction,
  CreateApplicationCommandOptions,
} from "oceanic.js";

import type { HandlerCtx } from "#channels/discord/handler-ctx.js";
import { loadEngine } from "#config/index.js";
import { saveSession } from "#db/sessions.js";
import { fetchModelMetadataFor } from "#engine/provider/model-metadata.js";
import { DiscordSession } from "#harness/session.js";
import colors from "#output/colors.js";
import { debug, warning } from "#output/log.js";
import { getDefaultProviderAndModel } from "#util/default-provider-and-model.js";
import { sanitizeError } from "#util/paths.js";

const definition: CreateApplicationCommandOptions = {
  description: "Manage the agent's model overrides",
  name: "model",
  options: [
    {
      description: "Override the provider and model for this channel",
      name: "override",
      options: [
        {
          autocomplete: true,
          description: "The provider to pick from",
          name: "provider",
          required: true,
          type: ApplicationCommandOptionTypes.STRING,
        },
        {
          autocomplete: true,
          description: "The model from the chosen provider",
          name: "model",
          required: true,
          type: ApplicationCommandOptionTypes.STRING,
        },
      ],
      type: ApplicationCommandOptionTypes.SUB_COMMAND,
    },
    {
      description: "Clear any model override for this channel",
      name: "clear",
      type: ApplicationCommandOptionTypes.SUB_COMMAND,
    },
    {
      description: "Clear model overrides for all channels",
      name: "clear-all",
      type: ApplicationCommandOptionTypes.SUB_COMMAND,
    },
    {
      description: "Show the effective provider and model for this channel",
      name: "query",
      type: ApplicationCommandOptionTypes.SUB_COMMAND,
    },
  ],
  type: ApplicationCommandTypes.CHAT_INPUT,
};

function getSession(interaction: CommandInteraction, ctx: HandlerCtx): DiscordSession | undefined {
  const sessionId =
    (interaction.guildID ?? undefined) === undefined
      ? `discord:${interaction.channelID}`
      : `discord:${interaction.channelID}|${interaction.guildID}`;

  const session = ctx.owner.agents.get(ctx.agentSlug)?.sessions.get(sessionId);
  if (session === undefined || !(session instanceof DiscordSession)) {
    return undefined;
  }
  return session;
}

async function handleOverride(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
  async function success(model: string, provider: string): Promise<void> {
    const session = getSession(interaction, ctx);
    if (session === undefined) {
      await interaction.createFollowup({
        content: "No active session to apply overrides in.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    session.selectedModel = model;
    session.selectedProvider = provider;

    saveSession(ctx.agentSlug, session);
    await interaction.createFollowup({
      content: "Successfully changed to the requested provider & model.",
      flags: MessageFlags.EPHEMERAL,
    });
  }

  const provider = interaction.data.options.getStringOption("provider", true);
  const model = interaction.data.options.getStringOption("model", true);

  if (
    provider.value === "invalid" ||
    model.value === "invalid" ||
    provider.value.length === 0 ||
    model.value.length === 0
  ) {
    await interaction.createFollowup({
      content: "Failed to change model. Either provider or model was invalid.",
      flags: MessageFlags.EPHEMERAL,
    });
    return;
  }

  debug(
    "Attempting model change to",
    colors.keyword(model.value),
    "from provider",
    colors.keyword(provider.value),
  );

  const engineCfg = await loadEngine(ctx.agentSlug);
  const providerCfg = engineCfg[provider.value];

  if (providerCfg === undefined) {
    await interaction.createFollowup({
      content: `Could not find the provider \`${provider.value}\``,
      flags: MessageFlags.EPHEMERAL,
    });
    return;
  }

  if (providerCfg.availableModels === "analyze") {
    const models = await fetchModelMetadataFor(providerCfg);

    if (models.some((it) => it.id === model.value)) {
      await success(model.value, provider.value);
    } else {
      await interaction.createFollowup({
        content: `:warning: Could not find the model \`${model.value}\` from the provider \`${provider.value}\`. If you are certain it exists, use \`availableModels\` to forcibly list it.`,
        flags: MessageFlags.EPHEMERAL,
      });
    }
    return;
  } else if (
    providerCfg.availableModels.includes(model.value) ||
    providerCfg.models?.[model.value] !== undefined
  ) {
    await success(model.value, provider.value);
    return;
  }

  await interaction.createFollowup({
    content: "Failed to set model and provider.",
    flags: MessageFlags.EPHEMERAL,
  });
}

async function handleClear(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
  const session = getSession(interaction, ctx);
  if (session === undefined) {
    await interaction.createFollowup({
      content: "No active session to clear overrides in.",
      flags: MessageFlags.EPHEMERAL,
    });
    return;
  }

  session.selectedModel = undefined;
  session.selectedProvider = undefined;
  saveSession(ctx.agentSlug, session);

  await interaction.createFollowup({
    content: "Cleared model override for this channel.",
    flags: MessageFlags.EPHEMERAL,
  });
}

async function handleClearAll(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
  const agent = ctx.owner.agents.get(ctx.agentSlug);
  if (agent === undefined || agent.sessions.size === 0) {
    await interaction.createFollowup({
      content: "No active sessions to clear overrides in.",
      flags: MessageFlags.EPHEMERAL,
    });
    return;
  }

  let cleared = 0;
  for (const session of agent.sessions.values()) {
    if (session.selectedProvider !== undefined || session.selectedModel !== undefined) {
      session.selectedProvider = undefined;
      session.selectedModel = undefined;
      saveSession(ctx.agentSlug, session);
      cleared++;
    }
  }

  await interaction.createFollowup({
    content:
      cleared > 0
        ? `Cleared model overrides in ${cleared} session(s).`
        : "No model overrides were active.",
    flags: MessageFlags.EPHEMERAL,
  });
}

async function handleQuery(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
  const session = getSession(interaction, ctx);
  if (session === undefined) {
    await interaction.createFollowup({
      content: "No active session to query.",
      flags: MessageFlags.EPHEMERAL,
    });
    return;
  }

  const engineCfg = await loadEngine(ctx.agentSlug);
  const defaults = getDefaultProviderAndModel(engineCfg);

  const effectiveProvider = session.selectedProvider ?? defaults.provider.name;
  const effectiveModel = session.selectedModel ?? defaults.model.name;

  const isOverridden =
    session.selectedProvider !== undefined || session.selectedModel !== undefined;

  const content = isOverridden
    ? `This channel is using **${effectiveProvider}** / **${effectiveModel}** (overridden).`
    : `This channel is using **${effectiveProvider}** / **${effectiveModel}** (default).`;

  await interaction.createFollowup({
    content,
    flags: MessageFlags.EPHEMERAL,
  });
}

async function handleCommand(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
  try {
    const sub = interaction.data.options.getSubCommand(true);
    const [subName] = sub;

    switch (subName) {
      case "override": {
        await handleOverride(interaction, ctx);
        break;
      }
      case "clear": {
        await handleClear(interaction, ctx);
        break;
      }
      case "clear-all": {
        await handleClearAll(interaction, ctx);
        break;
      }
      case "query": {
        await handleQuery(interaction, ctx);
        break;
      }
      default: {
        await interaction.createFollowup({
          content: "Unknown subcommand.",
          flags: MessageFlags.EPHEMERAL,
        });
      }
    }
  } catch (error) {
    await interaction.createFollowup({
      content: `Model command failed: ${sanitizeError(error, ctx.agentSlug)}`,
      flags: MessageFlags.EPHEMERAL,
    });
  }
}

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  ctx: HandlerCtx,
): Promise<void> {
  const sub = interaction.data.options.getSubCommand(false);
  if (sub?.[0] !== "override") {
    await interaction.result([
      {
        name: "This subcommand does not support autocomplete",
        value: "invalid",
      },
    ]);
    return;
  }

  let responded = false;
  try {
    const focused = interaction.data.options.getFocused(true);
    const providerField = interaction.data.options.getString("provider");

    const engineCfg = await loadEngine(ctx.agentSlug);
    const selected = providerField === undefined ? undefined : engineCfg[providerField];

    if (focused.name === "provider") {
      responded = true;
      await interaction.result(
        Object.keys(engineCfg).map((key) => ({
          name: key,
          value: key,
        })),
      );
    } else if (focused.name === "model") {
      let models: { value: string; name: string }[] | undefined = undefined;

      if (selected?.availableModels === "analyze") {
        const tmp = await fetchModelMetadataFor(selected);
        models = tmp
          .filter(
            ({ name, id }) =>
              typeof focused.value === "string" &&
              ((focused.value.length > 1 &&
                (name.startsWith(focused.value) || id.startsWith(focused.value))) ||
                focused.value.length === 0),
          )
          .map(({ name, id }) => ({ name, value: id }));
      } else if (selected !== undefined) {
        models = selected.availableModels.map((it) => ({
          name: it,
          value: it,
        }));
      }

      if (models === undefined) {
        responded = true;
        await interaction.result([
          {
            name: "Pick a provider first",
            value: "invalid",
          },
        ]);
        return;
      }

      if (models.length === 0) {
        responded = true;
        await interaction.result([
          {
            name: "This provider has no available models",
            value: "invalid",
          },
        ]);
        return;
      }

      responded = true;
      if (models.length >= 25) {
        models.length = 20;
      }

      await interaction.result(models);
    }
  } catch (error: unknown) {
    warning(`Autocomplete failed for model command: ${sanitizeError(error, ctx.agentSlug)}`);
    if (!responded) {
      await interaction.result([
        {
          name: "Failed to fetch model list",
          value: "invalid",
        },
      ]);
    }
  }
}

export { definition, handleCommand, handleAutocomplete };
