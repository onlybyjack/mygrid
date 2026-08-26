import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const INSTAGRAM_APP_ID = "936619743392459";
const USERNAME_PATTERN = /^[a-zA-Z0-9._]{1,30}$/;

type InstagramUser = {
  username?: unknown;
  is_private?: unknown;
  full_name?: unknown;
  profile_pic_url?: unknown;
  follower_count?: unknown;
  following_count?: unknown;
  edge_followed_by?: { count?: unknown };
  edge_follow?: { count?: unknown };
  edge_owner_to_timeline_media?: {
    page_info?: { has_next_page?: unknown };
    edges?: Array<{ node?: InstagramMedia }>;
  };
  polaris_ordered_timeline_connection?: {
    edges?: Array<{ node?: InstagramMedia }>;
  };
  all_media_count?: unknown;
};

type InstagramMedia = {
  id?: unknown;
  pk?: unknown;
  shortcode?: unknown;
  display_url?: unknown;
  display_uri?: unknown;
  thumbnail_src?: unknown;
  is_video?: unknown;
};

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function string(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function readUser(payload: unknown): InstagramUser | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const direct = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>).user : undefined;
  if (direct && typeof direct === "object") return direct as InstagramUser;
  if (root.user && typeof root.user === "object") return root.user as InstagramUser;
  return null;
}

function parseHtmlProfile(html: string, username: string) {
  const users: InstagramUser[] = [];
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const collectUsers = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collectUsers); return; }
    const record = value as Record<string, unknown>;
    const user = record.xig_user_by_username;
    if (user && typeof user === "object") users.push(user as InstagramUser);
    Object.values(record).forEach(collectUsers);
  };
  let match: RegExpExecArray | null;
  while ((match = scripts.exec(html))) {
    if (!/\btype\s*=\s*["']application\/json["']/i.test(match[1])) continue;
    try { collectUsers(JSON.parse(match[2])); } catch { /* Ignore unrelated page state. */ }
  }
  const matching = users.filter((user) => string(user.username)?.toLowerCase() === username.toLowerCase());
  if (!matching.length) return { user: null, found: false };
  const profile = matching.find((user) => user.polaris_ordered_timeline_connection === undefined) || matching[0];
  const timeline = matching.find((user) => user.polaris_ordered_timeline_connection);
  return { user: timeline ? { ...profile, ...timeline } : profile, found: true };
}

async function readHtmlProfile(username: string) {
  const response = await fetch(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
    cache: "no-store",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
  });
  if (!response.ok) return { user: null, found: false };
  return parseHtmlProfile(await response.text(), username);
}

async function readScraperApiProfile(username: string) {
  const key = process.env.SCRAPER_API_KEY?.trim();
  if (!key) return { user: null, found: false };
  const target = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  const params = new URLSearchParams({ api_key: key, url: target, render: "true", premium: "true", country_code: "kr", device_type: "mobile" });
  const response = await fetch(`https://api.scraperapi.com/?${params}`, { cache: "no-store" });
  if (!response.ok) {
    console.error(`ScraperAPI request failed with status ${response.status}`);
    return { user: null, found: false };
  }
  const result = parseHtmlProfile(await response.text(), username);
  if (!result.user) console.error("ScraperAPI returned no Instagram profile payload");
  return result;
}

export async function GET(request: Request) {
  const username = new URL(request.url).searchParams.get("username")?.trim().replace(/^@/, "") || "";
  if (!USERNAME_PATTERN.test(username)) {
    return NextResponse.json({ error: "올바른 Instagram 사용자 아이디를 입력하세요." }, { status: 400 });
  }

  try {
    let user: InstagramUser | null = null;
    try {
      const scraper = await readScraperApiProfile(username);
      user = scraper.user;
    } catch {
      // A provider outage must not prevent the direct fallbacks below.
    }
    for (const host of ["www.instagram.com", "i.instagram.com"]) {
      if (user) break;
      try {
        const response = await fetch(
          `https://${host}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
          {
            cache: "no-store",
            headers: {
              Accept: "application/json",
              "Accept-Language": "en-US,en;q=0.9",
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36",
              "X-IG-App-ID": INSTAGRAM_APP_ID,
              "X-ASBD-ID": "198387",
              "X-Requested-With": "XMLHttpRequest",
              Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
              Origin: "https://www.instagram.com",
              "Sec-Fetch-Dest": "empty",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-origin",
            },
          },
        );
        if (!response.ok) continue;
        try { user = readUser(await response.json()); } catch { /* Try the next Instagram host. */ }
        if (user) break;
      } catch { /* Try the next Instagram host. */ }
    }
    let htmlFound = false;
    if (!user) {
      const fallback = await readHtmlProfile(username);
      user = fallback.user;
      htmlFound = fallback.found;
    }
    if (!user) return NextResponse.json({ error: htmlFound ? "Instagram 프로필을 찾지 못했습니다." : "Instagram 프로필을 불러오지 못했습니다. 잠시 후 다시 시도하세요." }, { status: htmlFound ? 404 : 502 });
    if (!user || string(user.username)?.toLowerCase() !== username.toLowerCase()) {
      return NextResponse.json({ error: "공개 Instagram 프로필만 가져올 수 있습니다." }, { status: 404 });
    }
    if (user.is_private === true) {
      return NextResponse.json({ error: "비공개 계정은 피드를 가져올 수 없어요. Instagram에서 공개 계정으로 전환한 뒤 다시 시도해 주세요." }, { status: 403 });
    }

    const media = user.edge_owner_to_timeline_media;
    const edges = media?.edges || user.polaris_ordered_timeline_connection?.edges || [];
    const posts = edges.flatMap(({ node }, index) => {
      if (!node) return [];
      const image = string(node.display_url) || string(node.display_uri) || string(node.thumbnail_src);
      if (!image) return [];
      return [{ id: string(node.id) || string(node.pk) || string(node.shortcode) || `post-${index}`, image }];
    });
    const followers = count(user.follower_count) ?? count(user.edge_followed_by?.count);
    const following = count(user.following_count) ?? count(user.edge_follow?.count);

    return NextResponse.json({
      username: string(user.username) || username,
      profile: {
        fullName: string(user.full_name),
        avatar: string(user.profile_pic_url),
        ...(followers === undefined ? {} : { followers }),
        ...(following === undefined ? {} : { following }),
      },
      posts,
      partial: media?.page_info?.has_next_page === true || (count(user.all_media_count) ?? 0) > posts.length,
    });
  } catch {
    return NextResponse.json({ error: "Instagram 프로필을 불러오지 못했습니다. 잠시 후 다시 시도하세요." }, { status: 502 });
  }
}
