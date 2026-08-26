"use client";

import { ChangeEvent, FormEvent, TouchEvent, useEffect, useMemo, useRef, useState } from "react";
import { deleteDraftPhoto, readDraftPhotos, saveDraftPhotos } from "../../lib/instagram-export";

type Post = { id: string; image: string; draft?: boolean };
type Profile = { fullName?: string; avatar?: string; followers?: number; following?: number };
type SavedProfile = { username: string; posts: Post[]; profile: Profile; partial?: boolean };

const INSTALL_TIPS = [
  { kind: "ios", platform: "iPhone · Safari", title: "공유 버튼을 눌러보세요", description: "Safari 하단의 공유 아이콘을 선택하세요." },
  { kind: "android", platform: "Android · Chrome", title: "홈 화면에 추가를 선택하세요", description: "메뉴에서 ‘홈 화면에 추가’를 누르면 끝이에요." },
  { kind: "done", platform: "mygrid 앱", title: "이제 앱처럼 열어보세요", description: "홈 화면의 mygrid 아이콘에서 바로 시작할 수 있어요." },
] as const;

const PROFILE_KEY = "mygrid:web-profile";

function normalizePosts(value: unknown): Post[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((post, index) => {
    if (!post || typeof post !== "object" || typeof (post as Post).image !== "string") return [];
    const record = post as Post;
    return [{ id: typeof record.id === "string" && record.id ? record.id : `post-${index}`, image: record.image, draft: record.draft === true }];
  });
}

function normalizeProfile(value: unknown): Profile {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    fullName: typeof record.fullName === "string" ? record.fullName : undefined,
    avatar: typeof record.avatar === "string" ? record.avatar : undefined,
    followers: typeof record.followers === "number" ? record.followers : undefined,
    following: typeof record.following === "number" ? record.following : undefined,
  };
}

