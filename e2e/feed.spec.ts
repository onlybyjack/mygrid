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
  test("the entered Instagram ID is shown on the feed and kept after a restart", async ({ page }) => {
    await page.goto("/home");
    await page.locator("#onboarding-username").fill("@my.feed");
    await page.getByRole("button", { name: "다음" }).click();
    await page.getByRole("button", { name: "빈 피드로 바로 시작" }).click();
    await expect(page.getByRole("button", { name: "아이디 수정" })).toHaveText("my.feed");
    await page.reload();
    await expect(page.getByRole("button", { name: "아이디 수정" })).toHaveText("my.feed");
  });

  test("someone who started an empty feed is not sent through onboarding again", async ({ page }) => {
    await openEmptyFeed(page);
    await page.reload();
    await expect(page.getByText("피드가 기다리고 있어요")).toBeVisible();
  });

  test("editing the ID from the feed opens the ID step and returns to the same feed", async ({ page }) => {
    await openEmptyFeed(page);
    await addPhotos(page, [RED]);
    await page.getByRole("button", { name: "아이디 수정" }).click();
    await expect(page.locator("#onboarding-username")).toBeVisible();
    await page.locator("#onboarding-username").fill("renamed");
    await page.getByRole("button", { name: "다음" }).click();
    await expect(page.getByRole("button", { name: "아이디 수정" })).toHaveText("renamed");
    await expectAllTilesLoaded(page, 1);
  });
});

