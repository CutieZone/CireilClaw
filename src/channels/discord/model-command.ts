import type { HandlerCtx } from "$/channels/discord/handler-ctx.js";
import { loadEngine } from "$/config/index.js";
import type { ProviderConfig } from "$/config/schemas/engine.js";
import { nonEmptyString } from "$/config/schemas/shared.js";
import { saveSession } from "$/db/sessions.js";
import { DiscordSession } from "$/harness/session.js";
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

async function fetchModelListFor(
  selected: ProviderConfig,
): Promise<{ name: string; id: string }[]> {
  switch (selected.kind) {
    case "openai": {
      const modelList = await fetch(`${selected.apiBase}/models`);

      const json = await modelList.json();
      const list = vb.parse(OpenAIModelListSchema, json);
      debug("Parsed list:", list);

      return list.data.map((it) => ({ id: it.id, name: it.name ?? it.id }));
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

      return list.data.map((it) => ({
        id: it.id,
        name: it.id,
      }));
    }
    default: {
      const _exhaustive = selected.kind;
      // oxlint-disable-next-line typescript/restrict-template-expressions
      throw new Error(`Unimplemented provider: ${_exhaustive}`);
    }
  }
}

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
    await interaction.createFollowup({
      content: "Could not find the provider you requested.",
      flags: MessageFlags.EPHEMERAL,
    });
    return;
  }

  async function success(): Promise<void> {
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
  }

  if (providerCfg.availableModels === "analyze") {
    const models = await fetchModelListFor(providerCfg);

    if (models.some((it) => it.id === model.value)) {
      await success();
    } else {
      await interaction.createFollowup({
        content:
          "Could not find the model you requested. If you are certain it exists, use `availableModels` to properly list it.",
        flags: MessageFlags.EPHEMERAL,
      });
    }
  } else if (
    providerCfg.availableModels.includes(model.value) ||
    providerCfg.models?.[model.value] !== undefined
  ) {
    await success();
    return;
  }

  await interaction.createFollowup({
    content: "Failed to set model and provider.",
    flags: MessageFlags.EPHEMERAL,
  });
}

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
    let models: { value: string; name: string }[] | undefined = undefined;

    if (selected?.availableModels === "analyze") {
      const tmp = await fetchModelListFor(selected);
      models = tmp
        .filter(
          ({ name, id }) =>
            typeof focused.value === "string" &&
            focused.value.length > 1 &&
            (name.startsWith(focused.value) || id.startsWith(focused.value)),
        )
        .map(({ name, id }) => ({ name: id, value: name }));

      debug("Filtered list:", models);
    } else if (selected !== undefined) {
      models = selected.availableModels.map((it) => ({ name: it, value: it }));
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

    await interaction.result(models);
  }
}

export { definition, handleCommand, handleAutocomplete };
