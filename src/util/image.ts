import sharp from "sharp";

// Quality chosen to balance visual fidelity against API payload size.
// ~90 gives roughly a 10x size reduction over PNG with no perceptible loss.
const WEBP_QUALITY = 90;

// Re-encode any supported image format to WebP before it is sent to the
// vision API.  A typical 9 MiB PNG round-trips to a few hundred KiB this way,
// well within provider limits, with no perceptible quality loss.
export async function toWebp(data: ArrayBuffer): Promise<ArrayBuffer> {
  const result = await sharp(Buffer.from(data)).webp({ quality: WEBP_QUALITY }).toBuffer();
  // result is a Buffer; slice() gives a fresh ArrayBuffer of the exact size.
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
}
