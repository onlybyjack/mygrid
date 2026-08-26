"use client";

import { useEffect } from "react";

export default function Page() {
  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    const timer = window.setTimeout(() => window.location.replace("/home"), 500);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="splash-page" aria-label="MyGrid 시작">
      <div className="splash-logo">M</div>
      <strong>mygrid</strong>
    </main>
  );
}
