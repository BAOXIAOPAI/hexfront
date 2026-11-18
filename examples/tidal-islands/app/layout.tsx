import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "CATAN · 潮汐群岛", description: "在潮汐之间，建立你的岛屿。经典卡坦规则、邀请码联机与沉浸式桌游。", icons: { icon: "/favicon.svg" } };
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>){return <html lang="zh-CN"><body>{children}</body></html>;}
