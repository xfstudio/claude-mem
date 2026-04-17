import { Database } from 'bun:sqlite';
import mysql from 'mysql2/promise';
import { DB_PATH, ensureDir, DATA_DIR } from '../../shared/paths.js';
import { loadClaudeMemEnv } from '../../shared/EnvManager.js';
import { IDatabaseProvider } from './provider/IDatabaseProvider.js';
import { SqliteProvider } from './provider/SqliteProvider.js';
import { MysqlProvider } from './provider/MysqlProvider.js';
import { HybridDatabaseProvider } from './provider/HybridDatabaseProvider.js';
import { logger } from '../../utils/logger.js';

let sharedProvider: IDatabaseProvider | null = null;
let sharedPool: mysql.Pool | null = null;

async function createSqliteDb(dbPath: string): Promise<Database> {
  if (dbPath !== ':memory:') {
    ensureDir(DATA_DIR);
  }
  const db = new Database(dbPath, { create: true, readwrite: true });
  await db.run('PRAGMA journal_mode = WAL');
  await db.run('PRAGMA synchronous = NORMAL');
  await db.run('PRAGMA foreign_keys = ON');
  await db.run('PRAGMA temp_store = memory');
  await db.run(`PRAGMA mmap_size = ${256 * 1024 * 1024}`);
  await db.run(`PRAGMA cache_size = 10000`);
  return db;
}

export async function getDatabaseProvider(dbPath: string = DB_PATH): Promise<IDatabaseProvider> {
  const env = loadClaudeMemEnv();
  const engine = env.CLAUDE_MEM_DATABASE_ENGIN || 'sqlite';

  if (engine === 'mysql') {
    if (!sharedProvider) {
      if (!sharedPool) {
        sharedPool = mysql.createPool({
          host: env.MYSQL_HOST || 'localhost',
          port: parseInt(env.MYSQL_PORT || '3306', 10),
          user: env.MYSQL_USER,
          password: env.MYSQL_PASSWORD,
          database: env.MYSQL_DATABASE || 'claude_mem',
          waitForConnections: true,
          connectionLimit: 10,
          queueLimit: 0,
        });

        // Initialize MySQL Database Schema exactly as SQLite would if it doesn't exist
        logger.info('DB', 'Connected to MySQL pool. Checking schema initialization.');
        try {
          // Initialize schemas manually for MySQL since we can't reliably read the exact sqlite files
          await createMysqlSchema(sharedPool);
        } catch (err: any) {
          logger.error('DB', 'Failed to initialize MySQL schema', err);
          throw err;
        }
      }
      
      const mysqlProvider = new MysqlProvider(sharedPool);
      const sqliteDb = await createSqliteDb(dbPath);
      const sqliteProvider = new SqliteProvider(sqliteDb);
      
      sharedProvider = new HybridDatabaseProvider(sqliteProvider, mysqlProvider);
    }
    return sharedProvider;
  }

  // SQLite (default)
  const sqliteDb = await createSqliteDb(dbPath);
  return new SqliteProvider(sqliteDb);
}

/**
 * Creates MySQL tables tracking identical schema to SQLite migrations
 */
async function createMysqlSchema(pool: mysql.Pool) {
  const queries = [
    `CREATE TABLE IF NOT EXISTS sdk_sessions (
      id INTEGER PRIMARY KEY AUTO_INCREMENT,
      content_session_id VARCHAR(255) UNIQUE NOT NULL,
      memory_session_id VARCHAR(255) UNIQUE,
      project VARCHAR(500) NOT NULL,
      platform_source VARCHAR(100) NOT NULL DEFAULT 'claude',
      user_prompt TEXT,
      started_at VARCHAR(100) NOT NULL,
      started_at_epoch BIGINT NOT NULL,
      completed_at VARCHAR(100),
      completed_at_epoch BIGINT,
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      worker_port INTEGER,
      prompt_counter INTEGER DEFAULT 0,
      custom_title TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTO_INCREMENT,
      memory_session_id VARCHAR(255) NOT NULL,
      project VARCHAR(500) NOT NULL,
      text TEXT,
      type VARCHAR(100) NOT NULL,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      created_at VARCHAR(100) NOT NULL,
      created_at_epoch BIGINT NOT NULL,
      content_hash VARCHAR(64),
      generated_by_model VARCHAR(100),
      relevance_count INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTO_INCREMENT,
      memory_session_id VARCHAR(255) NOT NULL,
      project VARCHAR(500) NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      files_read TEXT,
      files_edited TEXT,
      notes TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      created_at VARCHAR(100) NOT NULL,
      created_at_epoch BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS pending_messages (
      id INTEGER PRIMARY KEY AUTO_INCREMENT,
      session_db_id INTEGER NOT NULL,
      content_session_id VARCHAR(255) NOT NULL,
      message_type VARCHAR(50) NOT NULL,
      tool_name VARCHAR(100),
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      last_user_message TEXT,
      last_assistant_message TEXT,
      prompt_number INTEGER,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at_epoch BIGINT NOT NULL,
      started_processing_at_epoch BIGINT,
      completed_at_epoch BIGINT,
      failed_at_epoch BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTO_INCREMENT,
      content_session_id VARCHAR(255) NOT NULL,
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at VARCHAR(100) NOT NULL,
      created_at_epoch BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY AUTO_INCREMENT,
      version INTEGER UNIQUE NOT NULL,
      applied_at VARCHAR(100) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS observation_feedback (
      id INTEGER PRIMARY KEY AUTO_INCREMENT,
      observation_id INTEGER NOT NULL,
      signal_type VARCHAR(100) NOT NULL,
      session_db_id INTEGER,
      created_at_epoch BIGINT NOT NULL,
      metadata TEXT
    )`
  ];

  for (const q of queries) {
    await pool.query(q);
  }
}
