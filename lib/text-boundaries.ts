// JavaScript strings use UTF-16. Never encode or render an unpaired surrogate.
export function isWellFormedText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export class UnicodeTextBuffer {
  private pending = '';
  push(fragment: string): string {
    const text = this.pending + fragment;
    const last = text.charCodeAt(text.length - 1);
    const hasTail = last >= 0xd800 && last <= 0xdbff;
    const complete = hasTail ? text.slice(0, -1) : text;
    if (!isWellFormedText(complete)) throw new Error('Invalid Unicode text');
    this.pending = hasTail ? text.slice(-1) : '';
    return complete;
  }
  finish(): void {
    if (this.pending) throw new Error('Incomplete Unicode text');
  }
}

export function conversationTitle(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  let title = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(compact)) {
    if (title.length + segment.length > 80) break;
    title += segment;
  }
  return title || '未命名会话';
}
