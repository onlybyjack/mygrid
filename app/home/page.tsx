"use client";

import { ChangeEvent, ClipboardEvent, useEffect, useRef, useState } from "react";
import { deleteDraftPhoto, readDraftPhotos, saveDraftOrder, saveDraftPhotos } from "../../lib/instagram-export";
import GridMark from "../components/grid-mark";

type Post = { id: string; image: string; draft?: boolean };
const IDENTITY_KEY = "mygrid:identity";
const CROP_WIDTH = 1200;
const CROP_HEIGHT = 1600;

function mediaUrl(url: string) {
  if (url.startsWith("/") || url.startsWith("blob:") || url.startsWith("data:")) return url;
  return `/api/image?url=${encodeURIComponent(url)}`;
}

let draftSaveQueue = Promise.resolve();

function persistDrafts(posts: Post[]) {
  draftSaveQueue = draftSaveQueue.then(() => saveDraftPhotos(posts)).catch(() => undefined);
}

function persistDraftOrder(posts: Post[]) {
  draftSaveQueue = draftSaveQueue.then(() => saveDraftOrder(posts)).catch(() => undefined);
}

async function preparePhoto(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= 1600) { bitmap.close(); return file; }
    const scale = 1600 / longest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close(); return file; }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    return blob ? new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

async function splitGridScreenshot(file: File): Promise<File[]> {
  const bitmap = await createImageBitmap(file);
  const width = bitmap.width;
  const height = bitmap.height;
  const tileWidth = Math.floor(width / 3);
  const output: File[] = [];
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const sourceContext = source.getContext("2d");
  if (!sourceContext || tileWidth < 40) {
    bitmap.close();
    return [];
  }
  sourceContext.drawImage(bitmap, 0, 0);
  const sourcePixels = sourceContext.getImageData(0, 0, width, height).data;
  const luminance = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    return sourcePixels[index] * 0.299 + sourcePixels[index + 1] * 0.587 + sourcePixels[index + 2] * 0.114;
  };
  const rowContrast = (row: number) => {
    if (row <= 0 || row >= height) return 0;
    let contrast = 0;
    let samples = 0;
    for (let x = 4; x < width - 4; x += 8) {
      contrast += Math.abs(luminance(x, row) - luminance(x, row - 1));
      samples += 1;
    }
    return samples ? contrast / samples / 255 : 0;
  };
  const verticalGapContrast = (top: number, tileHeight: number) => {
    let contrast = 0;
    let samples = 0;
    for (let y = top + 8; y < Math.min(height, top + tileHeight) - 8; y += 8) {
      for (const boundary of [tileWidth, tileWidth * 2]) {
        const center = luminance(Math.min(width - 1, boundary), y);
        const sides = (luminance(Math.max(0, boundary - 2), y) + luminance(Math.min(width - 1, boundary + 2), y)) / 2;
        contrast += Math.abs(center - sides) / 255;
        samples += 1;
      }
    }
    return samples ? contrast / samples : 0;
  };

  // A profile grid has two narrow vertical gutters and repeats its horizontal
  // gutter at every tile height. Looking for those repeating edges works for
  // both light and dark Instagram themes; the old dark-row check failed for
  // light screenshots and for profiles whose first post was not dark.
  const minimumTop = Math.floor(height * 0.12);
  const maximumTop = Math.floor(height * 0.72);
  const candidates = [4 / 3].map((ratio) => {
    const candidateHeight = Math.max(40, Math.round(tileWidth * ratio));
    let best = { top: Math.floor(height * 0.2), score: 0 };
    for (let top = minimumTop; top <= maximumTop; top += 2) {
      const rows = Math.min(4, Math.floor((height - top) / candidateHeight));
      if (rows < 1) continue;
      let horizontal = rowContrast(top);
      for (let row = 1; row < rows; row += 1) horizontal += rowContrast(top + row * candidateHeight);
      // Reward candidates with several repeated row boundaries. Averaging by
      // the number of visible rows made a late single boundary score higher
      // than the actual start of the grid on pale screenshots.
      const score = verticalGapContrast(top, candidateHeight) * 0.5 + (horizontal / 4) * 0.5;
      if (score > best.score) best = { top, score };
    }
    return { ...best, tileHeight: candidateHeight };
  }).sort((a, b) => b.score - a.score)[0];
  const gridTop = candidates.score >= 0.035 ? candidates.top : Math.floor(height * 0.2);
  const tileHeight = candidates.score >= 0.035 ? candidates.tileHeight : Math.round(tileWidth * 4 / 3);
  const tileIsEmpty = (row: number, column: number) => {
    let active = 0;
    let samples = 0;
    const left = column * tileWidth;
    const top = gridTop + row * tileHeight;
    const bottom = Math.min(height, top + tileHeight);
    const right = column === 2 ? width : left + tileWidth;
    for (let y = top + 8; y < bottom - 8; y += 12) {
      for (let x = left + 8; x < right - 8; x += 12) {
        const index = (y * width + x) * 4;
        const red = sourcePixels[index];
        const green = sourcePixels[index + 1];
        const blue = sourcePixels[index + 2];
        if (red * 0.299 + green * 0.587 + blue * 0.114 < 242 || Math.max(red, green, blue) - Math.min(red, green, blue) > 18) active += 1;
        samples += 1;
      }
    }
    return active / samples < 0.01;
  };
  const rows = Math.floor((height - gridTop) / tileHeight);
  const canvases: HTMLCanvasElement[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      if (tileIsEmpty(row, column)) continue;
      const canvas = document.createElement("canvas");
      canvas.width = tileWidth;
      canvas.height = tileHeight;
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.drawImage(bitmap, column * tileWidth, gridTop + row * tileHeight, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight);
      canvases.push(canvas);
    }
  }
  const blobs = await Promise.all(canvases.map((canvas) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92))));
  blobs.forEach((blob) => {
    if (blob) output.push(new File([blob], `grid-${output.length + 1}.jpg`, { type: "image/jpeg" }));
  });
  bitmap.close();
  return output;
}

