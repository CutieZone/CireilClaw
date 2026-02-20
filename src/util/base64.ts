export function encode(buf: ArrayBufferLike): string {
  const buffer = Buffer.from(buf);

  return buffer.toString("base64");
}
