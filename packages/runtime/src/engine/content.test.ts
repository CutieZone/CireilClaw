import { describe, expect, it } from "vitest";

import { renderTextContent } from "./content.js";

describe("renderTextContent", () => {
  it("includes a Discord message ID in message metadata", () => {
    expect(
      renderTextContent({
        content: "Hello",
        discord: {
          author: { displayName: "Alice", id: "user-1", username: "alice" },
          format: "message",
          messageId: "message-1",
          timestamp: "2026-08-07 12:00",
        },
        type: "text",
      }),
    ).toBe(
      '<msg from="alice <user-1>" displayName="Alice" timestamp="2026-08-07 12:00" id="message-1">Hello</msg>',
    );
  });
});
