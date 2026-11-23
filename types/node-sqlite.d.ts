/**
 * Minimal ambient types for `node:sqlite` (Node 22.5+, still flagged
 * experimental by types). @types/node 20.x predates the module, so the
 * SQLite spike (11-24 row) declares the surface it actually uses —
 * nothing more. If @types/node ever grows node-sqlite types, this file
 * can retire.
 */
declare module "node:sqlite" {
  export type SqlValue = null | number | bigint | string | Uint8Array;

  export class StatementSync {
    run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SqlValue[]): Record<string, unknown> | undefined;
    all(...params: SqlValue[]): Record<string, unknown>[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export function backup(
    destinationDatabase: DatabaseSync,
    sourceDatabase?: DatabaseSync,
  ): void;
}
