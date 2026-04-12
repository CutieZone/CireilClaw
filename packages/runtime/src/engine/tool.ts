import type { GenericSchema } from "valibot";

interface Tool<TParameters = GenericSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  jsonSchema?: Record<string, unknown>;
}

export type { Tool };
