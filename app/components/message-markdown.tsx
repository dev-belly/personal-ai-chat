'use client';

import { Streamdown } from 'streamdown';
import type { Components, UrlTransform } from 'streamdown';
import { createCodePlugin } from '@streamdown/code';

const code = createCodePlugin({ themes: ['github-dark', 'github-dark'] });
const safeUrl: UrlTransform = (url, key) => {
  if (key !== 'href') return undefined;
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(url, 'https://local.invalid').protocol)
      ? url : undefined;
  } catch { return undefined; }
};
const components: Components = {
  a: ({ href, title, children }) => href
    ? <a href={href} title={title} target="_blank" rel="noreferrer noopener">{children}</a>
    : <span>{children}</span>,
  img: ({ alt }) => <span className="markdown-image-note">[图片：{alt || '未自动加载'}]</span>,
};

export default function MessageMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const marker = '【本地模拟 · 固定示例】';
  const demo = content.startsWith(marker);
  return <>
    {demo && <p className="demo-marker">{marker}</p>}
    <Streamdown className="assistant-markdown" plugins={{ code }} components={components}
      urlTransform={safeUrl} isAnimating={streaming} mode={streaming ? 'streaming' : 'static'}
      controls={{ code: { copy: true, download: false }, table: false, image: false }}
      translations={{ copyCode: '复制代码', copied: '已复制' }}
      shikiTheme={['github-dark', 'github-dark']}>
      {demo ? content.slice(marker.length).trimStart() : content}
    </Streamdown>
  </>;
}
