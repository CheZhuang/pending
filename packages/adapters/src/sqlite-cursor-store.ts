import type { AdapterCursor, CursorStore } from './index.js';

/** Narrow subset of the trusted generic entity store; avoids a B-owned SQL schema. */
export interface GenericEntityStore {
  get<T>(id: string): T | undefined;
  put(id: string, kind: string, data: unknown): void;
}

interface CursorEntity {
  key: string;
  cursor: AdapterCursor;
}

/** Durable adapter cursor stored through the existing generic SQLite entity table. */
export class SqliteCursorStore implements CursorStore {
  constructor(private readonly store: GenericEntityStore) {}

  async get(key: string): Promise<AdapterCursor | undefined> {
    const entity = this.store.get<CursorEntity>(this.idFor(key));
    if (!entity || entity.key !== key) return undefined;
    return { ...entity.cursor };
  }

  async set(key: string, cursor: AdapterCursor): Promise<void> {
    this.store.put(this.idFor(key), 'adapter_cursor', { key, cursor: { ...cursor } });
  }

  private idFor(key: string): string {
    return `adapter_cursor:${encodeURIComponent(key)}`;
  }
}
