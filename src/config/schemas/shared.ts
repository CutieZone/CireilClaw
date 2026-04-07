import * as vb from "valibot";

const nonEmptyString = vb.pipe(vb.string(), vb.nonEmpty(), vb.description("a non-empty string"));

const ApiKeySchema = vb.pipe(
  vb.union([nonEmptyString, vb.pipe(vb.array(nonEmptyString), vb.minLength(1))]),
  vb.description("An API key, or an array of API keys"),
);

type ApiKey = vb.InferOutput<typeof ApiKeySchema>;

export { nonEmptyString, ApiKeySchema };
export type { ApiKey };
