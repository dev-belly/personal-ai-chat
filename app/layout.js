export const metadata = {
  title: "Personal AI Chat",
  description: "无需密钥体验本地模拟，或连接你自己的私人 AI 服务。",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