function normalizeUsername(value: string) {
  const input = value.trim().replace(/^@/, "");
  if (!input.includes("instagram.com")) return input.replace(/\/$/, "");
  try {
    const url = new URL(input.startsWith("http") ? input : `https://${input}`);
    if (!["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase())) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 1 ? parts[0] : "";
  } catch {
    return "";
  }
}

function mediaUrl(url: string) {
  if (url.startsWith("/") || url.startsWith("blob:") || url.startsWith("data:")) return url;
  return `/api/image?url=${encodeURIComponent(url)}`;
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
  const [posts, setPosts] = useState<Post[]>([]);
  const [drafts, setDrafts] = useState<Post[]>([]);
  const [profile, setProfile] = useState<Profile>({});
  const [partial, setPartial] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [activeTip, setActiveTip] = useState(0);
  const tipStartX = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SavedProfile>;
        if (typeof parsed.username === "string" && /^[a-zA-Z0-9._]{1,30}$/.test(parsed.username)) {
          setUsername(parsed.username);
          setPosts(normalizePosts(parsed.posts));
          setProfile(normalizeProfile(parsed.profile));
          setPartial(parsed.partial === true);
          setPreview(true);
        }
      }
    } catch {
      localStorage.removeItem(PROFILE_KEY);
    }
    void readDraftPhotos().then((savedDrafts) => {
      if (mounted) setDrafts(savedDrafts.map((post) => ({ id: post.id, image: post.image, draft: true })));
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

  const allPosts = useMemo(() => [...drafts, ...posts], [drafts, posts]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeUsername(username);
    if (!normalized) {
      setMessage("Instagram 아이디를 입력해 주세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(`/api/profile?username=${encodeURIComponent(normalized)}`);
      const result = await response.json() as { username?: string; posts?: Post[]; profile?: Profile; partial?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error || "Instagram 프로필을 불러오지 못했습니다.");
      setUsername(result.username || normalized);
      setPosts(normalizePosts(result.posts));
      setProfile(normalizeProfile(result.profile));
      setPartial(result.partial === true);
      try {
        localStorage.setItem(PROFILE_KEY, JSON.stringify({
          username: result.username || normalized,
          posts: normalizePosts(result.posts),
          profile: normalizeProfile(result.profile),
          partial: result.partial === true,
        } satisfies SavedProfile));
      } catch {
        // Keep the fetched profile available for this session when storage is unavailable.
      }
      setPreview(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "프로필 동기화에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  function choosePhotos(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/")).slice(0, 10);
    const nextDrafts = selected.map((file, index) => ({ id: `draft-${Date.now()}-${index}`, image: URL.createObjectURL(file), draft: true }));
    setDrafts(nextDrafts);
    void saveDraftPhotos(nextDrafts).catch(() => undefined);
    event.target.value = "";
  }

  function removePost(postId: string) {
    const nextPosts = posts.filter((post) => post.id !== postId);
    setPosts(nextPosts);
    setDrafts((current) => current.filter((post) => post.id !== postId));
    if (postId.startsWith("draft-")) void deleteDraftPhoto(postId).catch(() => undefined);
    setSelectedPost(null);
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<SavedProfile>;
      if (typeof saved.username !== "string") return;
      localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...saved, posts: nextPosts }));
    } catch {
      // The visible feed is still updated when storage is unavailable.
    }
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
      <div className="splash-logo">M</div>
      <strong>mygrid</strong>
    </main>;
  }

  if (!preview) {
    return <main className="connect-page">
      <header className="brand-row"><div className="brand"><div className="logo">M</div><strong>mygrid</strong></div></header>
      <section className="connect-content">
        <h1>내 피드를<br />1초 만에 가져오세요.</h1>
        <p className="lead">Instagram 아이디만 입력하면, 나만의 피드가 시작돼요.<br />이제 마이그리드에서 감성 있게 피드를 꾸며보세요.</p>
        <form className="connect-card" onSubmit={connect}>
          <h2>Instagram 프로필 불러오기</h2>
          <div className="input-row"><span>@</span><input id="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="아이디 입력" autoCapitalize="none" autoCorrect="off" /></div>
          {message && <div className="error" role="alert">{message}</div>}
          <button className="primary" type="submit" disabled={loading}><b>{loading ? "피드 불러오는 중…" : "피드 가져오기"}</b><span>↑</span></button>
        </form>
        <section className="install-tip" aria-label="홈 화면에 추가하는 방법">
          <div className="tip-heading"><div><small>TIP</small><h2>앱처럼 더 편하게</h2><p>마이그리드를 홈 화면에 추가해 보세요.</p></div><b>{String(activeTip + 1).padStart(2, "0")} / {String(INSTALL_TIPS.length).padStart(2, "0")}</b></div>
          <div className="tip-slider" onTouchStart={startTipSwipe} onTouchEnd={endTipSwipe}>
            {(() => { const tip = INSTALL_TIPS[activeTip]; return <article className={`tip-slide tip-${tip.kind}`} key={tip.kind}>
              <div className="tip-copy"><small>{tip.platform}</small><strong>{tip.title}</strong><p>{tip.description}</p></div>
              <div className="tip-visual" aria-hidden="true">
                <div className="tip-device-bar"><i /> <span>{tip.kind === "ios" ? "Safari" : tip.kind === "android" ? "Chrome" : "mygrid"}</span><i /></div>
                {tip.kind === "ios" && <><div className="tip-screen-lines"><i /><i /><i /></div><div className="tip-share">↑</div></>}
                {tip.kind === "android" && <><div className="tip-screen-lines"><i /><i /><i /></div><div className="tip-menu-item"><span>＋</span> 홈 화면에 추가</div></>}
                {tip.kind === "done" && <div className="tip-app-icon">M<small>mygrid</small></div>}
              </div>
            </article>; })()}
          </div>
          <div className="tip-footer"><div className="tip-dots">{INSTALL_TIPS.map((tip, index) => <button key={tip.kind} type="button" className={index === activeTip ? "active" : ""} aria-label={`${index + 1}단계 보기`} aria-current={index === activeTip} onClick={() => setActiveTip(index)} />)}</div><span>좌우로 넘겨보기</span></div>
        </section>
      </section>
    </main>;
  }

  const displayName = profile.fullName?.trim() || username;
  return <>
    <main className="preview-page">
    <header className="profile-bar"><button type="button" aria-label="뒤로 가기" onClick={() => setPreview(false)}>‹</button><strong>@{username}</strong></header>
    <section className="profile-scroll">
      <div className="profile-summary"><div className="avatar">{profile.avatar ? <img src={mediaUrl(profile.avatar)} alt="" /> : <span>●</span>}</div><div className="stat"><b>{allPosts.length}</b><small>게시물</small></div><div className="stat"><b>{profile.followers ?? "—"}</b><small>팔로워</small></div><div className="stat"><b>{profile.following ?? "—"}</b><small>팔로잉</small></div></div>
      <h2 className="profile-name">{displayName}</h2>
      <div className="profile-tabs"><span className="selected">▦</span></div>
      {allPosts.length ? <div className="grid">{Array.from({ length: Math.ceil(allPosts.length / 3) }, (_, row) => <div className="grid-row" key={row}>{[0, 1, 2].map((column) => { const post = allPosts[row * 3 + column]; return post ? <button className="tile" type="button" key={post.id} onClick={() => setSelectedPost(post)} aria-label="Instagram 게시물 크게 보기"><img src={mediaUrl(post.image)} alt="Instagram 게시물" /></button> : <div className="tile placeholder" key={`empty-${row}-${column}`} />; })}</div>)}</div> : <div className="empty"><b>피드가 기다리고 있어요</b><small>사진을 추가하거나 공개 프로필을 연결하세요.</small></div>}
      {partial && <p className="sync-note">Instagram 제한으로 일부 게시물만 동기화되었습니다.</p>}
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