function CloseIcon() {
  return <svg className="viewer-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

function TrashIcon() {
  return <svg className="viewer-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5" /></svg>;
}

export default function Page() {
  const [preview, setPreview] = useState(false);
  const [homeStep, setHomeStep] = useState<1 | 2>(1);
  const [username, setUsername] = useState("");
  const [drafts, setDrafts] = useState<Post[]>([]);
  const [message, setMessage] = useState("");
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [selectedPostIds, setSelectedPostIds] = useState<Set<string>>(new Set());
  const [longPressPostId, setLongPressPostId] = useState<string | null>(null);
  const [draggedPostId, setDraggedPostId] = useState<string | null>(null);
  const [dragOverPostId, setDragOverPostId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [editorFiles, setEditorFiles] = useState<File[]>([]);
  const [editorIndex, setEditorIndex] = useState(0);
  const [editorZoom, setEditorZoom] = useState(1);
  const [editorOffsetX, setEditorOffsetX] = useState(0);
  const [editorOffsetY, setEditorOffsetY] = useState(0);
  const [editorImageSize, setEditorImageSize] = useState<{ width: number; height: number } | null>(null);
  const [editorPreviewUrl, setEditorPreviewUrl] = useState("");
  const [editorFromOnboarding, setEditorFromOnboarding] = useState(false);
  const editedFilesRef = useRef<File[]>([]);
  const editorPointers = useRef(new Map<number, { x: number; y: number }>());
  const editorGesture = useRef<{ startX: number; startY: number; baseX: number; baseY: number; distance: number; zoom: number } | null>(null);
  const draftsRef = useRef<Post[]>([]);
  const longPressTimer = useRef<number | null>(null);
  const pressOrigin = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const longPressPostIdRef = useRef<string | null>(null);
  const longPressMoved = useRef(false);
  const draggedPostIdRef = useRef<string | null>(null);
  const dragOverPostIdRef = useRef<string | null>(null);
  const draggedTile = useRef<HTMLButtonElement | null>(null);
  const tileAnimations = useRef(new Map<string, Animation>());
  const suppressTileClick = useRef(false);

  useEffect(() => {
    let mounted = true;
    let savedUsername = "";
    try {
      const identity = JSON.parse(localStorage.getItem(IDENTITY_KEY) || "{}") as { username?: unknown };
      savedUsername = typeof identity.username === "string" ? identity.username : "";
      setUsername(savedUsername);
    } catch {
      localStorage.removeItem(IDENTITY_KEY);
    }
    void readDraftPhotos().then((savedDrafts) => {
      if (!mounted) return;
      const restored = savedDrafts.map((post) => ({ id: post.id, image: post.image, draft: true }));
      setDrafts(restored);
      if (restored.length && savedUsername) setPreview(true);
    }).catch(() => undefined).finally(() => {
      if (mounted) setHydrated(true);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);


  useEffect(() => {
    if (!selectedPost) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedPost(null);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [selectedPost]);

  const allPosts = drafts;
  draftsRef.current = drafts;

  function saveIdentity(nextUsername: string) {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({ username: nextUsername }));
  }

  function updateUsername(value: string) {
    const next = value.replace(/^@+/, "");
    setUsername(next);
    saveIdentity(next);
  }

  function openPhotoEditor(files: File[], fromOnboarding = false) {
    editedFilesRef.current = [];
    setEditorFromOnboarding(fromOnboarding);
    setPreview(true);
    setEditorFiles(files);
    setEditorIndex(0);
    setEditorZoom(1);
    setEditorOffsetX(0);
    setEditorOffsetY(0);
    setEditorImageSize(null);
  }

  useEffect(() => {
    const file = editorFiles[editorIndex];
    if (!file) { setEditorPreviewUrl(""); return; }
    const url = URL.createObjectURL(file);
    setEditorPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [editorFiles, editorIndex]);

  async function cropPhoto(file: File): Promise<File> {
    const bitmap = await createImageBitmap(file);
    const outputWidth = CROP_WIDTH;
    const outputHeight = CROP_HEIGHT;
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, outputWidth, outputHeight);
      const fitScale = bitmap.width > bitmap.height
        ? Math.min(outputWidth / bitmap.width, outputHeight / bitmap.height)
        : Math.max(outputWidth / bitmap.width, outputHeight / bitmap.height);
      const imageWidth = bitmap.width * fitScale * editorZoom;
      const imageHeight = bitmap.height * fitScale * editorZoom;
      const offsetX = editorOffsetX * outputWidth;
      const offsetY = editorOffsetY * outputHeight;
      context.drawImage(bitmap, (outputWidth - imageWidth) / 2 + offsetX, (outputHeight - imageHeight) / 2 + offsetY, imageWidth, imageHeight);
    }
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    return blob ? new File([blob], `edited-${Date.now()}.jpg`, { type: "image/jpeg" }) : file;
  }

  async function confirmCrop() {
    const file = editorFiles[editorIndex];
    if (!file) return;
    setMessage("사진을 준비하고 있어요.");
    const cropped = await cropPhoto(file);
    editedFilesRef.current.push(cropped);
    if (editorIndex + 1 < editorFiles.length) {
      setEditorIndex((index) => index + 1);
      setEditorZoom(1);
      setEditorOffsetX(0);
      setEditorOffsetY(0);
      return;
    }
    const prepared = await Promise.all(editedFilesRef.current.map(preparePhoto));
    const nextDrafts = [...prepared.map((photo, index) => ({ id: `draft-${Date.now()}-${index}-${globalThis.crypto.randomUUID()}`, image: URL.createObjectURL(photo), draft: true })), ...drafts];
    setDrafts(nextDrafts);
    persistDrafts(nextDrafts);
    setEditorFiles([]);
    setMessage("");
    setPreview(true);
  }

  function editorPanBounds(zoom = editorZoom) {
    if (!editorImageSize) return { x: 1, y: 1 };
    const fitScale = editorImageSize.width > editorImageSize.height
      ? Math.min(CROP_WIDTH / editorImageSize.width, CROP_HEIGHT / editorImageSize.height)
      : Math.max(CROP_WIDTH / editorImageSize.width, CROP_HEIGHT / editorImageSize.height);
    const scaledWidth = editorImageSize.width * fitScale * zoom;
    const scaledHeight = editorImageSize.height * fitScale * zoom;
    return {
      x: Math.max(0, (scaledWidth - CROP_WIDTH) / (CROP_WIDTH * 2)),
      y: Math.max(0, (scaledHeight - CROP_HEIGHT) / (CROP_HEIGHT * 2)),
    };
  }

  function clampEditorOffset(value: number, limit: number) {
    return Math.max(-limit, Math.min(limit, value));
  }

  useEffect(() => {
    const bounds = editorPanBounds();
    setEditorOffsetX((offset) => clampEditorOffset(offset, bounds.x));
    setEditorOffsetY((offset) => clampEditorOffset(offset, bounds.y));
  }, [editorImageSize, editorZoom]);

  function editorPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    editorPointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (editorPointers.current.size === 1) {
      editorGesture.current = { startX: event.clientX, startY: event.clientY, baseX: editorOffsetX, baseY: editorOffsetY, distance: 0, zoom: editorZoom };
    } else if (editorPointers.current.size === 2) {
      const points = [...editorPointers.current.values()];
      editorGesture.current = { startX: (points[0].x + points[1].x) / 2, startY: (points[0].y + points[1].y) / 2, baseX: editorOffsetX, baseY: editorOffsetY, distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), zoom: editorZoom };
    }
  }

  function editorPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const previous = editorPointers.current.get(event.pointerId);
    if (!previous || !editorGesture.current) return;
    editorPointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...editorPointers.current.values()];
    if (points.length === 1) {
      const stage = event.currentTarget.getBoundingClientRect();
      const bounds = editorPanBounds();
      setEditorOffsetX(clampEditorOffset(editorGesture.current.baseX + (event.clientX - editorGesture.current.startX) / stage.width, bounds.x));
      setEditorOffsetY(clampEditorOffset(editorGesture.current.baseY + (event.clientY - editorGesture.current.startY) / stage.height, bounds.y));
    } else if (points.length === 2 && editorGesture.current.distance > 0) {
      const stage = event.currentTarget.getBoundingClientRect();
      const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      const midpointX = (points[0].x + points[1].x) / 2;
      const midpointY = (points[0].y + points[1].y) / 2;
      const nextZoom = Math.max(1, Math.min(2.5, editorGesture.current.zoom * distance / editorGesture.current.distance));
      const zoomRatio = nextZoom / editorGesture.current.zoom;
      const bounds = editorPanBounds(nextZoom);
      setEditorOffsetX(clampEditorOffset(editorGesture.current.baseX + (1 - zoomRatio) * (editorGesture.current.startX - (stage.left + stage.width / 2)) / stage.width + (midpointX - editorGesture.current.startX) / stage.width, bounds.x));
      setEditorOffsetY(clampEditorOffset(editorGesture.current.baseY + (1 - zoomRatio) * (editorGesture.current.startY - (stage.top + stage.height / 2)) / stage.height + (midpointY - editorGesture.current.startY) / stage.height, bounds.y));
      setEditorZoom(nextZoom);
    }
  }

  function editorPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    editorPointers.current.delete(event.pointerId);
    editorGesture.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Pointer capture is already released. */ }
  }

  function editorWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const stage = event.currentTarget.getBoundingClientRect();
    const nextZoom = Math.max(1, Math.min(2.5, editorZoom - event.deltaY * 0.002));
    const zoomRatio = nextZoom / editorZoom;
    const bounds = editorPanBounds(nextZoom);
    setEditorOffsetX(clampEditorOffset(editorOffsetX + (1 - zoomRatio) * (event.clientX - (stage.left + stage.width / 2)) / stage.width, bounds.x));
    setEditorOffsetY(clampEditorOffset(editorOffsetY + (1 - zoomRatio) * (event.clientY - (stage.top + stage.height / 2)) / stage.height, bounds.y));
    setEditorZoom(nextZoom);
  }

  function choosePhotos(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!selected.length) {
      setMessage("사진을 한 장 이상 선택해 주세요.");
      event.target.value = "";
      return;
    }
    openPhotoEditor(selected);
    event.target.value = "";
  }

  function startEmptyProfile() {
    setPreview(true);
    setMessage("");
  }

  function continueToScreenshot() {
    setHomeStep(2);
    setMessage("");
  }

  function editProfileIdentity() {
    setSelectedPost(null);
    setPreview(false);
    setMessage("");
  }

  async function chooseGridScreenshot(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setMessage("프로필 캡처를 분석하고 있어요.");
    try {
      const selected = await splitGridScreenshot(file);
      input.value = "";
      if (!selected.length) {
        setMessage("그리드 캡처를 읽지 못했어요. 다시 선택해 주세요.");
        return;
      }
      openPhotoEditor(selected, true);
    } catch {
      input.value = "";
      setMessage("그리드 캡처를 읽지 못했어요. 다시 선택해 주세요.");
    }
  }

  async function pasteGridScreenshot(event: ClipboardEvent<HTMLElement>) {
    const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    setMessage("프로필 캡처를 분석하고 있어요.");
    const selected = await splitGridScreenshot(file).catch(() => []);
    if (!selected.length) {
      setMessage("그리드 캡처를 읽지 못했어요. 다시 붙여넣어 주세요.");
      return;
    }
    openPhotoEditor(selected, true);
  }

  function startTilePress(event: React.PointerEvent<HTMLButtonElement>, postId: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    const tile = event.currentTarget;
    const pointerId = event.pointerId;
    pressOrigin.current = { x: event.clientX, y: event.clientY, pointerId };
    longPressTimer.current = window.setTimeout(() => {
      longPressPostIdRef.current = postId;
      longPressMoved.current = false;
      dragOverPostIdRef.current = null;
      setLongPressPostId(postId);
      suppressTileClick.current = true;
      draggedTile.current = tile;
      try { tile.setPointerCapture(pointerId); } catch { /* Pointer may have ended before the long press. */ }
    }, 450);
  }

  function reorderPosts(postId: string, targetId: string) {
    const current = draftsRef.current;
    const from = current.findIndex((post) => post.id === postId);
    const to = current.findIndex((post) => post.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const before = new Map<string, DOMRect>();
    document.querySelectorAll<HTMLElement>("[data-post-id]").forEach((tile) => {
      if (tile.dataset.postId) before.set(tile.dataset.postId, tile.getBoundingClientRect());
    });
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    draftsRef.current = next;
    setDrafts(next);
    persistDraftOrder(next);
    window.requestAnimationFrame(() => {
      next.forEach((post) => {
        if (post.id === postId) return;
        const tile = document.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(post.id)}"]`);
        const previous = before.get(post.id);
        if (!tile || !previous) return;
        const currentRect = tile.getBoundingClientRect();
        const offsetX = previous.left - currentRect.left;
        const offsetY = previous.top - currentRect.top;
        if (!offsetX && !offsetY) return;
        tileAnimations.current.get(post.id)?.cancel();
        const animation = tile.animate(
          [{ transform: `translate(${offsetX}px, ${offsetY}px)` }, { transform: "translate(0, 0)" }],
          { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
        );
        tileAnimations.current.set(post.id, animation);
        void animation.finished.then(() => {
          if (tileAnimations.current.get(post.id) === animation) tileAnimations.current.delete(post.id);
        }).catch(() => undefined);
      });
    });
  }

  function moveTile(event: React.PointerEvent<HTMLElement>) {
    if (!draggedPostIdRef.current) {
      const origin = pressOrigin.current;
      const longPressedId = longPressPostIdRef.current;
      if (longPressedId) {
        if (!longPressMoved.current && origin?.pointerId === event.pointerId && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) {
          longPressMoved.current = true;
          longPressPostIdRef.current = null;
          pressOrigin.current = null;
          setLongPressPostId(null);
          draggedPostIdRef.current = longPressedId;
          setDraggedPostId(longPressedId);
        } else if (!longPressMoved.current) {
          return;
        }
      } else if (origin?.pointerId === event.pointerId && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) {
        if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
        pressOrigin.current = null;
        return;
      }
    }
    if (!draggedPostIdRef.current) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-post-id]")?.dataset.postId;
    if (target !== dragOverPostIdRef.current) {
      dragOverPostIdRef.current = target || null;
      setDragOverPostId(target || null);
      if (target && target !== draggedPostIdRef.current) reorderPosts(draggedPostIdRef.current, target);
    }
  }

  function finishTilePress(event: React.PointerEvent<HTMLElement>) {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    pressOrigin.current = null;
    const draggedId = draggedPostIdRef.current;
    if (!draggedId) {
      const selectedId = longPressPostIdRef.current;
      if (selectedId && !longPressMoved.current) toggleSelectedPost(selectedId);
      try { draggedTile.current?.releasePointerCapture(event.pointerId); } catch { /* Pointer capture is already released. */ }
      longPressPostIdRef.current = null;
      longPressMoved.current = false;
      setLongPressPostId(null);
      draggedTile.current = null;
      window.setTimeout(() => { suppressTileClick.current = false; }, 250);
      return;
    }
    const target = dragOverPostIdRef.current || document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-post-id]")?.dataset.postId;
    if (target && target !== draggedId) reorderPosts(draggedId, target);
    try { draggedTile.current?.releasePointerCapture(event.pointerId); } catch { /* Pointer capture is already released. */ }
    draggedPostIdRef.current = null;
    dragOverPostIdRef.current = null;
    longPressPostIdRef.current = null;
    longPressMoved.current = false;
    draggedTile.current = null;
    setDraggedPostId(null);
    setDragOverPostId(null);
    setLongPressPostId(null);
    window.setTimeout(() => { suppressTileClick.current = false; }, 0);
  }

  function cancelTilePress() {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    pressOrigin.current = null;
    draggedPostIdRef.current = null;
    dragOverPostIdRef.current = null;
    longPressPostIdRef.current = null;
    longPressMoved.current = false;
    draggedTile.current = null;
    setDraggedPostId(null);
    setDragOverPostId(null);
    setLongPressPostId(null);
    suppressTileClick.current = false;
  }

  function openPost(post: Post) {
    if (suppressTileClick.current) return;
    setSelectedPost(post);
  }

  function openPostFromTile(event: React.MouseEvent<HTMLButtonElement>, post: Post) {
    const image = event.currentTarget.querySelector("img");
    openPost(image?.currentSrc ? { ...post, image: image.currentSrc } : post);
  }

  function toggleSelectedPost(postId: string) {
    setSelectedPostIds((current) => {
      const next = new Set(current);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  }

  function handleTileClick(event: React.MouseEvent<HTMLButtonElement>, post: Post) {
    if (suppressTileClick.current) return;
    if (selectedPostIds.size > 0) {
      toggleSelectedPost(post.id);
      return;
    }
    openPostFromTile(event, post);
  }

  function removeSelectedPosts() {
    if (!selectedPostIds.size || !window.confirm(`${selectedPostIds.size}개의 게시물을 삭제할까요?`)) return;
    const selectedIds = selectedPostIds;
    const nextPosts = drafts.filter((post) => !selectedIds.has(post.id));
    draftsRef.current = nextPosts;
    setDrafts(nextPosts);
    setSelectedPostIds(new Set());
    void Promise.all([...selectedIds].filter((postId) => postId.startsWith("draft-")).map((postId) => deleteDraftPhoto(postId))).catch(() => undefined);
    persistDrafts(nextPosts);
  }

  function removePost(postId: string) {
    const nextPosts = drafts.filter((post) => post.id !== postId);
    setDrafts(nextPosts);
    if (postId.startsWith("draft-")) void deleteDraftPhoto(postId).catch(() => undefined);
    setSelectedPost(null);
    persistDrafts(nextPosts);
  }


  if (!hydrated) {
    return <main className="splash-page" aria-label="MyGrid 불러오는 중" aria-busy="true">
      <div className="splash-logo"><GridMark /></div>
      <strong>mygrid</strong>
    </main>;
  }

  if (!preview) {
    return <main className="onboarding-page" onPaste={homeStep === 2 ? pasteGridScreenshot : undefined}>
      <header className="onboarding-header"><div className="brand"><div className="logo"><GridMark /></div><strong>mygrid</strong></div><span>{String(homeStep).padStart(2, "0")} / 02</span></header>
      {homeStep === 1 ? <section className="onboarding-screen onboarding-identity" aria-labelledby="identity-title">
        <div className="onboarding-copy"><small>WELCOME TO MYGRID</small><h1 id="identity-title">인스타 아이디를<br />알려주세요.</h1><p>피드 상단에 표시할 이름이에요.<br />나중에 다시 바꿀 수 있어요.</p></div>
        <div className="onboarding-bottom"><label className="onboarding-input-label" htmlFor="onboarding-username">Instagram 아이디 <em>선택 입력</em></label><div className="onboarding-input"><b>@</b><input id="onboarding-username" value={username} onChange={(event) => updateUsername(event.target.value)} placeholder="아이디를 입력해 주세요" autoCapitalize="none" autoCorrect="off" /></div><button className="onboarding-primary" type="button" onClick={continueToScreenshot}><b>다음</b><span>→</span></button><button className="onboarding-text-button" type="button" onClick={continueToScreenshot}>건너뛰기</button></div>
      </section> : <section className="onboarding-screen onboarding-capture" aria-labelledby="capture-title">
        <div className="onboarding-copy"><small>02 / 02 · PROFILE</small><h1 id="capture-title">프로필 화면을<br />캡처해 주세요.</h1><p>인스타 프로필 전체 화면을 올리면<br />사진을 자동으로 나눠드려요.</p></div>
        <div className="capture-guide" aria-label="인스타 프로필 캡처 예시"><div className="guide-phone"><div className="guide-status"><i /> Instagram <i /></div><div className="guide-profile"><span /><i /><i /><i /></div><div className="guide-grid">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</div><div className="guide-scan" /><div className="guide-finger" /></div></div>
        {message && <div className="error onboarding-error" role="alert">{message}</div>}
        <div className="onboarding-bottom"><label className="onboarding-upload"><GridMark uniform /><span><b>캡처한 이미지 선택</b><small>프로필 캡처 한 장이면 충분해요.</small></span><strong>↑</strong><input type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseGridScreenshot} /></label><button className="onboarding-primary" type="button" onClick={startEmptyProfile}><b>빈 피드로 바로 시작</b><span>→</span></button><div className="onboarding-secondary-actions"><button className="onboarding-text-button" type="button" onClick={() => setHomeStep(1)}>이전</button><button className="onboarding-text-button" type="button" onClick={startEmptyProfile}>건너뛰기</button></div></div>
      </section>}
    </main>;
  }

  return <>
    <main className="preview-page">
    <header className="profile-bar"><label className="profile-add-button" aria-label="다음 사진 추가">＋<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={choosePhotos} /></label><div className="profile-identity"><button className="profile-username" type="button" aria-label="아이디 수정" onClick={editProfileIdentity}>@{username || "mygrid"}</button></div><span aria-hidden="true" /></header>
    <section className="profile-scroll" onPointerMove={moveTile} onPointerUp={finishTilePress} onPointerCancel={cancelTilePress}>
      <div className="profile-summary"><div className="avatar" /><div className="stat"><b>{allPosts.length}</b><small>게시물</small></div><div className="stat"><b>—</b><small>팔로워</small></div><div className="stat"><b>—</b><small>팔로잉</small></div></div>
      <h2 className="profile-name">{username || "mygrid"}</h2>
      <div className="profile-tabs"><div className="profile-tab selected"><GridMark uniform /></div></div>
      {allPosts.length ? <div className="grid">{Array.from({ length: Math.ceil(allPosts.length / 3) }, (_, row) => <div className="grid-row" key={row}>{[0, 1, 2].map((column) => { const post = allPosts[row * 3 + column]; if (!post) return <div className="tile placeholder" key={`empty-${row}-${column}`} />; const selected = selectedPostIds.has(post.id); const selectionMode = selectedPostIds.size > 0 || longPressPostId !== null; return <button className={`tile${draggedPostId === post.id ? " is-dragging" : ""}${dragOverPostId === post.id ? " drop-target" : ""}`} type="button" key={post.id} data-post-id={post.id} onPointerDown={(event) => startTilePress(event, post.id)} onContextMenu={(event) => event.preventDefault()} onDragStart={(event) => event.preventDefault()} onSelect={(event) => event.preventDefault()} onClick={(event) => handleTileClick(event, post)} aria-pressed={selected} aria-label={selectionMode ? "게시물 선택" : "길게 눌러 게시물 이동"}><img src={mediaUrl(post.image)} alt="게시물" /><span className={`tile-selector${selectionMode ? " is-visible" : ""}${selected ? " is-selected" : ""}`} aria-hidden="true"><i /></span></button>; })}</div>)}</div> : <div className="empty"><b>피드가 기다리고 있어요</b><small>사진을 추가해 나만의 그리드를 만들어 보세요.</small></div>}
    </section>
    </main>
    {selectedPostIds.size > 0 && <button className="selection-delete" type="button" onClick={removeSelectedPosts} aria-label="선택한 게시물 삭제" title="선택한 게시물 삭제"><TrashIcon /></button>}
    {selectedPost && <div className="image-viewer" role="dialog" aria-modal="true" aria-label="Instagram 게시물 보기" onClick={() => setSelectedPost(null)}>
      <div className="viewer-content" onClick={(event) => event.stopPropagation()}>
        <button className="viewer-close" type="button" onClick={() => setSelectedPost(null)} aria-label="닫기" title="닫기"><CloseIcon /></button>
        <img className="viewer-image" src={mediaUrl(selectedPost.image)} alt="Instagram 게시물 크게 보기" />
        <button className="viewer-delete" type="button" onClick={() => removePost(selectedPost.id)} aria-label="게시물 삭제" title="게시물 삭제"><TrashIcon /></button>
      </div>
    </div>}
    {editorFiles.length > 0 && editorPreviewUrl && <div className="photo-editor" role="dialog" aria-modal="true" aria-label="사진 편집"><div className="editor-panel"><div className="editor-heading"><button className="editor-close" type="button" aria-label="편집 취소" onClick={() => { setEditorFiles([]); setMessage(""); if (editorFromOnboarding) { setPreview(false); setHomeStep(2); } }}>×</button><span>{editorIndex + 1} / {editorFiles.length}</span></div><div className="crop-stage crop-portrait" onPointerDown={editorPointerDown} onPointerMove={editorPointerMove} onPointerUp={editorPointerUp} onPointerCancel={editorPointerUp} onWheel={editorWheel}><img src={editorPreviewUrl} alt="편집할 사진" onLoad={(event) => setEditorImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} style={{ objectFit: editorImageSize && editorImageSize.width <= editorImageSize.height ? "cover" : "contain", transform: `translate(${editorOffsetX * 100}%, ${editorOffsetY * 100}%) scale(${editorZoom})` }} /><div className="crop-grid" aria-hidden="true"><i /><i /><i /><i /></div></div><button className="editor-confirm" type="button" onClick={() => void confirmCrop()}>{editorIndex + 1 < editorFiles.length ? "다음 →" : "→"}</button></div></div>}
  </>;
}
