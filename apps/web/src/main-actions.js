// Shared error handling for Main writes: a stale revision gets an explicit
// "reload and review" dialog; everything else is a notification. Used by the
// Main editor and the history/rollback view so both behave the same.
import { describe } from './api/errors.js';

export function useMainActions({ dialog, message, reload }) {
  return async function act(fn, success) {
    try {
      const result = await fn();
      if (success) message.success(success);
      await reload();
      return result;
    } catch (error) {
      const d = describe(error);
      if (error?.code === 'STALE') {
        dialog.warning({
          title: 'Main changed while you were working',
          content: `${d.hint} Nothing was written.`,
          positiveText: 'Reload latest Main',
          onPositiveClick: () => reload(),
        });
      } else {
        message.error(d.hint ? `${d.title} — ${d.hint}` : d.title, { duration: 7000 });
      }
      return null;
    }
  };
}

export const fileText = (f) => `${f.rootId}:${f.path}`;

/** Parse "rootId:path" lines against the workspace roots. Throws a readable error. */
export function parseFiles(text, roots) {
  const parsed = [];
  for (const line of String(text ?? '').split('\n').map((x) => x.trim()).filter(Boolean)) {
    const index = line.indexOf(':');
    const rootId = line.slice(0, index);
    const path = line.slice(index + 1).trim();
    if (index <= 0 || !roots.some((root) => root.id === rootId) || !path) throw new Error(`Use a known rootId:path reference for “${line}” (roots: ${roots.map((r) => r.id).join(', ') || 'none'}).`);
    parsed.push({ rootId, path });
  }
  return parsed;
}
