/**
 * Rasterise the SVG PWA icons to PNGs so Chrome / Android install criteria
 * are satisfied (Lighthouse expects at least one 192 or 512 PNG icon, and
 * iOS Safari ignores SVG apple-touch-icons entirely).
 *
 * Run via `pnpm icons`. Output lands in pwa/public/ next to the SVGs.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

const targets = [
  { src: "icon-512.svg",  out: "icon-192.png",       size: 192 },
  { src: "icon-512.svg",  out: "icon-512.png",       size: 512 },
  { src: "icon-mask.svg", out: "icon-mask-512.png",  size: 512 },
  { src: "icon-512.svg",  out: "apple-touch-icon.png", size: 180 },
];

// Strip XML comments before handing the SVG to sharp/libxml. Our source SVGs
// embed CSS-style notes like "--bg-canvas" inside <!-- ... --> blocks, and
// libxml's strict parser rejects the embedded double-hyphen. Comments are
// noise to the rasteriser anyway.
function stripComments(svg) {
  return svg.toString("utf8").replace(/<!--[\s\S]*?-->/g, "");
}

for (const t of targets) {
  const svgRaw = await readFile(join(publicDir, t.src));
  const svgBytes = Buffer.from(stripComments(svgRaw), "utf8");
  const png = await sharp(svgBytes, { density: 384 })
    .resize(t.size, t.size, { fit: "contain", background: { r: 7, g: 9, b: 12, alpha: 1 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(publicDir, t.out), png);
  console.log(`✔ ${t.out} (${t.size}×${t.size})`);
}
