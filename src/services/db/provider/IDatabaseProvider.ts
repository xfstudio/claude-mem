export interface IDatabaseProvider {
  /**
   * Retrieves a single row from the database.
   * By default, it expects a generic type T corresponding to the row shape.
   */
  get<T extends Record<string, any>>(sql: string, params?: any[]): Promise<T | null>;

  /**
   * Retrieves all rows matching the query.
   */
  all<T extends Record<string, any>>(sql: string, params?: any[]): Promise<T[]>;

  /**
   * Executes a statement (INSERT/UPDATE/DELETE) and returns affected rows & last insert id.
   */
  run(sql: string, params?: any[]): Promise<{ changes: number; lastInsertRowid: number }>;

  /**
   * Runs queries within a transaction block.
   */
  transaction<T>(fn: (provider: IDatabaseProvider) => Promise<T>): Promise<T>;

  /**
   * Closes the database connection / pool.
   */
  close(): Promise<void>;

  /**
   * Schema inspection: Checks if a table exists.
   */
  hasTable(tableName: string): Promise<boolean>;

  /**
   * Schema inspection: Checks if a column exists in a given table.
   */
  hasColumn(tableName: string, columnName: string): Promise<boolean>;

  /**
   * Schema inspection: Checks if an index exists.
   */
  hasIndex(tableName: string, indexName: string): Promise<boolean>;
}
