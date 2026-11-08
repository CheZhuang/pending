// Picks the API implementation. Order: ?api=live|mock in the URL, saved choice,
// explicit Vite live mode, then live for built assets and mock for Vite preview.
import { live } from './live.js';
import { createMock } from './mock.js';

const KEY = 'pendingtree.console.apiMode';

function initialMode() {
  const fromUrl = new URLSearchParams(location.search).get('api');
  if (fromUrl === 'live' || fromUrl === 'mock') return fromUrl;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'live' || saved === 'mock') return saved;
  } catch { /* storage unavailable */ }
  return import.meta.env.VITE_API_MODE === 'mock' ? 'mock'
    : import.meta.env.VITE_API_MODE === 'live' || import.meta.env.MODE === 'live' ? 'live'
      : import.meta.env.PROD ? 'live' : 'mock';
}

export const mode = initialMode();
export const api = mode === 'live' ? live : createMock();

/** Switch between mock and live; reloads so every view starts from a clean state. */
export function switchMode(next) {
  try { localStorage.setItem(KEY, next); } catch { /* storage unavailable */ }
  const url = new URL(location.href);
  url.searchParams.delete('api');
  location.href = url.toString();
}
