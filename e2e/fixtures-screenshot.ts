import { solidPng } from "./helpers";
import { deflateSync } from "node:zlib";

/**
 * A synthetic Instagram profile screenshot: white header area, then a 3-column
 * grid of 3:4 colored tiles separated by 3px white gutters.
 */
export function profileScreenshot(rows: number, columns = 3, width = 1170, height = 2532) {
  void solidPng;
  const tileWidth = Math.floor(width / 3);
  const tileHeight = Math.round(tileWidth * 4 / 3);
  const gridTop = Math.floor(height * 0.35);
  const colors: Array<[number, number, number]> = [[200, 60, 60], [60, 160, 90], [60, 90, 200], [190, 150, 40], [130, 60, 170], [40, 150, 160]];
  const raw = Buffer.alloc((1 + width * 3) * height, 255);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    const row = Math.floor((y - gridTop) / tileHeight);
    if (y < gridTop || row >= rows || (y - gridTop) % tileHeight < 3) continue;
    for (let x = 0; x < width; x += 1) {
      const column = Math.min(2, Math.floor(x / tileWidth));
      if (column >= columns && row === rows - 1) continue;
      if (x % tileWidth < 3) continue;
      const [r, g, b] = colors[(row * 3 + column) % colors.length];
      raw.set([r, g, b], rowStart + 1 + x * 3);
    }
  }
  return { name: "profile.png", mimeType: "image/png", buffer: encodePng(width, height, raw) };
}

function encodePng(width: number, height: number, raw: Buffer) {
  const png = solidPng(1, 1, [0, 0, 0]);
  // Reuse the encoder's chunk layout by swapping in our own IHDR/IDAT.
  const signature = png.subarray(0, 8);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, crcBytes]);
}
