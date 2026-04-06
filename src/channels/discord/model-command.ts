import type { HandlerCtx } from "$/channels/discord/handler-ctx.js";
import { loadEngine } from "$/config/index.js";
import { nonEmptyString } from "$/config/schemas/shared.js";
import { saveSession } from "$/db/sessions.js";
import { DiscordSession } from "$/harness/session.js";
import colors from "$/output/colors.js";
import { debug } from "$/output/log.js";
import { ApplicationCommandOptionTypes, ApplicationCommandTypes, MessageFlags } from "oceanic.js";
import type {
  AutocompleteInteraction,
  CommandInteraction,
  CreateApplicationCommandOptions,
} from "oceanic.js";
import * as vb from "valibot";

const definition: CreateApplicationCommandOptions = {
  description: "Change the agent's model",
  name: "model",
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
  type: ApplicationCommandTypes.CHAT_INPUT,
};

async function handleCommand(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
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

  const engineCfg = await loadEngine(ctx.agentSlug);
  const providerCfg = engineCfg[provider.value];

  if (providerCfg === undefined) {
    return;
  }

  if (providerCfg.models?.[model.value] !== undefined) {
    const sessionId =
      (interaction.guildID ?? undefined) === undefined
        ? `discord:${interaction.channelID}`
        : `discord:${interaction.channelID}|${interaction.guildID}`;

    const session = ctx.owner.agents.get(ctx.agentSlug)?.sessions.get(sessionId);
    if (session === undefined || !(session instanceof DiscordSession)) {
      return;
    }

    session.selectedModel = model.value;
    session.selectedProvider = provider.value;

    saveSession(ctx.agentSlug, session);
    await interaction.createFollowup({
      content: "Successfully changed to the requested provider & model.",
      flags: MessageFlags.EPHEMERAL,
    });
    return;
  }

  await interaction.createFollowup({
    content: "Failed to set model and provider.",
    flags: MessageFlags.EPHEMERAL,
  });
}

const OpenAIModelListSchema = vb.object({
  data: vb.array(
    vb.object({
      id: nonEmptyString,
      name: vb.exactOptional(nonEmptyString),
    }),
  ),
});

const AnthropicModelListSchema = vb.object({
  data: vb.array(
    vb.object({
      id: nonEmptyString,
    }),
  ),
});

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  ctx: HandlerCtx,
): Promise<void> {
  const focused = interaction.data.options.getFocused(true);
  const providerField = interaction.data.options.getString("provider");

  const engineCfg = await loadEngine(ctx.agentSlug);
  const selected = providerField === undefined ? undefined : engineCfg[providerField];

  if (focused.name === "provider") {
    await interaction.result(
      Object.keys(engineCfg).map((key) => ({
        name: key,
        value: key,
      })),
    );
  } else if (focused.name === "model") {
    let models: [string, string][] | undefined = undefined;

    if (selected?.availableModels === "analyze") {
      switch (selected.kind) {
        case "openai": {
          debug(
            "Fetching model list for",
            colors.keyword(providerField),
            "(apiBase:",
            colors.keyword(selected.apiBase),
            ")",
          );
          const modelList = await fetch(`${selected.apiBase}/models`);

          debug("Got response:", modelList.status, modelList.statusText);
          const json = await modelList.json();
          debug("Raw json", json);
          const list = vb.parse(OpenAIModelListSchema, json);
          debug("Parsed list:", list);

          models = list.data
            .filter(
              (it) =>
                typeof focused.value === "string" &&
                focused.value.length > 1 &&
                (it.name?.startsWith(focused.value) === true || it.id.startsWith(focused.value)),
            )
            .map((it) => [it.id, it.name ?? it.id]);
          break;
        }
        case "anthropic-oauth": {
          const key = Array.isArray(selected.apiKey) ? selected.apiKey[0] : selected.apiKey;

          const modelList = await fetch(`https://api.anthropic.com/v1/models`, {
            headers: {
              "anthropic-version": "2023-06-01",
              "x-api-key": key,
            },
          });

          const list = vb.parse(AnthropicModelListSchema, await modelList.json());

          models = list.data
            .filter(
              (it) =>
                typeof focused.value === "string" &&
                focused.value.length > 1 &&
                it.id.startsWith(focused.value),
            )
            .map((it) => [it.id, it.id]);
          break;
        }
        default: {
          const _exhaustive = selected.kind;
          // oxlint-disable-next-line typescript/restrict-template-expressions
          throw new Error(`Unimplemented provider: ${_exhaustive}`);
        }
      }

      debug("Filtered list:", models);
    } else if (selected !== undefined) {
      models = selected.availableModels.map((it) => [it, it]);
    }

    if (models === undefined) {
      await interaction.result([
        {
          name: "Pick a provider first",
          value: "invalid",
        },
      ]);
      return;
    }

    if (models.length === 0) {
      await interaction.result([
        {
          name: "This provider has no available models",
          value: "invalid",
        },
      ]);
      return;
    }

    await interaction.result(
      models.map(([key, name]) => ({
        name: name,
        value: key,
      })),
    );
  }
}

export { definition, handleCommand, handleAutocomplete };
