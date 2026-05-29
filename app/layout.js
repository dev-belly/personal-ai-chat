export const metadata = {
  title: "AI Chat",
  description: "Chat with Claude",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}