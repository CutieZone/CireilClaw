import type { Message } from "#engine/message.js";

export function stripMediaForModel(
  messages: Message[],
  supportsVision: boolean,
  supportsVideo: boolean,
): Message[] {
  const result: Message[] = [];

  for (const message of messages) {
    if (message.role !== "user") {
      result.push(message);
      continue;
    }

    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    const filtered = blocks.filter((block) => {
      const { type } = block;
      if (type === "image" || type === "image_ref") {
        return supportsVision;
      }
      if (type === "video" || type === "video_ref") {
        return supportsVideo;
      }
      return true;
    });

    if (filtered.length === 0) {
      continue;
    }

    result.push({
      ...message,
      // oxlint-disable-next-line typescript/no-non-null-assertion
      content: Array.isArray(message.content) ? filtered : filtered[0]!,
    });
  }

  return result;
}
