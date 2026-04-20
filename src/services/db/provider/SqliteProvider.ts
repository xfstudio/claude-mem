import { IDatabaseProvider } from './IDatabaseProvider.js';
import { Database } from 'bun:sqlite';

export class SqliteProvider implements IDatabaseProvider {
  private db: Database;
  private isClosed = false;

  constructor(db: Database) {
    this.db = db;
  }

  async get<T extends Record<string, any>>(sql: string, params: any[] = []): Promise<T | null> {
    if (this.isClosed) {
      throw new Error('SQLite database is closed');
    }
    const result = this.db.query(sql).get(...params) as T | undefined | null;
    return result || null;
  }

  async all<T extends Record<string, any>>(sql: string, params: any[] = []): Promise<T[]> {
    if (this.isClosed) {
      throw new Error('SQLite database is closed');
    }
    return this.db.query(sql).all(...params) as T[];
  }

  async run(sql: string, params: any[] = []): Promise<{ changes: number; lastInsertRowid: number }> {
    if (this.isClosed) {
      throw new Error('SQLite database is closed');
    }
    const query = this.db.prepare(sql);
    const result = query.run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  async transaction<T>(fn: (provider: IDatabaseProvider) => Promise<T>): Promise<T> {
    if (this.isClosed) {
      throw new Error('SQLite database is closed');
    }
    // Note: Since run, get, and all are wrapped in Promises but sqlite runs synchronously,
    // we must start a DEFERRED or IMMEDIATE transaction. Actually, bun:sqlite transaction()
    // runs synchronously. But since `fn` returns a Promise, we must use BEGIN and COMMIT manually.

    this.db.run('BEGIN TRANSACTION');
    try {
      const result = await fn(this);
      this.db.run('COMMIT');
      return result;
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    if (!this.isClosed) {
      this.db.close();
      this.isClosed = true;
    }
  }

  async hasTable(tableName: string): Promise<boolean> {
    const row = this.db.query('SELECT name FROM sqlite_master WHERE type="table" AND name=?').get(tableName) as any;
    return !!row;
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    // sqlite PRAGMA doesn't accept parameters directly easily, but string concat is safe for standard names.
    const columns = this.db.query(`PRAGMA table_info("${tableName}")`).all() as any[];
    return columns.some(c => c.name === columnName);
  }

  async hasIndex(tableName: string, indexName: string): Promise<boolean> {
    const indexes = this.db.query(`PRAGMA index_list("${tableName}")`).all() as any[];
    return indexes.some(idx => idx.name === indexName);
  }
}
