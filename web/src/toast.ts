import { create } from 'zustand';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
  ms: number;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id' | 'ms'> & { ms?: number }) => number;
  dismiss: (id: number) => void;
}

let seq = 1;
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = seq++;
    const toast: Toast = { ms: t.kind === 'error' ? 8000 : 4000, ...t, id };
    set({ toasts: [...get().toasts.slice(-3), toast] });
    setTimeout(() => get().dismiss(id), toast.ms);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  info: (text: string, action?: Toast['action'], ms?: number) =>
    useToasts.getState().push({ text, kind: 'info', action, ms }),
  success: (text: string) => useToasts.getState().push({ text, kind: 'success' }),
  error: (text: string) => useToasts.getState().push({ text, kind: 'error' }),
};
