import { IDatabaseProvider } from './IDatabaseProvider.js';
import { MysqlProvider } from './MysqlProvider.js';
import { SqliteProvider } from './SqliteProvider.js';
import { SyncService } from '../sync.js';
import { logger } from '../../../utils/logger.js';

export class HybridDatabaseProvider implements IDatabaseProvider {
  constructor(
    private sqlite: SqliteProvider,
    private mysql: MysqlProvider
  ) {
    logger.info('DB', 'Initialized HybridDatabaseProvider (Cache-Through SQLite -> MySQL)');
  }

  getSqliteProvider(): SqliteProvider {
    return this.sqlite;
  }

  getMysqlProvider(): MysqlProvider {
    return this.mysql;
  }

  async get<T extends Record<string, any>>(sql: string, params?: any[]): Promise<T | null> {
    try {
      const localResult = await this.sqlite.get<T>(sql, params);
      if (localResult) return localResult;
    } catch (err: any) {
      logger.warn('DB', `SQLite get() failed: ${err.message}. Falling back to MySQL.`);
    }

    // If SQL contains SQLite-specific syntax, don't attempt MySQL fallback
    if (this.isSqliteOnlySql(sql)) {
      return null;
    }

    // Cache miss — sync and retry SQLite
    await SyncService.syncBidirectional(this.sqlite, this.mysql);

    try {
      const recoveredResult = await this.sqlite.get<T>(sql, params);
      if (recoveredResult) return recoveredResult;
    } catch (e) {}

    // Final fallback: MySQL
    try {
      return await this.mysql.get<T>(sql, params);
    } catch (err: any) {
      logger.warn('DB', `MySQL get() fallback failed: ${err.message}`);
      return null;
    }
  }

  async all<T extends Record<string, any>>(sql: string, params?: any[]): Promise<T[]> {
    try {
      const localResults = await this.sqlite.all<T>(sql, params);
      if (localResults && localResults.length > 0) return localResults;
    } catch (err: any) {
      logger.warn('DB', `SQLite all() failed: ${err.message}. Falling back to MySQL.`);
    }

    // If SQL contains SQLite-specific syntax, don't attempt MySQL fallback
    if (this.isSqliteOnlySql(sql)) {
      return [];
    }

    // Cache miss — sync and retry SQLite
    await SyncService.syncBidirectional(this.sqlite, this.mysql);

    try {
      const recoveredResults = await this.sqlite.all<T>(sql, params);
      if (recoveredResults && recoveredResults.length > 0) return recoveredResults;
    } catch (e) {}

    // Final fallback: MySQL
    try {
      return await this.mysql.all<T>(sql, params);
    } catch (err: any) {
      logger.warn('DB', `MySQL all() fallback failed: ${err.message}`);
      return [];
    }
  }

  async run(sql: string, params?: any[]): Promise<{ changes: number; lastInsertRowid: number }> {
    const trimmed = sql.trim().toUpperCase();

    // DDL and SQLite-specific statements run on SQLite only.
    // MySQL schema is managed by createMysqlSchema() in DatabaseFactory.
    const isSqliteOnly =
      /^(CREATE|DROP|ALTER|PRAGMA|VACUUM|ATTACH|DETACH)\b/.test(trimmed) ||
      /^INSERT\s+OR\s+(IGNORE|REPLACE|ROLLBACK|ABORT|FAIL)\b/.test(trimmed);

    if (isSqliteOnly) {
      return this.sqlite.run(sql, params);
    }

    // DML: dual-write to both SQLite and MySQL
    await this.mysql.run(sql, params);
    return this.sqlite.run(sql, params);
  }

  async transaction<T>(fn: (provider: IDatabaseProvider) => Promise<T>): Promise<T> {
    // Create a transaction-safe proxy that prevents close() during transaction
    const transactionProxy = new Proxy(this, {
      get(target, prop) {
        if (prop === 'close') {
          return async () => {
            logger.warn('DB', 'Attempted to close database during transaction - ignored');
          };
        }
        return (target as any)[prop];
      }
    }) as IDatabaseProvider;

    // Execute MySQL transaction first
    let mysqlResult!: T;
    await this.mysql.transaction(async () => {
      mysqlResult = await fn(transactionProxy);
      return mysqlResult;
    });

    // Mirror on SQLite (best-effort local cache)
    try {
      await this.sqlite.transaction(() => fn(transactionProxy));
    } catch (e) {
      logger.warn('DB', 'SQLite transaction failed after MySQL commit (will resync on next read)', e as Error);
    }

    return mysqlResult;
  }

  async close(): Promise<void> {
    await Promise.all([
      this.mysql.close(),
      this.sqlite.close()
    ]);
  }

  async hasTable(tableName: string): Promise<boolean> {
    return this.sqlite.hasTable(tableName);
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    return this.sqlite.hasColumn(tableName, columnName);
  }

  async hasIndex(tableName: string, indexName: string): Promise<boolean> {
    return this.sqlite.hasIndex(tableName, indexName);
  }

  /**
   * Detect SQLite-specific SQL that cannot be executed on MySQL.
   * Used to prevent MySQL fallback errors on incompatible queries.
   */
  private isSqliteOnlySql(sql: string): boolean {
    const upper = sql.toUpperCase();
    return (
      upper.includes('JSON_EACH(') ||
      upper.includes('JSON_TREE(') ||
      upper.includes('JSON_GROUP_ARRAY(') ||
      /\bPRAGMA\b/.test(upper) ||
      /\bINSERT\s+OR\s+(IGNORE|REPLACE)\b/.test(upper) ||
      upper.includes('GLOB ') ||
      upper.includes('TYPEOF(')
    );
  }

  /**
   * Helper to perform incremental copy-back from MySQL misses to SQLite cache
   */
  private async syncResultToSqlite<T extends Record<string, any>>(sql: string, rows: T[]): Promise<void> {
    if (!rows || rows.length === 0) return;
    
    const tableMatch = sql.match(/\bFROM\s+([a-zA-Z0-9_]+)\b/i);
    if (!tableMatch) return;
    
    const table = tableMatch[1];
    
    // Build generic INSERT OR REPLACE statement for the local cache
    const keys = Object.keys(rows[0]);
    if (keys.length === 0) return;

    const columns = keys.join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const upsertSql = `INSERT OR REPLACE INTO ${table} (${columns}) VALUES (${placeholders})`;

    try {
      // Begin an isolated transaction on sqlite for batch sync
      await this.sqlite.run('BEGIN TRANSACTION');
      for (const row of rows) {
        const values = keys.map(k => row[k]);
        await this.sqlite.run(upsertSql, values);
      }
      await this.sqlite.run('COMMIT');
    } catch (err: any) {
      try {
        await this.sqlite.run('ROLLBACK');
      } catch (rollbackErr) {
        // ignore
      }
      logger.error('DB', `Failed to sync recovered rows back to SQLite table ${table}`, err);
    }
  }
}
