declare module 'bun:sqlite' {
  export interface Statement<T = unknown> {
    all(params?: unknown): T[];
    get(params?: unknown): T | null;
    run(params?: unknown): unknown;
  }

  export class Database {
    constructor(filename?: string, options?: { create?: boolean; readonly?: boolean });
    exec(sql: string): void;
    query<T = unknown>(sql: string): Statement<T>;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(): void;
  }
}