test.describe("photo editor", () => {
  test("tapping the confirm button twice quickly adds the photo only once", async ({ page }) => {
    await openEmptyFeed(page);
    await page.getByLabel("다음 사진 추가").setInputFiles([RED]);
    await page.locator(".editor-confirm").dblclick();
    await expect(page.getByRole("dialog", { name: "사진 편집" })).toBeHidden();
    await expectStoredDrafts(page, 1);
    await expect(tiles(page)).toHaveCount(1);
  });

  test("an unreadable image shows an error instead of freezing the editor", async ({ page }) => {
    await openEmptyFeed(page);
    await page.getByLabel("다음 사진 추가").setInputFiles([{ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") }]);
    await expect(page.getByRole("alert").filter({ hasText: "읽을 수 없는 사진" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "사진 편집" })).toBeHidden();
    await expect(tiles(page)).toHaveCount(0);
  });

  test("cancelling an import started from the feed stays on the feed", async ({ page }) => {
    await openEmptyFeed(page);
    await addPhotos(page, [RED]);
    await page.getByLabel("인스타 프로필 캡처로 피드 채우기").setInputFiles([profileScreenshot(2)]);
    await page.getByRole("button", { name: "편집 취소" }).click();
    await expectAllTilesLoaded(page, 1);
  });

  test("new photos appear first, in the order they were picked", async ({ page }) => {
    await openEmptyFeed(page);
    await addPhotos(page, [RED]);
    await addPhotos(page, [GREEN, BLUE]);
    await expectAllTilesLoaded(page, 3);
    expect(await tileColors(page)).toEqual(["green", "blue", "red"]);
  });

  test("an unreadable photo among good ones is skipped and the rest are added", async ({ page }) => {
    await openEmptyFeed(page);
    await page.getByLabel("다음 사진 추가").setInputFiles([RED, { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") }, BLUE]);
    const editor = page.getByRole("dialog", { name: "사진 편집" });
    await expect(editor.getByText("1 / 3")).toBeVisible();
    await editor.locator(".editor-confirm").click();
    await expect(editor.getByText("3 / 3")).toBeVisible();
    await editor.locator(".editor-confirm").click();
    await expect(editor).toBeHidden();
    await expectAllTilesLoaded(page, 2);
    expect(await tileColors(page)).toEqual(["red", "blue"]);
  });
});

test.describe("profile screenshot import", () => {
  test("a profile screenshot is split into one photo per grid tile", async ({ page }) => {
    await page.goto("/home");
    await page.getByRole("button", { name: "건너뛰기" }).click();
    await page.locator(".onboarding-upload input").setInputFiles([profileScreenshot(3)]);
    await expect(page.getByRole("dialog", { name: "사진 편집" }).getByText("1 / 9")).toBeVisible();
  });

  test("imported grid photos are added to the feed and survive a restart", async ({ page }) => {
    await page.goto("/home");
    await page.getByRole("button", { name: "건너뛰기" }).click();
    await page.locator(".onboarding-upload input").setInputFiles([profileScreenshot(1)]);
    const editor = page.getByRole("dialog", { name: "사진 편집" });
    for (let index = 1; index <= 3; index += 1) {
      await expect(editor.getByText(`${index} / 3`)).toBeVisible();
      await editor.locator(".editor-confirm").click();
    }
    await expectAllTilesLoaded(page, 3);
    await expectStoredDrafts(page, 3);
    await page.reload();
    await expectAllTilesLoaded(page, 3);
  });
});

test.describe("viewer", () => {
  test("deleting from the viewer removes the photo for good", async ({ page }) => {
    await openEmptyFeed(page);
    await addPhotos(page, [RED, GREEN]);
    await expectStoredDrafts(page, 2);
    await tiles(page).first().click();
    await page.getByRole("button", { name: "게시물 삭제" }).click();
    await expect(page.getByRole("dialog", { name: "Instagram 게시물 보기" })).toBeHidden();
    await expectAllTilesLoaded(page, 1);
    await expectStoredDrafts(page, 1);
    await page.reload();
    await expectAllTilesLoaded(page, 1);
  });

  test("the viewer closes with the close button and the backdrop", async ({ page }) => {
    await openEmptyFeed(page);
    await addPhotos(page, [RED]);
    const viewer = page.getByRole("dialog", { name: "Instagram 게시물 보기" });
    await tiles(page).first().click();
    await page.getByRole("button", { name: "닫기" }).click();
    await expect(viewer).toBeHidden();
    await tiles(page).first().click();
    await viewer.click({ position: { x: 5, y: 5 } });
    await expect(viewer).toBeHidden();
  });
});

test.describe("selection and reorder", () => {
  test("long-press selects, tap toggles more, and deleting selected photos persists", async ({ page }) => {
    await openEmptyFeed(page);
    await addPhotos(page, [RED, GREEN, BLUE]);
    await expectStoredDrafts(page, 3);
    await longPress(page, 0);
    await page.mouse.up();
    await expect(tiles(page).nth(0)).toHaveAttribute("aria-pressed", "true");
    await tiles(page).nth(1).click();
    await expect(tiles(page).nth(1)).toHaveAttribute("aria-pressed", "true");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "선택한 게시물 삭제" }).click();
    await expectAllTilesLoaded(page, 1);
    await expectStoredDrafts(page, 1);
    await page.reload();
    await expectAllTilesLoaded(page, 1);
  });

  test("a selection can be cleared without deleting", async ({ page }) => {
    await openEmptyFeed(page);
    await addPhotos(page, [RED, GREEN]);
    await longPress(page, 0);
    await page.mouse.up();
    await expect(page.getByRole("button", { name: "선택한 게시물 삭제" })).toBeVisible();
    await page.getByRole("button", { name: "선택 취소" }).click();
    await expect(page.getByRole("button", { name: "선택한 게시물 삭제" })).toBeHidden();
    await expect(tiles(page)).toHaveCount(2);
  });

  test("long-press and drag reorders photos and the order survives a restart", async ({ page }) => {
    await openEmptyFeed(page);
    await addPhotos(page, [RED, GREEN, BLUE]);
    await expectAllTilesLoaded(page, 3);
    const target = (await tiles(page).nth(2).boundingBox())!;
    await longPress(page, 0);
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => tileColors(page)).toEqual(["green", "blue", "red"]);
    await page.waitForTimeout(500);
    await page.reload();
    await expectAllTilesLoaded(page, 3);
    expect(await tileColors(page)).toEqual(["green", "blue", "red"]);
  });
});
