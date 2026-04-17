import mysql from 'mysql2/promise';
import { IDatabaseProvider } from './IDatabaseProvider.js';

export class MysqlProvider implements IDatabaseProvider {
  private pool: mysql.Pool;

  constructor(pool: mysql.Pool) {
    this.pool = pool;
  }

  async get<T extends Record<string, any>>(sql: string, params?: any[]): Promise<T | null> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(sql, params);
    if (!rows || rows.length === 0) {
      return null;
    }
    return rows[0] as T;
  }

  async all<T extends Record<string, any>>(sql: string, params?: any[]): Promise<T[]> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(sql, params);
    return rows as T[];
  }

  async run(sql: string, params: any[] = []): Promise<{ changes: number; lastInsertRowid: number }> {
    // Handle transaction control commands separately (not supported in prepared statements)
    if (/^\s*(BEGIN|START TRANSACTION|COMMIT|ROLLBACK)\s*$/i.test(sql.trim())) {
      const connection = await this.pool.getConnection();
      try {
        await connection.query(sql);
        return { changes: 0, lastInsertRowid: 0 };
      } finally {
        connection.release();
      }
    }

    // Split multi-statement SQL (MySQL doesn't support multiple statements in execute())
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);

    if (statements.length > 1) {
      // Execute each statement separately
      let totalChanges = 0;
      let lastId = 0;

      for (const stmt of statements) {
        const [result] = await this.pool.execute<mysql.ResultSetHeader>(stmt, params);
        totalChanges += result.affectedRows || 0;
        if (result.insertId) lastId = result.insertId;
      }

      return { changes: totalChanges, lastInsertRowid: lastId };
    }

    // Single statement - use prepared statement
    const [result] = await this.pool.execute<mysql.ResultSetHeader>(sql, params);
    return {
      changes: result.affectedRows,
      lastInsertRowid: result.insertId,
    };
  }

  async transaction<T>(fn: (provider: IDatabaseProvider) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    await connection.beginTransaction();

    // Create a temporary provider that uses the single connection instead of the pool
    // to ensure all queries within the transaction use the exact same connection
    const txProvider = new MysqlProvider(connection as any);

    try {
      const result = await fn(txProvider);
      await connection.commit();
      return result;
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    // If this is a single connection from a transaction, do not destroy the pool!
    // We assume the top-level app manager calls pool.end().
    if ('end' in this.pool) {
        await (this.pool as any).end();
    }
  }

  async hasTable(tableName: string): Promise<boolean> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>('SHOW TABLES LIKE ?', [tableName]);
    return rows.length > 0;
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
    return rows.length > 0;
  }

  async hasIndex(tableName: string, indexName: string): Promise<boolean> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(`SHOW INDEX FROM \`${tableName}\` WHERE Key_name = ?`, [indexName]);
    return rows.length > 0;
  }
}
