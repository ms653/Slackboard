'use client';
import { create } from 'zustand';
import { api } from './api';

export type View = 'inbox' | 'chat' | 'board' | 'settings';
export type Pane =
  | { kind: 'thread'; id: number } | { kind: 'task'; id: number } | { kind: 'review'; id: number }
  | { kind: 'log'; id: number } | { kind: 'newtask' };
export interface Toast { id: number; text: string; tone?: 'info' | 'error' }

interface S {
  boot: any | null; loadError: string | null; view: View; panes: Pane[]; toasts: Toast[];
  sse: 'live' | 'reconnecting' | 'offline'; sessionExpired: boolean; rev: number;
  settingsFocus: string | null; settingsPrefill: Record<string, number> | null; composerPrefill: string | null;
  setView(v: View): void; open(p: Pane): void; back(): void; close(): void; refresh(): Promise<void>;
  toast(text: string, tone?: Toast['tone']): void; dismiss(id: number): void; set(p: Partial<S>): void;
}

let toastId = 0;
export const useStore = create<S>((set, get) => ({
  boot: null, loadError: null, view: 'chat', panes: [], toasts: [], sse: 'live', sessionExpired: false, rev: 0,
  settingsFocus: null, settingsPrefill: null, composerPrefill: null,
  setView: (view) => set({ view }),
  open: (p) => set((s) => ({ panes: [...s.panes.filter((x) => JSON.stringify(x) !== JSON.stringify(p)), p].slice(-8) })),
  back: () => set((s) => ({ panes: s.panes.slice(0, -1) })),
  close: () => set({ panes: [] }),
  refresh: async () => {
    try {
      const b = await api('/api/bootstrap');
      set((s) => ({ boot: b, loadError: null, rev: s.rev + 1 }));
    } catch (e: any) {
      if (!get().boot) set({ loadError: `${e.status ? 'HTTP ' + e.status + ' ' : ''}${e.code}` });
    }
  },
  toast: (text, tone = 'info') => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => get().dismiss(id), 6000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  set: (p) => set(p as any),
}));
