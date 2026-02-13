export function encode(buf: ArrayBuffer): string {
  const buffer = Buffer.from(buf);

  return buffer.toString("base64");
}
