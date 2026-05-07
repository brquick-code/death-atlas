// C:\death-atlas\mobile\src\lib\focus.ts
export type FocusTarget = {
  id: string;
  title: string;
  lat: number;
  lng: number;

  wikipedia_url?: string | null;

  // legacy single source
  source_url?: string | null;

  // multi-source
  source_urls?: string[] | null;

  death_date?: string | null;
  date_start?: string | null;
  date_end?: string | null;
  confidence?: string | null;
  coord_source?: string | null;
};

let pending: FocusTarget | null = null;
const listeners = new Set<(t: FocusTarget) => void>();

export function setFocusTarget(t: FocusTarget) {
  pending = t;
  for (const fn of listeners) fn(t);
}

export function consumeFocusTarget(): FocusTarget | null {
  const t = pending;
  pending = null;
  return t;
}

export function subscribeFocus(fn: (t: FocusTarget) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
