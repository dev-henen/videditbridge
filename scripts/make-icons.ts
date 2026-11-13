/**
 * Every app icon from the logo.
 *
 *   npx tsx scripts/make-icons.ts [logo image]     (default: ui/Packaging/logo.jpg)
 *
 * The logo can sit on a plain light background: the background is cut away by filling in from the
 * edges (so white inside the logo, like film holes, stays), and the soft edge is taken back out of
 * the white so it looks clean on dark taskbars. Then the logo is cropped square and written as:
 * - ui/Packaging/AppIcon.png (1024, the master)
 * - ui/Packaging/icons/AppIcon-<size>.png, 16 to 1024 (Linux hicolor; macOS iconutil makes the .icns from them)
 * - ui/Assets/AppIcon.png (256, the window icon)
 * - ui/Assets/AppIcon.ico (16 to 256, the Windows executable's icon)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const source = path.resolve(process.argv[2] ?? path.join(root, "ui", "Packaging", "logo.jpg"));
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** Space around the logo, as a share of the icon. */
const MARGIN = 0.04;

/** The logo with its light background made transparent, as RGBA pixels. */
async function cutOut(file: string): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const n = width * height;
  // How far a pixel is from white: 0 for the background, 1 for the logo's own color.
  const ink = new Float32Array(n);
  let darkest = 255;
  for (let i = 0; i < n; i++) darkest = Math.min(darkest, data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!);
  const range = Math.max(1, 255 - darkest);
  for (let i = 0; i < n; i++) ink[i] = Math.min(1, (255 - Math.min(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!)) / range);
  // The background is the light area reached from the edges; light areas inside the logo are kept.
  const outside = new Uint8Array(n);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!outside[i] && ink[i]! < 0.6) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) push(x), push((height - 1) * width + x);
  for (let y = 0; y < height; y++) push(y * width), push(y * width + width - 1);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < n - width) push(i + width);
  }
  for (let i = 0; i < n; i++) {
    if (!outside[i]) continue;
    // The faint gray of the backdrop goes entirely; the logo's soft edge keeps its share.
    const a = ink[i]! < 0.08 ? 0 : ink[i]!;
    const o = i * 4;
    if (a === 0) {
      data[o + 3] = 0;
      continue;
    }
    // Take the white back out: the color the edge has without the backdrop blended in.
    for (let c = 0; c < 3; c++) data[o + c] = Math.max(0, Math.min(255, Math.round((data[o + c]! - 255 * (1 - a)) / a)));
    data[o + 3] = Math.round(255 * a);
  }
  return { data, width, height };
}

/** The square around what is visible, with a margin. */
function square(data: Buffer, width: number, height: number): { left: number; top: number; size: number } {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3]! > 24) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) throw new Error("Nothing is left of the logo after taking the background away.");
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const size = Math.round(side / (1 - 2 * MARGIN));
  return { left: Math.round((x0 + x1 + 1) / 2 - size / 2), top: Math.round((y0 + y1 + 1) / 2 - size / 2), size };
}

/** An .ico holding PNG images (Windows Vista and later read these). */
function ico(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, k) => {
    const e = 6 + 16 * k;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

const { data, width, height } = await cutOut(source);
const { left, top, size } = square(data, width, height);
// The square may reach past the picture: the canvas is extended with transparency first.
const pad = Math.max(0, -left, -top, left + size - width, top + size - height);
const master = await sharp(data, { raw: { width, height, channels: 4 } })
  .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .extract({ left: left + pad, top: top + pad, width: size, height: size })
  .resize(1024, 1024, { kernel: "lanczos3" })
  .png()
  .toBuffer();

const at = (s: number) => sharp(master).resize(s, s, { kernel: "lanczos3" }).png({ compressionLevel: 9 }).toBuffer();
const packaging = path.join(root, "ui", "Packaging");
const assets = path.join(root, "ui", "Assets");
await mkdir(path.join(packaging, "icons"), { recursive: true });
await writeFile(path.join(packaging, "AppIcon.png"), master);
for (const s of PNG_SIZES) await writeFile(path.join(packaging, "icons", `AppIcon-${s}.png`), await at(s));
await writeFile(path.join(assets, "AppIcon.png"), await at(256));
await writeFile(path.join(assets, "AppIcon.ico"), ico(await Promise.all(ICO_SIZES.map(async (s) => ({ size: s, png: await at(s) })))));
console.log(`Icons made from ${path.relative(root, source)}: ${PNG_SIZES.length} PNGs, AppIcon.png (256), AppIcon.ico (${ICO_SIZES.join(", ")})`);
