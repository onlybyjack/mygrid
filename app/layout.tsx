import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MyGrid",
  description: "Instagram 피드 미리보기",
  manifest: "/manifest.json",
  icons: { apple: "/mygrid-icon.svg" },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "MyGrid" },
};

export const viewport: Viewport = {
  themeColor: "#EFEFEC",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
