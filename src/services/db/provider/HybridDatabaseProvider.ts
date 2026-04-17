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
      logger.warn('DB', `SQLite get() failed: ${err.message}. Falling back to MySQL. Query: ${sql}`);
    }

    // Cache miss or local error. Try remote.
    // Sync all new remote rows so this request and subsequent ones can succeed via SQLite natively.
    await SyncService.syncRemoteToLocal(this.sqlite, this.mysql);

    // After syncing to local, try fetching from SQLite again as primary SSOT
    try {
      const recoveredResult = await this.sqlite.get<T>(sql, params);
      if (recoveredResult) {
        logger.debug('DB', `Hybrid Cache Miss Recovered from MySQL and fetched from SQLite for query: ${sql}`);
        return recoveredResult;
      }
    } catch(e) {}
    
    // As an absolute final fallback, try fetching remotely
    const remoteResult = await this.mysql.get<T>(sql, params);
    
    return remoteResult;
  }

  async all<T extends Record<string, any>>(sql: string, params?: any[]): Promise<T[]> {
    try {
      const localResults = await this.sqlite.all<T>(sql, params);
      if (localResults && localResults.length > 0) return localResults;
    } catch (err: any) {
      logger.warn('DB', `SQLite all() failed: ${err.message}. Falling back to MySQL. Query: ${sql}`);
    }

    // Cache miss or empty list. Try remote.
    // Sync all new remote rows so this request and subsequent ones can succeed via SQLite natively.
    await SyncService.syncRemoteToLocal(this.sqlite, this.mysql);

    // try fetching from SQLite again
    try {
      const recoveredResults = await this.sqlite.all<T>(sql, params);
      if (recoveredResults && recoveredResults.length > 0) {
        logger.debug('DB', `Hybrid Cache Miss Recovered ${recoveredResults.length} rows from MySQL via SyncService for query: ${sql}`);
        return recoveredResults;
      }
    } catch(e) {}

    // absolute final fallback
    const remoteResults = await this.mysql.all<T>(sql, params);
    
    return remoteResults;
  }

  async run(sql: string, params?: any[]): Promise<{ changes: number; lastInsertRowid: number }> {
    // Dual write
    // Prefer letting MySQL throw if there is a constraint violation
    await this.mysql.run(sql, params);
    return await this.sqlite.run(sql, params);
  }

  async transaction<T>(fn: (provider: IDatabaseProvider) => Promise<T>): Promise<T> {
    // MySQL provider doesn't strictly have a `transaction` wrapped callback, 
    // but the IDatabaseProvider interface relies on `run('BEGIN TRANSACTION')`.
    // In hybrid, we just pass ourselves so `fn(this)` runs `this.run` (dual writes).
    
    // Begin on both
    await this.mysql.run('BEGIN'); // MySQL uses BEGIN
    await this.sqlite.run('BEGIN TRANSACTION');

    try {
      const result = await fn(this);
      
      await this.mysql.run('COMMIT');
      await this.sqlite.run('COMMIT');
      
      return result;
    } catch (error) {
      // Rollback on both
      try {
        await this.mysql.run('ROLLBACK');
      } catch (e) {
        logger.error('DB', 'Failed to rollback MySQL transaction', e as Error);
      }
      
      try {
        await this.sqlite.run('ROLLBACK');
      } catch (e) {
        logger.error('DB', 'Failed to rollback SQLite transaction', e as Error);
      }
      
      throw error;
    }
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
