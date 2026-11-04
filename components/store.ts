'use client';
import { create } from 'zustand';
import { api } from './api';

export type View = 'inbox' | 'chat' | 'board' | 'settings';
export type Pane =
  | { kind: 'thread'; id: number } | { kind: 'task'; id: number } | { kind: 'review'; id: number }
  | { kind: 'log'; id: number } | { kind: 'newtask' };
export interface Toast { id: number; text: string; tone?: 'info' | 'error'; actions?: { label: string; run: () => Promise<unknown> | void }[] }
/** Deep link into Settings → Agents (PHASE2 §B1/§B6): scroll to the agent and focus the $/day input or the Enabled checkbox. */
export interface AgentFocus { agent: string; field: 'usd' | 'enabled' | 'row' }

interface S {
  boot: any | null; loadError: string | null; view: View; panes: Pane[]; toasts: Toast[];
  sse: 'live' | 'reconnecting' | 'offline'; diffExpanded: boolean; sessionExpired: boolean; rev: number; killFailed: boolean;
  settingsAgentFocus: AgentFocus | null; settingsFocus: string | null; settingsPrefill: Record<string, number> | null; composerPrefill: string | null;
  setView(v: View): void; open(p: Pane): void; back(): void; close(): void; refresh(): Promise<void>;
  toast(text: string, tone?: Toast['tone'], actions?: Toast['actions']): void; openSettingsAgent(f: AgentFocus): void; dismiss(id: number): void; set(p: Partial<S>): void;
}

let toastId = 0;
/** Element that had focus when the first pane opened; focus returns there on close (UX §9). Kept outside React state. */
let opener: HTMLElement | null = null;
export const useStore = create<S>((set, get) => ({
  boot: null, loadError: null, diffExpanded: false, view: 'chat', panes: [], toasts: [], sse: 'live', sessionExpired: false, rev: 0, killFailed: false,
  settingsFocus: null, settingsPrefill: null, composerPrefill: null, settingsAgentFocus: null,
  openSettingsAgent: (f) => set({ settingsAgentFocus: f, view: 'settings' }),
  setView: (view) => set({ view }),
  open: (p) => {
    if (get().panes.length === 0) opener = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null;
    set((s) => ({ panes: [...s.panes.filter((x) => JSON.stringify(x) !== JSON.stringify(p)), p].slice(-8) }));
  },
  back: () => {
    set((s) => ({ panes: s.panes.slice(0, -1) }));
    setTimeout(() => document.querySelector<HTMLElement>('aside[aria-label="Detail"] h2')?.focus(), 0);   // new top pane's heading
  },
  close: () => {
    const had = get().panes.length > 0, el = opener; opener = null;
    set({ panes: [] });
    if (had && el) setTimeout(() => { if (document.contains(el)) el.focus(); }, 0);
  },
  refresh: async () => {
    try {
      const b = await api('/api/bootstrap');
      set((s) => ({ boot: b, loadError: null, rev: s.rev + 1 }));
    } catch (e: any) {
      if (!get().boot) set({ loadError: `${e.status ? 'HTTP ' + e.status + ' ' : ''}${e.code}` });
    }
  },
  toast: (text, tone = 'info', actions) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone, actions }] }));
    setTimeout(() => get().dismiss(id), actions?.length ? 15000 : 6000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  set: (p) => set(p as any),
}));
