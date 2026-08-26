"use client";

import { ChangeEvent, ClipboardEvent, TouchEvent, useEffect, useRef, useState } from "react";
import { deleteDraftPhoto, readDraftPhotos, saveDraftOrder, saveDraftPhotos } from "../../lib/instagram-export";
import GridMark from "../components/grid-mark";

type Post = { id: string; image: string; draft?: boolean };
const IDENTITY_KEY = "mygrid:identity";
const CROP_WIDTH = 1200;
const CROP_HEIGHT = 1600;

const INSTALL_TIPS = [
  { kind: "ios", platform: "iPhone · Safari", title: "공유 버튼을 눌러보세요", description: "Safari 하단의 공유 아이콘을 선택하세요." },
  { kind: "android", platform: "Android · Chrome", title: "홈 화면에 추가를 선택하세요", description: "메뉴에서 ‘홈 화면에 추가’를 누르면 끝이에요." },
  { kind: "done", platform: "mygrid 앱", title: "이제 앱처럼 열어보세요", description: "홈 화면의 mygrid 아이콘에서 바로 시작할 수 있어요." },
] as const;

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
  const expectedHeight = tileWidth * 1.3333;
  const rowActivity = (row: number, column: number) => {
    let active = 0;
    let samples = 0;
    const left = column * tileWidth;
    const right = column === 2 ? width : left + tileWidth;
    for (let x = left + 4; x < right - 4; x += 8) {
      const index = (row * width + x) * 4;
      const red = sourcePixels[index];
      const green = sourcePixels[index + 1];
      const blue = sourcePixels[index + 2];
      const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
      if (luminance < 242 || Math.max(red, green, blue) - Math.min(red, green, blue) > 18) active += 1;
      samples += 1;
    }
    return active / samples > 0.12;
  };
  const segments: Array<{ column: number; top: number; height: number }> = [];
  for (let column = 0; column < 3; column += 1) {
    let start = -1;
    let blankRows = 0;
    for (let row = 0; row <= height; row += 1) {
      const active = row < height && rowActivity(row, column);
      if (active) {
        if (start < 0) start = row;
        blankRows = 0;
      } else if (start >= 0) {
        blankRows += 1;
        if (blankRows >= 10 || row === height) {
          const end = row - blankRows;
          if (end - start > 60) segments.push({ column, top: start, height: end - start });
          start = -1;
          blankRows = 0;
        }
      }
    }
  }
  segments.sort((a, b) => a.top - b.top || a.column - b.column);
  for (const segment of segments) {
    const pieces = Math.max(1, Math.round(segment.height / expectedHeight));
    for (let piece = 0; piece < pieces; piece += 1) {
      const pieceTop = segment.top + (segment.height * piece) / pieces;
      const pieceHeight = segment.height / pieces;
      const canvas = document.createElement("canvas");
      canvas.width = tileWidth;
      canvas.height = Math.round(pieceHeight);
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.drawImage(bitmap, segment.column * tileWidth, pieceTop, tileWidth, pieceHeight, 0, 0, tileWidth, Math.round(pieceHeight));
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (blob) output.push(new File([blob], `grid-${output.length + 1}.jpg`, { type: "image/jpeg" }));
    }
  }
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
  const [username, setUsername] = useState("");
  const [drafts, setDrafts] = useState<Post[]>([]);
  const [message, setMessage] = useState("");
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [draggedPostId, setDraggedPostId] = useState<string | null>(null);
  const [dragOverPostId, setDragOverPostId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [activeTip, setActiveTip] = useState(0);
  const [editorFiles, setEditorFiles] = useState<File[]>([]);
  const [editorIndex, setEditorIndex] = useState(0);
  const [editorZoom, setEditorZoom] = useState(1);
  const [editorOffsetX, setEditorOffsetX] = useState(0);
  const [editorOffsetY, setEditorOffsetY] = useState(0);
  const [editorImageSize, setEditorImageSize] = useState<{ width: number; height: number } | null>(null);
  const [editorPreviewUrl, setEditorPreviewUrl] = useState("");
  const editedFilesRef = useRef<File[]>([]);
  const editorPointers = useRef(new Map<number, { x: number; y: number }>());
  const editorGesture = useRef<{ startX: number; startY: number; baseX: number; baseY: number; distance: number; zoom: number } | null>(null);
  const draftsRef = useRef<Post[]>([]);
  const tipStartX = useRef<number | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const draggedTile = useRef<HTMLButtonElement | null>(null);
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
    const timer = window.setInterval(() => setActiveTip((current) => (current + 1) % INSTALL_TIPS.length), 5000);
    return () => window.clearInterval(timer);
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

  function openPhotoEditor(files: File[]) {
    editedFilesRef.current = [];
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
      editorGesture.current = { startX: 0, startY: 0, baseX: editorOffsetX, baseY: editorOffsetY, distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), zoom: editorZoom };
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
      const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      setEditorZoom(Math.max(1, Math.min(2.5, editorGesture.current.zoom * distance / editorGesture.current.distance)));
    }
  }

  function editorPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    editorPointers.current.delete(event.pointerId);
    editorGesture.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Pointer capture is already released. */ }
  }

  function editorWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    setEditorZoom((zoom) => Math.max(1, Math.min(2.5, zoom - event.deltaY * 0.002)));
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

  async function chooseGridScreenshot(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!username.trim()) {
      setMessage("Instagram 아이디를 입력해 주세요.");
      return;
    }
    try {
      const selected = await splitGridScreenshot(file);
      if (!selected.length) {
        setMessage("그리드 캡처를 읽지 못했어요. 다시 선택해 주세요.");
        return;
      }
      openPhotoEditor(selected);
    } catch {
      setMessage("그리드 캡처를 읽지 못했어요. 다시 선택해 주세요.");
    }
  }

  async function pasteGridScreenshot(event: ClipboardEvent<HTMLElement>) {
    const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    if (!username.trim()) {
      setMessage("Instagram 아이디를 입력해 주세요.");
      return;
    }
    const selected = await splitGridScreenshot(file).catch(() => []);
    if (!selected.length) {
      setMessage("그리드 캡처를 읽지 못했어요. 다시 붙여넣어 주세요.");
      return;
    }
    openPhotoEditor(selected);
  }

  function startTilePress(event: React.PointerEvent<HTMLButtonElement>, postId: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    const tile = event.currentTarget;
    const pointerId = event.pointerId;
    longPressTimer.current = window.setTimeout(() => {
      setDraggedPostId(postId);
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
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    draftsRef.current = next;
    setDrafts(next);
    persistDraftOrder(next);
  }

  function moveTile(event: React.PointerEvent<HTMLElement>) {
    if (!draggedPostId) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-post-id]")?.dataset.postId;
    setDragOverPostId(target || null);
    if (target && target !== draggedPostId && target !== dragOverPostId) reorderPosts(draggedPostId, target);
  }

  function finishTilePress(event: React.PointerEvent<HTMLElement>) {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    if (!draggedPostId) {
      draggedTile.current = null;
      return;
    }
    const target = dragOverPostId || document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-post-id]")?.dataset.postId;
    if (target && target !== draggedPostId) reorderPosts(draggedPostId, target);
    try { draggedTile.current?.releasePointerCapture(event.pointerId); } catch { /* Pointer capture is already released. */ }
    draggedTile.current = null;
    setDraggedPostId(null);
    setDragOverPostId(null);
    window.setTimeout(() => { suppressTileClick.current = false; }, 0);
  }

  function cancelTilePress() {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    draggedTile.current = null;
    setDraggedPostId(null);
    setDragOverPostId(null);
    suppressTileClick.current = false;
  }

  function openPost(post: Post) {
    if (suppressTileClick.current) return;
    setSelectedPost(post);
  }

  function removePost(postId: string) {
    const nextPosts = drafts.filter((post) => post.id !== postId);
    setDrafts(nextPosts);
    if (postId.startsWith("draft-")) void deleteDraftPhoto(postId).catch(() => undefined);
    setSelectedPost(null);
    persistDrafts(nextPosts);
  }

  function moveTip(direction: number) {
    setActiveTip((current) => (current + direction + INSTALL_TIPS.length) % INSTALL_TIPS.length);
  }

  function startTipSwipe(event: TouchEvent<HTMLDivElement>) {
    tipStartX.current = event.touches[0]?.clientX ?? null;
  }

  function endTipSwipe(event: TouchEvent<HTMLDivElement>) {
    if (tipStartX.current === null) return;
    const distance = (event.changedTouches[0]?.clientX ?? tipStartX.current) - tipStartX.current;
    tipStartX.current = null;
    if (Math.abs(distance) < 40) return;
    moveTip(distance < 0 ? 1 : -1);
  }

  if (!hydrated) {
    return <main className="splash-page" aria-label="MyGrid 불러오는 중" aria-busy="true">
      <div className="splash-logo"><GridMark /></div>
      <strong>mygrid</strong>
    </main>;
  }

  if (!preview) {
    return <main className="connect-page">
      <header className="brand-row"><div className="brand"><div className="logo"><GridMark /></div><strong>mygrid</strong></div><small className="brand-note">GRID PLANNER</small></header>
      <section className="connect-content">
        <p className="hero-kicker">INSTAGRAM GRID ORGANIZER</p>
        <h1>내 피드를<br /><span>깔끔하게 정리해보세요.</span></h1>
        <p className="lead">프로필 캡처 한 장이면<br />나만의 그리드를 미리 볼 수 있어요.</p>
        <section className="connect-card upload-card" onPaste={pasteGridScreenshot} tabIndex={0}>
          <div className="card-heading"><small>01 / START</small><h2>프로필을 불러올까요?</h2></div>
          <div className="identity-fields">
            <label><span>Instagram 아이디 <em>선택 입력</em></span><div className="handle-input"><b>@</b><input value={username} onChange={(event) => updateUsername(event.target.value)} placeholder="프로필에 표시할 이름" autoCapitalize="none" autoCorrect="off" /></div></label>
          </div>
          {message && <div className="error" role="alert">{message}</div>}
          <label className="upload-option upload-option-featured"><span className="upload-option-mark"><GridMark uniform /></span><span className="upload-option-copy"><b>인스타 프로필 캡처</b><small>한 장 올리면 자동으로 나눠요.</small></span><span className="upload-option-arrow">↑</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseGridScreenshot} /></label>
          <button className="primary start-button" type="button" onClick={startEmptyProfile}><b>빈 피드로 바로 시작</b><span>→</span></button>
        </section>
        <section className="install-tip" aria-label="홈 화면에 추가하는 방법">
          <div className="tip-heading"><div><small>TIP</small><h2>앱으로 더 편하게</h2><p>마이그리드를 홈 화면에 추가해 보세요.</p></div><b>{String(activeTip + 1).padStart(2, "0")} / {String(INSTALL_TIPS.length).padStart(2, "0")}</b></div>
          <div className="tip-slider" onTouchStart={startTipSwipe} onTouchEnd={endTipSwipe}>
            {(() => { const tip = INSTALL_TIPS[activeTip]; return <article className={`tip-slide tip-${tip.kind}`} key={tip.kind}>
              <div className="tip-copy"><small>{tip.platform}</small><strong>{tip.title}</strong><p>{tip.description}</p></div>
              <div className="tip-visual" aria-hidden="true">
                <div className="tip-device-bar"><i /> <span>{tip.kind === "ios" ? "Safari" : tip.kind === "android" ? "Chrome" : "mygrid"}</span><i /></div>
                {tip.kind === "ios" && <><div className="tip-screen-lines"><i /><i /><i /></div><div className="tip-share">↑</div></>}
                {tip.kind === "android" && <><div className="tip-screen-lines"><i /><i /><i /></div><div className="tip-menu-item"><span>＋</span> 홈 화면에 추가</div></>}
                {tip.kind === "done" && <div className="tip-app-icon"><GridMark /><small>mygrid</small></div>}
              </div>
            </article>; })()}
          </div>
          <div className="tip-footer"><div className="tip-dots">{INSTALL_TIPS.map((tip, index) => <button key={tip.kind} type="button" className={index === activeTip ? "active" : ""} aria-label={`${index + 1}단계 보기`} aria-current={index === activeTip} onClick={() => setActiveTip(index)} />)}</div><span>좌우로 넘겨보기</span></div>
        </section>
      </section>
    </main>;
  }

  return <>
    <main className="preview-page">
    <header className="profile-bar"><label className="profile-add-button" aria-label="다음 사진 추가">＋<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={choosePhotos} /></label><strong>@{username || "mygrid"}</strong><span aria-hidden="true" /></header>
    <section className="profile-scroll" onPointerMove={moveTile} onPointerUp={finishTilePress} onPointerCancel={cancelTilePress}>
      <div className="profile-summary"><div className="avatar" /><div className="stat"><b>{allPosts.length}</b><small>게시물</small></div><div className="stat"><b>—</b><small>팔로워</small></div><div className="stat"><b>—</b><small>팔로잉</small></div></div>
      <h2 className="profile-name">{username || "mygrid"}</h2>
      <div className="profile-tabs"><div className="profile-tab selected"><GridMark uniform /></div></div>
      {allPosts.length ? <div className="grid">{Array.from({ length: Math.ceil(allPosts.length / 3) }, (_, row) => <div className="grid-row" key={row}>{[0, 1, 2].map((column) => { const post = allPosts[row * 3 + column]; return post ? <button className={`tile${draggedPostId === post.id ? " is-dragging" : ""}${dragOverPostId === post.id ? " drop-target" : ""}`} type="button" key={post.id} data-post-id={post.id} onPointerDown={(event) => startTilePress(event, post.id)} onContextMenu={(event) => event.preventDefault()} onDragStart={(event) => event.preventDefault()} onSelect={(event) => event.preventDefault()} onClick={() => openPost(post)} aria-label="길게 눌러 게시물 이동"><img src={mediaUrl(post.image)} alt="게시물" /></button> : <div className="tile placeholder" key={`empty-${row}-${column}`} />; })}</div>)}</div> : <div className="empty"><b>피드가 기다리고 있어요</b><small>사진을 추가해 나만의 그리드를 만들어 보세요.</small></div>}
    </section>
    </main>
    {selectedPost && <div className="image-viewer" role="dialog" aria-modal="true" aria-label="Instagram 게시물 보기" onClick={() => setSelectedPost(null)}>
      <div className="viewer-content" onClick={(event) => event.stopPropagation()}>
        <button className="viewer-close" type="button" onClick={() => setSelectedPost(null)} aria-label="닫기" title="닫기"><CloseIcon /></button>
        <img className="viewer-image" src={mediaUrl(selectedPost.image)} alt="Instagram 게시물 크게 보기" />
        <button className="viewer-delete" type="button" onClick={() => removePost(selectedPost.id)} aria-label="게시물 삭제" title="게시물 삭제"><TrashIcon /></button>
      </div>
    </div>}
    {editorFiles.length > 0 && editorPreviewUrl && <div className="photo-editor" role="dialog" aria-modal="true" aria-label="사진 편집"><div className="editor-panel"><div className="editor-heading"><button className="editor-close" type="button" aria-label="편집 취소" onClick={() => setEditorFiles([])}>×</button><span>{editorIndex + 1} / {editorFiles.length}</span></div><div className="crop-stage crop-portrait" onPointerDown={editorPointerDown} onPointerMove={editorPointerMove} onPointerUp={editorPointerUp} onPointerCancel={editorPointerUp} onWheel={editorWheel}><img src={editorPreviewUrl} alt="편집할 사진" onLoad={(event) => setEditorImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} style={{ objectFit: editorImageSize && editorImageSize.width <= editorImageSize.height ? "cover" : "contain", transform: `translate(${editorOffsetX * 100}%, ${editorOffsetY * 100}%) scale(${editorZoom})` }} /><div className="crop-grid" aria-hidden="true"><i /><i /><i /><i /></div></div><button className="editor-confirm" type="button" onClick={() => void confirmCrop()}>{editorIndex + 1 < editorFiles.length ? "다음 →" : "→"}</button></div></div>}
  </>;
}
