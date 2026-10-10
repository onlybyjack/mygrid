export type DraftPhoto = { id: string; blob: Blob };

// Photos are stored as raw bytes, not Blobs. WebKit rejects Blobs in
// IndexedDB during private browsing, and Blobs read back from IndexedDB are
// backed by files that WebKit removes once their record is rewritten, which
// turned already-visible images into broken "X" boxes.
type DraftRecord = { key: string; id: string; bytes?: ArrayBuffer; type?: string; blob?: Blob; order?: number };

const DB_NAME = "mygrid-export";
const DB_VERSION = 1;
const DRAFT_PREFIX = "draft:";
const ORDER_KEY = "draft-order";

export function request<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

export function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => { request.result.createObjectStore("profiles"); request.result.createObjectStore("media", { keyPath: "key" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function write(stores: string[], apply: (transaction: IDBTransaction) => void) {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(stores, "readwrite");
      apply(transaction);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

export async function addDraftPhotos(photos: DraftPhoto[], order: string[]) {
  // Read every Blob before opening the transaction: awaiting inside it would
  // let IndexedDB auto-commit before the writes are queued.
  const records = await Promise.all(photos.map(async (photo): Promise<DraftRecord> => ({
    key: `${DRAFT_PREFIX}${photo.id}`,
    id: photo.id,
    bytes: await photo.blob.arrayBuffer(),
    type: photo.blob.type || "image/jpeg",
  })));
  await write(["profiles", "media"], (transaction) => {
    records.forEach((record) => transaction.objectStore("media").put(record));
    transaction.objectStore("profiles").put(order, ORDER_KEY);
  });
}

export async function deleteDraftPhotos(ids: string[], order: string[]) {
  await write(["profiles", "media"], (transaction) => {
    ids.forEach((id) => transaction.objectStore("media").delete(`${DRAFT_PREFIX}${id}`));
    transaction.objectStore("profiles").put(order, ORDER_KEY);
  });
}

export async function saveDraftOrder(order: string[]) {
  await write(["profiles"], (transaction) => transaction.objectStore("profiles").put(order, ORDER_KEY));
}

function toBlob(record: DraftRecord) {
  if (record.bytes) return new Blob([record.bytes], { type: record.type || "image/jpeg" });
  return record.blob ?? null;
}

export async function readDraftPhotos(): Promise<DraftPhoto[]> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(["profiles", "media"]);
    const [order, records] = await Promise.all([
      request<unknown>(transaction.objectStore("profiles").get(ORDER_KEY)),
      request<DraftRecord[]>(transaction.objectStore("media").getAll()),
    ]);
    const position = new Map(Array.isArray(order) ? order.map((id, index) => [String(id), index]) : []);
    const rank = (record: DraftRecord) => position.get(record.id) ?? position.size + (record.order ?? 0);
    const drafts = records.filter((record) => record.key.startsWith(DRAFT_PREFIX)).sort((a, b) => rank(a) - rank(b));
    // Copy legacy Blob records into memory so their object URLs never point
    // at a file WebKit may later delete.
    const restored = await Promise.all(drafts.map(async (record) => {
      const blob = toBlob(record);
      if (!blob) return null;
      try {
        return { id: record.id, blob: new Blob([await blob.arrayBuffer()], { type: blob.type || "image/jpeg" }) };
      } catch {
        return null;
      }
    }));
    return restored.filter((photo): photo is DraftPhoto => photo !== null);
  } finally {
    db.close();
  }
}
