import { strFromU8, unzipSync } from "fflate";

export type ImportedMedia = { id: string; image: string; caption?: string; timestamp?: number };
type StoredMedia = { id: string; blob: Blob; caption?: string; timestamp?: number };

type StoredProfile = { username: string; count: number; updatedAt: number };
const DB_NAME = "mygrid-export";
const DB_VERSION = 1;

function isImagePath(value: string) {
  return /\.(jpe?g|png|webp|heic)$/i.test(value);
}

function extensionType(value: string) {
  if (/\.png$/i.test(value)) return "image/png";
  if (/\.webp$/i.test(value)) return "image/webp";
  return "image/jpeg";
}

function findZipEntry(entries: Record<string, Uint8Array>, uri: string) {
  const normalized = uri.replace(/^\.?\//, "").replace(/\\/g, "/");
  return entries[normalized] ?? Object.entries(entries).find(([name]) => name.endsWith(`/${normalized}`))?.[1];
}

function collectRecords(value: unknown, records: Array<{ uri: string; caption?: string; timestamp?: number }>, context?: { caption?: string; timestamp?: number }) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectRecords(item, records, context));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const caption = typeof record.title === "string" ? record.title : context?.caption;
  const timestamp = typeof record.creation_timestamp === "number" ? record.creation_timestamp : context?.timestamp;
  for (const key of ["uri", "url"]) {
    if (typeof record[key] === "string" && isImagePath(record[key] as string)) records.push({ uri: record[key] as string, caption, timestamp });
  }
  for (const child of Object.values(record)) collectRecords(child, records, { caption, timestamp });
}

export async function parseInstagramExport(file: File): Promise<ImportedMedia[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries: Record<string, Uint8Array> = file.name.toLowerCase().endsWith(".zip") ? unzipSync(bytes) : { [file.name]: bytes };
  const records: Array<{ uri: string; caption?: string; timestamp?: number }> = [];
  for (const [name, content] of Object.entries(entries)) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    try { collectRecords(JSON.parse(strFromU8(content)), records); } catch { /* Ignore unrelated export files. */ }
  }
  const seen = new Set<string>();
  return records.flatMap((record, index) => {
    if (seen.has(record.uri)) return [];
    seen.add(record.uri);
    const image = findZipEntry(entries, record.uri);
    if (!image) return record.uri.startsWith("https://") ? [{ id: `import-${index}`, image: record.uri, caption: record.caption, timestamp: record.timestamp }] : [];
    const safeBytes = new Uint8Array(image.byteLength);
    safeBytes.set(image);
    const blobUrl = URL.createObjectURL(new Blob([safeBytes.buffer], { type: extensionType(record.uri) }));
    return [{ id: `import-${index}`, image: blobUrl, caption: record.caption, timestamp: record.timestamp }];
  });
}

function request<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => { request.result.createObjectStore("profiles"); request.result.createObjectStore("media", { keyPath: "key" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveImportedProfile(username: string, posts: ImportedMedia[]) {
  const db = await openDatabase();
  const stored = await Promise.all(posts.map(async (post): Promise<StoredMedia> => ({ id: post.id, blob: await fetch(post.image).then((response) => response.blob()), caption: post.caption, timestamp: post.timestamp })));
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(["profiles", "media"], "readwrite");
    transaction.objectStore("profiles").put({ username, count: stored.length, updatedAt: Date.now() } satisfies StoredProfile, "active");
    stored.forEach((post) => transaction.objectStore("media").put({ ...post, key: `active:${post.id}` }));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function readImportedProfile(): Promise<{ username: string; posts: ImportedMedia[] } | null> {
  const db = await openDatabase();
  const profile = await request<StoredProfile | undefined>(db.transaction("profiles").objectStore("profiles").get("active"));
  if (!profile) { db.close(); return null; }
  const media = await request<Array<StoredMedia & { key: string }>>(db.transaction("media").objectStore("media").getAll());
  db.close();
  return { username: profile.username, posts: media.filter((post) => post.key.startsWith("active:")).map((post) => ({ id: post.id, image: URL.createObjectURL(post.blob), caption: post.caption, timestamp: post.timestamp })) };
}

export async function saveDraftPhotos(posts: ImportedMedia[]) {
  const db = await openDatabase();
  const mediaStore = db.transaction("media").objectStore("media");
  const current = await request<Array<StoredMedia & { key: string }>>(mediaStore.getAll());
  const stored = await Promise.all(posts.map(async (post): Promise<StoredMedia> => ({
    id: post.id,
    blob: await fetch(post.image).then((response) => response.blob()),
    caption: post.caption,
    timestamp: post.timestamp,
  })));
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("media", "readwrite");
    const store = transaction.objectStore("media");
    current.filter((post) => post.key.startsWith("draft:")).forEach((post) => store.delete(post.key));
    stored.forEach((post) => store.put({ ...post, key: `draft:${post.id}` }));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function readDraftPhotos(): Promise<ImportedMedia[]> {
  const db = await openDatabase();
  const media = await request<Array<StoredMedia & { key: string }>>(db.transaction("media").objectStore("media").getAll());
  db.close();
  return media.filter((post) => post.key.startsWith("draft:")).map((post) => ({
    id: post.id,
    image: URL.createObjectURL(post.blob),
    caption: post.caption,
    timestamp: post.timestamp,
  }));
}

export async function deleteDraftPhoto(id: string) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("media", "readwrite");
    transaction.objectStore("media").delete(`draft:${id}`);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}
