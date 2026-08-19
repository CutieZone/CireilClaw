import * as vb from "valibot";
import { describe, expect, it } from "vitest";

import { toJsonSchemaSafe } from "./schema.js";

describe("toJsonSchemaSafe", () => {
  it("allows the Unicode flag because JSON Schema applies Unicode semantics", () => {
    expect(() => toJsonSchemaSafe(vb.pipe(vb.string(), vb.regex(/[a-z]+/u)))).not.toThrow();
  });

  it("rejects flags that JSON Schema patterns cannot represent", () => {
    expect(() => toJsonSchemaSafe(vb.pipe(vb.string(), vb.regex(/[a-z]+/iu)))).toThrow(
      "unsupported flags 'i'",
    );
  });
});
