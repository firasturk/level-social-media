/**
 * In-memory stand-ins for the Worker bindings, so the engine can be driven end to end in a test:
 * a D1 database on node:sqlite with every migration applied, and an R2 bucket on a Map.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../../server/env";

type Param = string | number | bigint | null | Uint8Array | ArrayBuffer;

function sqlParam(v: unknown): Param {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "bigint" ||
    v instanceof Uint8Array
  )
    return v;
  return JSON.stringify(v);
}

class FakeStatement {
  private params: Param[] = [];
  constructor(
    private db: DatabaseSync,
    private sql: string,
  ) {}
  bind(...params: unknown[]): FakeStatement {
    const s = new FakeStatement(this.db, this.sql);
    s.params = params.map(sqlParam);
    return s;
  }
  private stmt() {
    return this.db.prepare(this.sql);
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.stmt().get(...(this.params as never[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: true;
    meta: Record<string, unknown>;
  }> {
    const results = this.stmt().all(...(this.params as never[])) as T[];
    return { results, success: true, meta: {} };
  }
  async run<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: true;
    meta: { changes: number; last_row_id: number };
  }> {
    const r = this.stmt().run(...(this.params as never[]));
    return {
      results: [],
      success: true,
      meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
    };
  }
  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.stmt().all(...(this.params as never[])) as Record<string, unknown>[];
    return rows.map((r) => Object.values(r) as unknown as T);
  }
}

export class FakeD1 {
  readonly db: DatabaseSync;
  constructor() {
    this.db = new DatabaseSync(":memory:");
    const dir = join(process.cwd(), "migrations");
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      this.db.exec(readFileSync(join(dir, f), "utf8"));
  }
  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.db, sql);
  }
  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    const out: unknown[] = [];
    this.db.exec("BEGIN");
    try {
      for (const s of statements) out.push(await s.run());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }
  dump(): void {
    this.db.exec("ROLLBACK");
  }
}

interface StoredObject {
  bytes: ArrayBuffer;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export class FakeR2 {
  readonly objects = new Map<string, StoredObject>();
  private wrap(key: string, o: StoredObject) {
    return {
      key,
      size: o.bytes.byteLength,
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
      arrayBuffer: async () => o.bytes.slice(0),
      text: async () => new TextDecoder().decode(o.bytes),
      json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
      body: null,
    };
  }
  async get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }) {
    const o = this.objects.get(key);
    if (!o) return null;
    const r = options?.range;
    if (!r) return this.wrap(key, o);
    // A slice, as R2 serves one: the object keeps its full size, the bytes are the range.
    const size = o.bytes.byteLength;
    const start = r.suffix !== undefined ? Math.max(0, size - r.suffix) : (r.offset ?? 0);
    const end = r.suffix !== undefined ? size : Math.min(size, start + (r.length ?? size - start));
    const slice = o.bytes.slice(start, end);
    return { ...this.wrap(key, o), size, arrayBuffer: async () => slice.slice(0), body: null };
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? this.wrap(key, o) : null;
  }
  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | string | ReadableStream | null,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ) {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value).buffer
        : value instanceof Uint8Array
          ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
          : value instanceof ArrayBuffer
            ? value
            : value
              ? await new Response(value).arrayBuffer()
              : new ArrayBuffer(0);
    const o: StoredObject = {
      bytes: bytes as ArrayBuffer,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    };
    this.objects.set(key, o);
    return this.wrap(key, o);
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list(options?: { prefix?: string; limit?: number }) {
    const prefix = options?.prefix ?? "";
    const objects = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, o]) => this.wrap(k, o));
    return { objects, truncated: false, delimitedPrefixes: [] as string[] };
  }
}

/** A Worker environment over the fakes, with the variables the engine needs to sign and route. */
export function fakeEnv(overrides: Partial<Env> = {}): Env & { DB: FakeD1; BUCKET: FakeR2 } {
  const DB = new FakeD1();
  const BUCKET = new FakeR2();
  return {
    DB: DB as unknown as D1Database,
    BUCKET: BUCKET as unknown as R2Bucket,
    HIGGSFIELD_MODEL: "nano-banana-pro",
    HIGGSFIELD_BASE_URL: "https://higgsfield.test",
    MAX_CONCURRENT_GENERATIONS: "6",
    PUBLIC_BASE_URL: "https://studio.test",
    SESSION_SECRET: "test-session-secret-0123456789",
    ...overrides,
  } as unknown as Env & { DB: FakeD1; BUCKET: FakeR2 };
}
