"use client";

import { ChangeEvent, ClipboardEvent, TouchEvent, useEffect, useRef, useState } from "react";
import { deleteDraftPhoto, readDraftPhotos, saveDraftPhotos } from "../../lib/instagram-export";
import GridMark from "../components/grid-mark";

type Post = { id: string; image: string; draft?: boolean };

const INSTALL_TIPS = [
  { kind: "ios", platform: "iPhone · Safari", title: "공유 버튼을 눌러보세요", description: "Safari 하단의 공유 아이콘을 선택하세요." },
  { kind: "android", platform: "Android · Chrome", title: "홈 화면에 추가를 선택하세요", description: "메뉴에서 ‘홈 화면에 추가’를 누르면 끝이에요." },
  { kind: "done", platform: "mygrid 앱", title: "이제 앱처럼 열어보세요", description: "홈 화면의 mygrid 아이콘에서 바로 시작할 수 있어요." },
] as const;

function mediaUrl(url: string) {
  if (url.startsWith("/") || url.startsWith("blob:") || url.startsWith("data:")) return url;
  return `/api/image?url=${encodeURIComponent(url)}`;
}

async function splitGridScreenshot(file: File): Promise<File[]> {
  const bitmap = await createImageBitmap(file);
  const width = bitmap.width;
  const height = bitmap.height;
  const margin = Math.round(width * 0.025);
  const tileWidth = Math.floor((width - margin * 2) / 3);
  const tileHeight = Math.round(tileWidth * 1.3333);
  const output: File[] = [];
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const sourceContext = source.getContext("2d");
  const canvas = document.createElement("canvas");
  canvas.width = tileWidth;
  canvas.height = tileHeight;
  const context = canvas.getContext("2d");
  if (!sourceContext || !context || tileWidth < 40) {
    bitmap.close();
    return [];
  }
  sourceContext.drawImage(bitmap, 0, 0);
  const sourcePixels = sourceContext.getImageData(0, 0, width, height).data;
  const rowVariance = (row: number) => {
    let total = 0;
    let squared = 0;
    let samples = 0;
    for (let x = margin; x < width - margin; x += 8) {
      const index = (row * width + x) * 4;
      const luminance = sourcePixels[index] * 0.299 + sourcePixels[index + 1] * 0.587 + sourcePixels[index + 2] * 0.114;
      total += luminance;
      squared += luminance * luminance;
      samples += 1;
    }
    const average = total / samples;
    return squared / samples - average * average;
  };
  const findActiveEdge = (start: number, step: number) => {
    let streak = 0;
    let edge = start;
    for (let row = start; row >= 0 && row < height; row += step) {
      if (rowVariance(row) > 180) {
        if (!streak) edge = row;
        streak += 1;
        if (streak >= 8) return edge;
      } else streak = 0;
    }
    return step > 0 ? Math.round(height * 0.08) : height;
  };
  const top = findActiveEdge(0, 1);
  const bottom = findActiveEdge(height - 1, -1);
  const rows = Math.floor((bottom - top) / tileHeight);
  if (rows < 1) {
    bitmap.close();
    return [];
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      context.clearRect(0, 0, tileWidth, tileHeight);
      context.drawImage(bitmap, margin + column * tileWidth, top + row * tileHeight, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight);
      const pixels = context.getImageData(0, 0, tileWidth, tileHeight).data;
      let visible = 0;
      for (let index = 0; index < pixels.length; index += 16) {
        if (pixels[index] < 242 || pixels[index + 1] < 242 || pixels[index + 2] < 242) visible += 1;
      }
      if (visible / (pixels.length / 16) < 0.08) continue;
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
  const [drafts, setDrafts] = useState<Post[]>([]);
  const [message, setMessage] = useState("");
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [activeTip, setActiveTip] = useState(0);
  const tipStartX = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    void readDraftPhotos().then((savedDrafts) => {
      if (!mounted) return;
      const restored = savedDrafts.map((post) => ({ id: post.id, image: post.image, draft: true }));
      setDrafts(restored);
      if (restored.length) setPreview(true);
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

  function choosePhotos(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!selected.length) {
      setMessage("사진을 한 장 이상 선택해 주세요.");
      event.target.value = "";
      return;
    }
    const nextDrafts = selected.map((file, index) => ({ id: `draft-${Date.now()}-${index}`, image: URL.createObjectURL(file), draft: true }));
    setDrafts(nextDrafts);
    setMessage("");
    setPreview(true);
    void saveDraftPhotos(nextDrafts).catch(() => undefined);
    event.target.value = "";
  }

  async function chooseGridScreenshot(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const selected = await splitGridScreenshot(file);
      if (!selected.length) {
        setMessage("그리드 캡처를 읽지 못했어요. 다시 선택해 주세요.");
        return;
      }
      const nextDrafts = selected.map((image, index) => ({ id: `draft-${Date.now()}-${index}`, image: URL.createObjectURL(image), draft: true }));
      setDrafts(nextDrafts);
      setMessage("");
      setPreview(true);
      void saveDraftPhotos(nextDrafts).catch(() => undefined);
    } catch {
      setMessage("그리드 캡처를 읽지 못했어요. 다시 선택해 주세요.");
    }
  }

  async function pasteGridScreenshot(event: ClipboardEvent<HTMLElement>) {
    const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    const selected = await splitGridScreenshot(file).catch(() => []);
    if (!selected.length) {
      setMessage("그리드 캡처를 읽지 못했어요. 다시 붙여넣어 주세요.");
      return;
    }
    const nextDrafts = selected.map((image, index) => ({ id: `draft-${Date.now()}-${index}`, image: URL.createObjectURL(image), draft: true }));
    setDrafts(nextDrafts);
    setMessage("");
    setPreview(true);
    void saveDraftPhotos(nextDrafts).catch(() => undefined);
  }

  function removePost(postId: string) {
    const nextPosts = drafts.filter((post) => post.id !== postId);
    setDrafts(nextPosts);
    if (postId.startsWith("draft-")) void deleteDraftPhoto(postId).catch(() => undefined);
    setSelectedPost(null);
    void saveDraftPhotos(nextPosts).catch(() => undefined);
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
      <header className="brand-row"><div className="brand"><div className="logo"><GridMark /></div><strong>mygrid</strong></div></header>
      <section className="connect-content">
        <h1>사진을 골라<br />그리드로 채워보세요.</h1>
        <p className="lead">첫 장 이미지만 골라 한 번에 올리면 충분해요.</p>
        <section className="connect-card upload-card" onPaste={pasteGridScreenshot} tabIndex={0}>
          <h2>처음 한 번만 올려주세요</h2>
          <p>사진을 고르거나, 그리드 캡처를 붙여넣어도 돼요.</p>
          <div className="upload-note"><span>이 기기에 저장돼요</span><button type="button" aria-label="사진 저장 안내" aria-describedby="upload-note-detail">?</button><span id="upload-note-detail" role="tooltip">다음에 다시 열어도 그대로 남아 있어요.</span></div>
          {message && <div className="error" role="alert">{message}</div>}
          <label className="primary upload-submit"><b>사진 여러 장 고르기</b><span>↑</span><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={choosePhotos} /></label>
          <label className="upload-secondary"><b>그리드 캡처 한 장</b><span>자동으로 나눠요</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseGridScreenshot} /></label>
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
    <header className="profile-bar"><button type="button" aria-label="뒤로 가기" onClick={() => setPreview(false)}>‹</button><strong>내 피드</strong></header>
    <section className="profile-scroll">
      <div className="profile-summary"><div className="avatar"><GridMark /></div><div className="stat"><b>{allPosts.length}</b><small>게시물</small></div><div className="stat"><b>—</b><small>팔로워</small></div><div className="stat"><b>—</b><small>팔로잉</small></div></div>
      <h2 className="profile-name">mygrid</h2>
      <div className="profile-tabs"><span className="selected">▦</span></div>
      {allPosts.length ? <div className="grid">{Array.from({ length: Math.ceil(allPosts.length / 3) }, (_, row) => <div className="grid-row" key={row}>{[0, 1, 2].map((column) => { const post = allPosts[row * 3 + column]; return post ? <button className="tile" type="button" key={post.id} onClick={() => setSelectedPost(post)} aria-label="게시물 크게 보기"><img src={mediaUrl(post.image)} alt="게시물" /></button> : <div className="tile placeholder" key={`empty-${row}-${column}`} />; })}</div>)}</div> : <div className="empty"><b>피드가 기다리고 있어요</b><small>사진을 추가해 나만의 그리드를 만들어 보세요.</small></div>}
    </section>
    <footer className="add-bar"><label className="add-button" aria-label="다음 사진 추가">＋<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={choosePhotos} /></label></footer>
    </main>
    {selectedPost && <div className="image-viewer" role="dialog" aria-modal="true" aria-label="Instagram 게시물 보기" onClick={() => setSelectedPost(null)}>
      <div className="viewer-content" onClick={(event) => event.stopPropagation()}>
        <button className="viewer-close" type="button" onClick={() => setSelectedPost(null)} aria-label="닫기" title="닫기"><CloseIcon /></button>
        <img className="viewer-image" src={mediaUrl(selectedPost.image)} alt="Instagram 게시물 크게 보기" />
        <button className="viewer-delete" type="button" onClick={() => removePost(selectedPost.id)} aria-label="게시물 삭제" title="게시물 삭제"><TrashIcon /></button>
      </div>
    </div>}
  </>;
}
