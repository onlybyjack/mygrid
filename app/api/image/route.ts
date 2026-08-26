import { NextResponse } from "next/server";

export const runtime = "nodejs";

function isAllowedImageHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host.endsWith(".cdninstagram.com") || host.endsWith(".fbcdn.net") || host === "instagram.com" || host === "www.instagram.com";
}

export async function GET(request: Request) {
  const rawUrl = new URL(request.url).searchParams.get("url");
  if (!rawUrl) return NextResponse.json({ error: "이미지 주소가 없습니다." }, { status: 400 });

  let imageUrl: URL;
  try {
    imageUrl = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "올바르지 않은 이미지 주소입니다." }, { status: 400 });
  }
  if (imageUrl.protocol !== "https:" || !isAllowedImageHost(imageUrl.hostname)) {
    return NextResponse.json({ error: "허용되지 않은 이미지 주소입니다." }, { status: 400 });
  }

  try {
    const response = await fetch(imageUrl, {
      cache: "no-store",
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (compatible; MyGrid/1.0)",
        Referer: "https://www.instagram.com/",
      },
    });
    if (!response.ok) return NextResponse.json({ error: "Instagram 이미지를 가져오지 못했습니다." }, { status: response.status });

    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) return NextResponse.json({ error: "이미지 응답이 아닙니다." }, { status: 502 });
    return new NextResponse(await response.arrayBuffer(), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "Instagram 이미지를 가져오지 못했습니다." }, { status: 502 });
  }
}
