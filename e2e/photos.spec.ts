import { expect, test } from "@playwright/test";
import { addPhotos, expectAllTilesLoaded, expectStoredDrafts, openEmptyFeed, photo, tiles } from "./helpers";

test.describe("adding photos", () => {
  test("a newly added photo shows in the grid and survives a restart", async ({ page }) => {
    await openEmptyFeed(page);
    await addPhotos(page, [photo("red", [220, 40, 40])]);
    await expectAllTilesLoaded(page, 1);
    await expectStoredDrafts(page, 1);

    await page.reload();
    await expectAllTilesLoaded(page, 1);
  });

  test("adding photos after a restart keeps every existing photo visible", async ({ page }) => {
    await openEmptyFeed(page);
    await addPhotos(page, [photo("red", [220, 40, 40]), photo("green", [40, 180, 60])]);
    await expectStoredDrafts(page, 2);

    await page.reload();
    await expectAllTilesLoaded(page, 2);

    await addPhotos(page, [photo("blue", [40, 80, 220])]);
    await expectAllTilesLoaded(page, 3);
    await expectStoredDrafts(page, 3);

    await page.reload();
    await expectAllTilesLoaded(page, 3);
  });

  test("restored photos still open in the viewer after another photo is added", async ({ page }) => {
    await openEmptyFeed(page);
    await addPhotos(page, [photo("red", [220, 40, 40])]);
    await expectStoredDrafts(page, 1);
    await page.reload();
    await addPhotos(page, [photo("blue", [40, 80, 220])]);
    await expectStoredDrafts(page, 2);

    await tiles(page).nth(1).click();
    const viewerImage = page.getByRole("dialog", { name: "Instagram 게시물 보기" }).locator("img");
    await expect.poll(() => viewerImage.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  });
});
