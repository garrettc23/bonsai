/**
 * Normalize an uploaded bill file into something Claude can read.
 *
 * Claude natively accepts PDF (as `document`) and JPEG/PNG/GIF/WebP
 * (as `image`). HEIC/HEIF (default iPhone photo format) and TIFF are not,
 * so we transcode them to JPEG via sharp. Anything we can't handle is
 * rejected with a clear error.
 */
import { readFile } from "node:fs/promises";
import sharp from "sharp";
// @ts-expect-error — heic-convert ships no types; see declaration below.
import heicConvert from "heic-convert";

// Minimal ambient typing for heic-convert's Node entry.
type HeicConvert = (opts: {
  buffer: Buffer | Uint8Array | ArrayBuffer;
  format: "JPEG" | "PNG";
  quality?: number;
}) => Promise<ArrayBuffer>;

export type NormalizedImageMedia =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

/**
 * Discriminated on `kind` so callers building image- vs document-shaped
 * Anthropic content blocks don't need casts.
 */
export type NormalizedBill =
  | {
      kind: "image";
      mediaType: NormalizedImageMedia;
      base64: string;
      originalName: string;
      transcoded: boolean;
    }
  | {
      kind: "document";
      mediaType: "application/pdf";
      base64: string;
      originalName: string;
      transcoded: boolean;
    };

const CLAUDE_NATIVE_IMAGE_MEDIA = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * Sniff a magic-number signature from the first bytes of the file.
 * Falls back on the filename extension if no signature matches.
 * We intentionally don't trust the client-supplied MIME — browsers
 * often lie (especially about HEIC being `image/jpeg`).
 */
function detectMediaType(bytes: Buffer, filename: string): string | null {
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "%PDF") {
    return "application/pdf";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  // ISO-BMFF "ftyp" box at offset 4 — covers HEIC/HEIF/AVIF.
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) {
      return "image/heic";
    }
    if (brand === "avif") return "image/avif";
  }
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return "image/tiff";
  }
  const ext = filename.toLowerCase().match(/\.([^./\\]+)$/)?.[1];
  if (ext === "heic" || ext === "heif") return "image/heic";
  if (ext === "avif") return "image/avif";
  if (ext === "tif" || ext === "tiff") return "image/tiff";
  if (ext === "pdf") return "application/pdf";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return null;
}

export async function normalizeBillFile(
  filePath: string,
  originalName: string,
): Promise<NormalizedBill> {
  const bytes = await readFile(filePath);
  const mediaType = detectMediaType(bytes, originalName);
  if (!mediaType) {
    throw new Error(
      `Unsupported file type for "${originalName}". Upload a PDF, or a photo (JPEG/PNG/HEIC/WebP/GIF/TIFF).`,
    );
  }

  if (mediaType === "application/pdf") {
    return {
      kind: "document",
      mediaType: "application/pdf",
      base64: bytes.toString("base64"),
      originalName,
      transcoded: false,
    };
  }

  if (CLAUDE_NATIVE_IMAGE_MEDIA.has(mediaType)) {
    return {
      kind: "image",
      mediaType: mediaType as NormalizedImageMedia,
      base64: bytes.toString("base64"),
      originalName,
      transcoded: false,
    };
  }

  // HEIC/HEIF: sharp's bundled libvips on macOS doesn't ship the HEVC
  // decoder (libde265), so we use heic-convert (pure-JS libheif) instead.
  // AVIF/TIFF go through sharp — libvips handles both natively.
  if (mediaType === "image/heic" || mediaType === "image/heif") {
    const rawJpeg = await (heicConvert as HeicConvert)({
      buffer: bytes,
      format: "JPEG",
      quality: 0.92,
    });
    // Pass through sharp to apply EXIF rotation and re-encode at a known quality.
    const jpeg = await sharp(Buffer.from(rawJpeg))
      .rotate()
      .jpeg({ quality: 92 })
      .toBuffer();
    return {
      kind: "image",
      mediaType: "image/jpeg",
      base64: jpeg.toString("base64"),
      originalName,
      transcoded: true,
    };
  }

  const jpeg = await sharp(bytes).rotate().jpeg({ quality: 92 }).toBuffer();
  return {
    kind: "image",
    mediaType: "image/jpeg",
    base64: jpeg.toString("base64"),
    originalName,
    transcoded: true,
  };
}
