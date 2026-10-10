import { deflateSync } from "node:zlib";
import { expect, type Locator, type Page } from "@playwright/test";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Solid-color PNG so tests don't depend on fixture files. */
export function solidPng(width: number, height: number, [r, g, b]: [number, number, number]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function photo(name: string, color: [number, number, number], width = 600, height = 800) {
  return { name: `${name}.png`, mimeType: "image/png", buffer: solidPng(width, height, color) };
}

export async function openEmptyFeed(page: Page) {
  await page.goto("/home");
  await page.getByRole("button", { name: "건너뛰기" }).click();
  await page.getByRole("button", { name: "빈 피드로 바로 시작" }).click();
  await expect(page.getByText("피드가 기다리고 있어요")).toBeVisible();
}

export async function addPhotos(page: Page, files: ReturnType<typeof photo>[]) {
  await page.getByLabel("다음 사진 추가").setInputFiles(files);
  const editor = page.getByRole("dialog", { name: "사진 편집" });
  for (let index = 0; index < files.length; index += 1) {
    await expect(editor.getByText(`${index + 1} / ${files.length}`)).toBeVisible();
    await editor.locator(".editor-confirm").click();
  }
  await expect(editor).toBeHidden();
}

export function tiles(page: Page) {
  return page.locator(".grid [data-post-id]");
}

/** An <img> that rendered as a broken "X box" has naturalWidth 0 or is hidden. */
export async function expectImageLoaded(image: Locator) {
  await expect.poll(() => image.evaluate((element: HTMLImageElement) =>
    element.complete && element.naturalWidth > 0 && getComputedStyle(element).visibility !== "hidden"
  ), { timeout: 5_000 }).toBe(true);
}

export async function expectAllTilesLoaded(page: Page, count: number) {
  await expect(tiles(page)).toHaveCount(count);
  for (const tile of await tiles(page).all()) await expectImageLoaded(tile.locator("img"));
}

/** Wait until IndexedDB holds `count` draft records, i.e. persistence finished. */
export async function expectStoredDrafts(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve) => {
    const request = indexedDB.open("mygrid-export");
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("media")) { db.close(); resolve(-1); return; }
      const keys = db.transaction("media").objectStore("media").getAllKeys();
      keys.onsuccess = () => { db.close(); resolve(keys.result.filter((key) => String(key).startsWith("draft:")).length); };
    };
  })), { timeout: 5_000 }).toBe(count);
}
