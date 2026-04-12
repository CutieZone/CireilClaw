import decodeHeic from "heic-decode";
import sharp from "sharp";

// Quality chosen to balance visual fidelity against API payload size.
// ~90 gives roughly a 10x size reduction over PNG with no perceptible loss.
const WEBP_QUALITY = 90;

const JPEG_QUALITY = 85;

// Anthropic hard-limits images to 8000×8000 pixels.
const ANTHROPIC_MAX_DIMENSION = 8000;

async function toJpeg(data: Uint8Array): Promise<Uint8Array> {
  const result = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return result;
}

// Re-encode any supported image format to WebP before it is sent to the
// vision API.  A typical 9 MiB PNG round-trips to a few hundred KiB this way,
// well within provider limits, with no perceptible quality loss.
//
// HEIC/HEIF inputs are decoded via heic-decode (WASM libheif) rather than
// relying on sharp's native libheif — the WASM build is always available
// regardless of platform.
async function toWebp(data: ArrayBuffer, mediaType?: string): Promise<Uint8Array> {
  if (mediaType === "image/heic" || mediaType === "image/heif") {
    const {
      width,
      height,
      data: raw,
    } = await decodeHeic({
      // heic-decode's types declare `buffer: ArrayBufferLike` but the
      // implementation calls `.slice()` and spreads the result, which only
      // works on typed arrays. Wrapping in Uint8Array fixes the runtime error;
      // the cast silences the type mismatch.
      // oxlint-disable-next-line no-unsafe-type-assertion
      buffer: new Uint8Array(data) as unknown as ArrayBufferLike,
    });
    const result = await sharp(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), {
      raw: { channels: 4, height, width },
    })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    return result;
  }

  const result = await sharp(Buffer.from(data)).webp({ quality: WEBP_QUALITY }).toBuffer();
  return result;
}

// Scale a WebP image down so neither dimension exceeds the Anthropic API
// limit (8000 px).  Returns the buffer unchanged when already within bounds.
async function scaleForAnthropic(data: Uint8Array): Promise<Uint8Array> {
  const image = sharp(data);
  const meta = await image.metadata();
  const { width, height } = meta;

  if (width <= ANTHROPIC_MAX_DIMENSION && height <= ANTHROPIC_MAX_DIMENSION) {
    return data;
  }

  const scale = ANTHROPIC_MAX_DIMENSION / Math.max(width, height);
  return image
    .resize(Math.round(width * scale), Math.round(height * scale), {
      fit: "inside",
    })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

export { toWebp, toJpeg, scaleForAnthropic };
