import { expect, test, type Page } from "@playwright/test";
import { addPhotos, expectAllTilesLoaded, expectStoredDrafts, openEmptyFeed, photo, tiles } from "./helpers";
import { profileScreenshot } from "./fixtures-screenshot";

const RED = photo("red", [220, 40, 40]);
const GREEN = photo("green", [40, 180, 60]);
const BLUE = photo("blue", [40, 80, 220]);

async function tileColors(page: Page) {
  return tiles(page).locator("img").evaluateAll((images) => images.map((element) => {
    const image = element as HTMLImageElement;
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0, 4, 4);
    const [r, g, b] = context.getImageData(2, 2, 1, 1).data;
    return r > g && r > b ? "red" : g > b ? "green" : "blue";
  }));
}

async function longPress(page: Page, index: number) {
  const box = (await tiles(page).nth(index).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  return box;
}

test.describe("onboarding", () => {
  test("someone who started an empty feed is not sent through onboarding again", async ({ page }) => {
    await openEmptyFeed(page);
    await page.reload();
    await expect(page.getByText("피드가 기다리고 있어요")).toBeVisible();
  });
});
