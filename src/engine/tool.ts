import type { AnySchema } from "valibot";

interface Tool<TParameters extends AnySchema = AnySchema> {
  name: string;
  description: string;
  parameters: TParameters;
}

export type { Tool };
