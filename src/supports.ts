// Media types accepted as image inputs. Everything is re-encoded to WebP by
// sharp before reaching any provider, so any format sharp can decode is safe
// to include here. HEIC/HEIF Live Photos (MOV atom) are handled — sharp's
// libheif binding decodes only the still frame.

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

const SUPPORTED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

// Hard cap prevents multi-MB payloads from being base64-encoded and sent to
// the API.
const VIDEO_SIZE_CAP = 10 * 1024 * 1024; // 10 MB

// File extensions recognised as images and their corresponding MIME types.
// Used by the `read` tool to detect image files on disk (where we only have
// an extension, not a Content-Type header).
const IMAGE_EXT_TO_MEDIA_TYPE: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

export { SUPPORTED_IMAGE_TYPES, SUPPORTED_VIDEO_TYPES, VIDEO_SIZE_CAP, IMAGE_EXT_TO_MEDIA_TYPE };
