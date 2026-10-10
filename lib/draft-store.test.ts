import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDraftPhotos, deleteDraftPhotos, readDraftPhotos, saveDraftOrder } from "./draft-store";

function photo(id: string, text = id) {
  return { id, blob: new Blob([text], { type: "image/jpeg" }) };
}

async function texts(posts: Array<{ blob: Blob }>) {
  return Promise.all(posts.map((post) => post.blob.text()));
}

function rawRecords() {
  return new Promise<Array<Record<string, unknown>>>((resolve) => {
    const open = indexedDB.open("mygrid-export");
    open.onsuccess = () => {
      const all = open.result.transaction("media").objectStore("media").getAll();
      all.onsuccess = () => { open.result.close(); resolve(all.result); };
    };
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe("draft store", () => {
  it("returns nothing when no drafts were saved", async () => {
    expect(await readDraftPhotos()).toEqual([]);
  });

  it("restores added photos in the given order with their bytes", async () => {
    await addDraftPhotos([photo("b"), photo("a")], ["b", "a"]);
    const restored = await readDraftPhotos();
    expect(restored.map((post) => post.id)).toEqual(["b", "a"]);
    expect(await texts(restored)).toEqual(["b", "a"]);
    expect(restored[0].blob.type).toBe("image/jpeg");
  });

  it("stores bytes instead of Blob objects so WebKit private mode and stale blob files can't break images", async () => {
    await addDraftPhotos([photo("a")], ["a"]);
    const [record] = await rawRecords();
    expect(record.blob).toBeUndefined();
    expect(record.bytes).toBeInstanceOf(ArrayBuffer);
  });

  it("adding photos does not rewrite photos that were already stored", async () => {
    await addDraftPhotos([photo("a")], ["a"]);
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    await addDraftPhotos([photo("b")], ["b", "a"]);
    const writtenKeys = put.mock.calls.map(([value, key]) => (value as { key?: string }).key ?? key);
    put.mockRestore();
    expect(writtenKeys).not.toContain("draft:a");
    expect((await readDraftPhotos()).map((post) => post.id)).toEqual(["b", "a"]);
  });

  it("reordering only updates the order, not the photo records", async () => {
    await addDraftPhotos([photo("a"), photo("b"), photo("c")], ["a", "b", "c"]);
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    await saveDraftOrder(["c", "a", "b"]);
    const writtenKeys = put.mock.calls.map(([value, key]) => (value as { key?: string }).key ?? key);
    put.mockRestore();
    expect(writtenKeys.filter((key) => String(key).startsWith("draft:"))).toEqual([]);
    expect((await readDraftPhotos()).map((post) => post.id)).toEqual(["c", "a", "b"]);
  });

  it("deletes only the chosen photos", async () => {
    await addDraftPhotos([photo("a"), photo("b"), photo("c")], ["a", "b", "c"]);
    await deleteDraftPhotos(["a", "c"], ["b"]);
    const restored = await readDraftPhotos();
    expect(restored.map((post) => post.id)).toEqual(["b"]);
    expect(await rawRecords()).toHaveLength(1);
  });

  it("still reads photos saved by the previous Blob-based format", async () => {
    await new Promise<void>((resolve) => {
      const open = indexedDB.open("mygrid-export", 1);
      open.onupgradeneeded = () => { open.result.createObjectStore("profiles"); open.result.createObjectStore("media", { keyPath: "key" }); };
      open.onsuccess = () => {
        const transaction = open.result.transaction("media", "readwrite");
        transaction.objectStore("media").put({ key: "draft:old-2", id: "old-2", blob: new Blob(["two"], { type: "image/png" }), order: 1 });
        transaction.objectStore("media").put({ key: "draft:old-1", id: "old-1", blob: new Blob(["one"], { type: "image/png" }), order: 0 });
        transaction.objectStore("media").put({ key: "active:x", id: "x", blob: new Blob(["x"]) });
        transaction.oncomplete = () => { open.result.close(); resolve(); };
      };
    });
    const restored = await readDraftPhotos();
    expect(restored.map((post) => post.id)).toEqual(["old-1", "old-2"]);
    expect(await texts(restored)).toEqual(["one", "two"]);
  });

  it("keeps photos missing from the saved order instead of dropping them", async () => {
    await addDraftPhotos([photo("a"), photo("b")], ["a"]);
    expect((await readDraftPhotos()).map((post) => post.id)).toEqual(["a", "b"]);
  });
});
