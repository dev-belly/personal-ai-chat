'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ChatMode, DisplayMessage } from '../../lib/chat-contract.ts';
import { ConversationStoreError, exportConversation, getConversationRepository } from '../../lib/local/conversation-store.ts';
import type { ConversationSummary, SavedConversation } from '../../lib/local/conversation-store.ts';

interface HistoryOptions {
  mode: ChatMode;
  messages: DisplayMessage[];
  draft: string;
  restore: (conversation: SavedConversation) => void;
  clear: () => void;
}

function storageIsUnavailable() {
  if (typeof window === 'undefined') return false;
  try { return !window.indexedDB; } catch { return true; }
}

export function useConversationHistory({ mode, messages, draft, restore, clear }: HistoryOptions) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<SavedConversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const inFlight = useRef(false);
  // Dexie liveQuery deliberately does not run its querier without IndexedDB.
  const storageUnavailable = storageIsUnavailable();
  const result = useLiveQuery(async () => {
    if (storageUnavailable) return { items: [] as ConversationSummary[], unavailable: true };
    if (!open) return { items: [] as ConversationSummary[], unavailable: false };
    try { return { items: await getConversationRepository().list(search), unavailable: false }; }
    catch { return { items: [] as ConversationSummary[], unavailable: true }; }
  }, [open, search, storageUnavailable]);

  useEffect(() => { setNotice(''); setError(''); }, [messages]);
  useEffect(() => () => { epoch.current += 1; }, []);

  function hasUnsavedMessages() {
    if (!messages.length) return false;
    if (!selected || selected.mode !== mode || selected.messages.length !== messages.length) return true;

    // The reducer's numeric `request` stays in memory. Compare the persisted fields.
    return selected.messages.some((saved, index) => {
      const current = messages[index];
      return !current || current.role !== saved.role || current.content !== saved.content ||
        current.status !== saved.status || current.retryText !== saved.retryText ||
        current.requestId !== saved.requestId;
    });
  }

  function confirmDiscard() {
    return (!draft && !hasUnsavedMessages()) ||
      window.confirm('当前会话有未保存的内容。继续将丢弃这些内容。');
  }

  function resetSelection() {
    epoch.current += 1;
    inFlight.current = false;
    setBusy(false); setSelected(null); setNotice(''); setError('');
  }
  function begin(): number | undefined {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setNotice(''); setError('');
    return ++epoch.current;
  }
  function finish(operation: number) {
    if (operation === epoch.current) { inFlight.current = false; setBusy(false); }
  }
  function report(operation: number, failure: unknown) {
    if (operation === epoch.current) setError(failure instanceof ConversationStoreError ? failure.message
      : '本机保存暂时不可用，当前文字仍保留，可尝试导出会话。');
  }
  async function save() {
    const operation = begin();
    if (operation === undefined) return;
    try {
      const saved = await getConversationRepository().save({ mode, messages,
        ...(selected ? { id: selected.id, expectedRevision: selected.revision } : {}),
      });
      if (operation !== epoch.current) return;
      setSelected(saved);
      setNotice('已保存到本浏览器；刷新后可从“会话历史”打开。');
    } catch (failure) { report(operation, failure); }
    finally { finish(operation); }
  }
  async function load(id: string) {
    if (!confirmDiscard()) return;
    const operation = begin();
    if (operation === undefined) return;
    try {
      const saved = await getConversationRepository().load(id);
      if (operation !== epoch.current) return;
      restore(saved);
      setSelected(saved);
      setOpen(false);
    } catch (failure) { report(operation, failure); }
    finally { finish(operation); }
  }
  async function remove(row: ConversationSummary) {
    if (selected?.id === row.id && !confirmDiscard()) return;
    const operation = begin();
    if (operation === undefined) return;
    try {
      await getConversationRepository().remove(row.id, row.revision);
      if (operation !== epoch.current) return;
      if (selected?.id === row.id) { clear(); resetSelection(); }
      else setNotice('会话记录已删除。');
    } catch (failure) { report(operation, failure); }
    finally { finish(operation); }
  }
  function download() {
    try {
      const serialized = exportConversation(mode, messages);
      const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `personal-ai-chat-${mode}-${Date.now()}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (failure) {
      setError(failure instanceof ConversationStoreError ? failure.message : '暂时无法导出，请重试。');
    }
  }
  return { open, setOpen, search, setSearch, selected, busy, notice, error,
    items: result?.items ?? [], reading: result === undefined && !storageUnavailable,
    unavailable: storageUnavailable || (result?.unavailable ?? false), save, load, remove, download,
    confirmDiscard, resetSelection };
}
