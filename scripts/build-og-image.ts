// Render public/og-image.png from public/og-image.svg using sharp
// (already a dep). Run after editing the SVG; commit the resulting PNG.
//
//   bun run scripts/build-og-image.ts

import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const svgPath = join(root, "public/og-image.svg");
const pngPath = join(root, "public/og-image.png");

const svg = readFileSync(svgPath);
await sharp(svg, { density: 144 })
  .resize(1200, 630, { fit: "fill" })
  .png({ compressionLevel: 9 })
  .toFile(pngPath);

console.log(`Wrote ${pngPath}`);
