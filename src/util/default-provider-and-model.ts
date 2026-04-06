import type { ModelConfig, ProviderConfig, ProvidersConfig } from "$/config/schemas/engine.js";

interface Result {
  provider: {
    name: string;
    config: ProviderConfig;
  };
  model: {
    name: string;
    config?: ModelConfig[keyof ModelConfig];
  };
}

export function getDefaultProviderAndModel(cfg: ProvidersConfig): Result {
  const defaultProviders = Object.entries(cfg)
    .filter((it) => it[1].isGlobalDefault)
    .map((it) => ({
      config: it[1],
      name: it[0],
    }));

  let defaultProvider: { name: string; config: ProviderConfig } | undefined = undefined;
  if (defaultProviders.length === 1) {
    [defaultProvider] = defaultProviders;
  } else {
    throw new Error(
      "Found either zero or too many default providers. Only one provider may have `isGlobalDefault` set to true",
    );
  }

  // Safety net: the length check above guarantees this is defined, but the
  // linter can't narrow it through the destructuring assignment.
  if (defaultProvider === undefined) {
    throw new Error("Unreachable: defaultProvider must be defined after length === 1 check");
  }

  return {
    model: {
      config: defaultProvider.config.models?.[defaultProvider.config.defaultModel],
      name: defaultProvider.config.defaultModel,
    },
    provider: defaultProvider,
  };
}
