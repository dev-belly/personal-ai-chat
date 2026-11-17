'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ChatMode, DisplayMessage } from '../../lib/chat-contract.ts';
import { ConversationStoreError, exportConversation, getConversationRepository } from '../../lib/local/conversation-store.ts';
import type { ConversationSummary, SavedConversation } from '../../lib/local/conversation-store.ts';

interface HistoryOptions {
  mode: ChatMode;
  messages: DisplayMessage[];
  restore: (conversation: SavedConversation) => void;
  clear: () => void;
}

function storageIsUnavailable() {
  if (typeof window === 'undefined') return false;
  try { return !window.indexedDB; } catch { return true; }
}

export function useConversationHistory({ mode, messages, restore, clear }: HistoryOptions) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<{ id: string; revision: number } | null>(null);
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
      setSelected({ id: saved.id, revision: saved.revision });
      setNotice('已保存到本浏览器；刷新后可从“会话历史”打开。');
    } catch (failure) { report(operation, failure); }
    finally { finish(operation); }
  }
  async function load(id: string) {
    const operation = begin();
    if (operation === undefined) return;
    try {
      const saved = await getConversationRepository().load(id);
      if (operation !== epoch.current) return;
      restore(saved);
      setSelected({ id: saved.id, revision: saved.revision });
      setOpen(false);
    } catch (failure) { report(operation, failure); }
    finally { finish(operation); }
  }
  async function remove(row: ConversationSummary) {
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
    unavailable: storageUnavailable || (result?.unavailable ?? false), save, load, remove, download, resetSelection };
}
