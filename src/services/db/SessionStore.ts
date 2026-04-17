import { IDatabaseProvider } from './provider/IDatabaseProvider.js';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { TableColumnInfo, IndexInfo, TableNameRow, SchemaVersion, SdkSessionRecord, ObservationRecord, SessionSummaryRecord, UserPromptRecord, LatestPromptResult } from '../../types/database.js';
import type { PendingMessageStore } from './PendingMessageStore.js';
import { computeObservationContentHash, findDuplicateObservation } from './observations/store.js';
import { parseFileList } from './observations/files.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource, sortPlatformSources } from '../../shared/platform-source.js';
function resolveCreateSessionArgs(customTitle?: string, platformSource?: string): {
  customTitle?: string;
  platformSource?: string;
} {
  return {
    customTitle,
    platformSource: platformSource ? normalizePlatformSource(platformSource) : undefined
  };
}

/**
 * Session data store for SDK sessions, observations, and summaries
 * Provides simple, synchronous CRUD operations for session-based memory
 */
export class SessionStore {
  public db: IDatabaseProvider;
  constructor(db: IDatabaseProvider) {
    if (DB_PATH !== ':memory:') {
      ensureDir(DATA_DIR);
    }
    this.db = db;
  }

  /**
   * Initializes the database schema asynchronously
   */
  async init(): Promise<void> {
    // Ensure optimized settings
    // await this.db.run('PRAGMA journal_mode = WAL'); // handled by factory
    // await this.db.run('PRAGMA synchronous = NORMAL');
    // await this.db.run('PRAGMA foreign_keys = ON');

    // Initialize schema if needed (fresh database)
    await this.initializeSchema();

    // Run migrations
    await this.ensureWorkerPortColumn();
    await this.ensurePromptTrackingColumns();
    await this.removeSessionSummariesUniqueConstraint();
    await this.addObservationHierarchicalFields();
    await this.makeObservationsTextNullable();
    await this.createUserPromptsTable();
    await this.ensureDiscoveryTokensColumn();
    await this.createPendingMessagesTable();
    await this.renameSessionIdColumns();
    await this.repairSessionIdColumnRename();
    await this.addFailedAtEpochColumn();
    await this.addOnUpdateCascadeToForeignKeys();
    await this.addObservationContentHashColumn();
    await this.addSessionCustomTitleColumn();
    await this.addSessionPlatformSourceColumn();
    await this.addObservationModelColumns();
  }

  /**
   * Initialize database schema (migration004)
   *
   * ALWAYS creates core tables using CREATE TABLE IF NOT EXISTS — safe to run
   * regardless of schema_versions state.  This fixes issue #979 where the old
   * DatabaseManager migration system (versions 1-7) shared the schema_versions
   * table, causing maxApplied > 0 and skipping core table creation entirely.
   */
  private async initializeSchema(): Promise<void> {
    // Create schema_versions table if it doesn't exist
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    // Always create core tables — IF NOT EXISTS makes this idempotent
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT 'claude',
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
      );

      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);

    // Record migration004 as applied (OR IGNORE handles re-runs safely)
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [4, new Date().toISOString()]);
  }

  /**
   * Ensure worker_port column exists (migration 5)
   *
   * NOTE: Version 5 conflicts with old DatabaseManager migration005 (which drops orphaned tables).
   * We check actual column state rather than relying solely on version tracking.
   */
  private async ensureWorkerPortColumn(): Promise<void> {
    // Check actual column existence — don't rely on version tracking alone (issue #979)
    const hasWorkerPort = await this.db.hasColumn('sdk_sessions', 'worker_port');
    if (!hasWorkerPort) {
      await this.db.run('ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER');
      logger.debug('DB', 'Added worker_port column to sdk_sessions table');
    }

    // Record migration
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [5, new Date().toISOString()]);
  }

  /**
   * Ensure prompt tracking columns exist (migration 6)
   *
   * NOTE: Version 6 conflicts with old DatabaseManager migration006 (which creates FTS5 tables).
   * We check actual column state rather than relying solely on version tracking.
   */
  private async ensurePromptTrackingColumns(): Promise<void> {
    // Check actual column existence — don't rely on version tracking alone (issue #979)
    // Check sdk_sessions for prompt_counter
    const hasPromptCounter = await this.db.hasColumn('sdk_sessions', 'prompt_counter');
    if (!hasPromptCounter) {
      await this.db.run('ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0');
      logger.debug('DB', 'Added prompt_counter column to sdk_sessions table');
    }

    // Check observations for prompt_number
    const obsHasPromptNumber = await this.db.hasColumn('observations', 'prompt_number');
    if (!obsHasPromptNumber) {
      await this.db.run('ALTER TABLE observations ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to observations table');
    }

    // Check session_summaries for prompt_number
    const sumHasPromptNumber = await this.db.hasColumn('session_summaries', 'prompt_number');
    if (!sumHasPromptNumber) {
      await this.db.run('ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to session_summaries table');
    }

    // Record migration
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [6, new Date().toISOString()]);
  }

  /**
   * Remove UNIQUE constraint from session_summaries.memory_session_id (migration 7)
   *
   * NOTE: Version 7 conflicts with old DatabaseManager migration007 (which adds discovery_tokens).
   * We check actual constraint state rather than relying solely on version tracking.
   */
  private async removeSessionSummariesUniqueConstraint(): Promise<void> {
    // Check actual constraint state — don't rely on version tracking alone (issue #979)
    let hasUniqueConstraint = false;
    try {
      const summariesIndexes = (await this.db.all('PRAGMA index_list(session_summaries)')) as IndexInfo[];
      hasUniqueConstraint = summariesIndexes.some(idx => idx.unique === 1 && idx.origin !== 'pk');
    } catch (e) {
      // If PRAGMA fails (e.g., MySQL), we assume no constraint exists because MySQL schema
      // is always created correctly via its init script without the buggy constraint.
    }
    if (!hasUniqueConstraint) {
      // Already migrated (no constraint exists)
      await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [7, new Date().toISOString()]);
      return;
    }
    logger.debug('DB', 'Removing UNIQUE constraint from session_summaries.memory_session_id');

    // Begin transaction
    await this.db.run('BEGIN TRANSACTION');

    // Clean up leftover temp table from a previously-crashed run
    await this.db.run('DROP TABLE IF EXISTS session_summaries_new');

    // Create new table without UNIQUE constraint
    await this.db.run(`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);

    // Copy data from old table
    await this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `);

    // Drop old table
    await this.db.run('DROP TABLE session_summaries');

    // Rename new table
    await this.db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');

    // Recreate indexes
    await this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);

    // Commit transaction
    await this.db.run('COMMIT');

    // Record migration
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [7, new Date().toISOString()]);
    logger.debug('DB', 'Successfully removed UNIQUE constraint from session_summaries.memory_session_id');
  }

  /**
   * Add hierarchical fields to observations table (migration 8)
   */
  private async addObservationHierarchicalFields(): Promise<void> {
    // Check if migration already applied
    const applied = (await this.db.get('SELECT version FROM schema_versions WHERE version = ?', [8])) as SchemaVersion | undefined;
    if (applied) return;

    // Check if new fields already exist
    const hasTitle = await this.db.hasColumn('observations', 'title');
    if (hasTitle) {
      // Already migrated
      await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [8, new Date().toISOString()]);
      return;
    }
    logger.debug('DB', 'Adding hierarchical fields to observations table');

    // Add new columns
    await this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `);

    // Record migration
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [8, new Date().toISOString()]);
    logger.debug('DB', 'Successfully added hierarchical fields to observations table');
  }

  /**
   * Make observations.text nullable (migration 9)
   * The text field is deprecated in favor of structured fields (title, subtitle, narrative, etc.)
   */
  private async makeObservationsTextNullable(): Promise<void> {
    // Check if migration already applied
    const applied = (await this.db.get('SELECT version FROM schema_versions WHERE version = ?', [9])) as SchemaVersion | undefined;
    if (applied) return;

    // Check if text column is already nullable
    let isNullable = true; // Assume nullable for unsupported dialects like MySQL
    const textExists = await this.db.hasColumn('observations', 'text');
    try {
      const tableInfo = (await this.db.all('PRAGMA table_info(observations)')) as TableColumnInfo[];
      const textColumn = tableInfo.find(col => col.name === 'text');
      if (textColumn) isNullable = textColumn.notnull === 0;
    } catch (e) {
      // Ignore errors if PRAGMA is not supported
    }
    
    if (!textExists || isNullable) {
      // Already migrated or text column doesn't exist
      await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [9, new Date().toISOString()]);
      return;
    }
    logger.debug('DB', 'Making observations.text nullable');

    // Begin transaction
    await this.db.run('BEGIN TRANSACTION');

    // Clean up leftover temp table from a previously-crashed run
    await this.db.run('DROP TABLE IF EXISTS observations_new');

    // Create new table with text as nullable
    await this.db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);

    // Copy data from old table (all existing columns)
    await this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `);

    // Drop old table
    await this.db.run('DROP TABLE observations');

    // Rename new table
    await this.db.run('ALTER TABLE observations_new RENAME TO observations');

    // Recreate indexes
    await this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `);

    // Commit transaction
    await this.db.run('COMMIT');

    // Record migration
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [9, new Date().toISOString()]);
    logger.debug('DB', 'Successfully made observations.text nullable');
  }

  /**
   * Create user_prompts table with FTS5 support (migration 10)
   */
  private async createUserPromptsTable(): Promise<void> {
    // Check if migration already applied
    const applied = (await this.db.get('SELECT version FROM schema_versions WHERE version = ?', [10])) as SchemaVersion | undefined;
    if (applied) return;

    // Check if table already exists
    const hasTable = await this.db.hasTable('user_prompts');
    if (hasTable) {
      // Already migrated
      await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [10, new Date().toISOString()]);
      return;
    }
    logger.debug('DB', 'Creating user_prompts table with FTS5 support');

    // Begin transaction
    await this.db.run('BEGIN TRANSACTION');

    // Create main table (using content_session_id since memory_session_id is set asynchronously by worker)
    await this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number);
    `);

    // Create FTS5 virtual table — skip if FTS5 is unavailable (e.g., Bun on Windows #791).
    // The user_prompts table itself is still created; only FTS indexing is skipped.
    try {
      await this.db.run(`
        CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
          prompt_text,
          content='user_prompts',
          content_rowid='id'
        );
      `);

      // Create triggers to sync FTS5
      await this.db.run(`
        CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END;

        CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
        END;

        CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END;
      `);
    } catch (ftsError) {
      logger.warn('DB', 'FTS5 not available — user_prompts_fts skipped (search uses ChromaDB)', {}, ftsError as Error);
    }

    // Commit transaction
    await this.db.run('COMMIT');

    // Record migration
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [10, new Date().toISOString()]);
    logger.debug('DB', 'Successfully created user_prompts table');
  }

  /**
   * Ensure discovery_tokens column exists (migration 11)
   * CRITICAL: This migration was incorrectly using version 7 (which was already taken by removeSessionSummariesUniqueConstraint)
   * The duplicate version number may have caused migration tracking issues in some databases
   */
  private async ensureDiscoveryTokensColumn(): Promise<void> {
    // Check if migration already applied to avoid unnecessary re-runs
    const applied = (await this.db.get('SELECT version FROM schema_versions WHERE version = ?', [11])) as SchemaVersion | undefined;
    if (applied) return;

    // Check if discovery_tokens column exists in observations table
    const obsHasDiscoveryTokens = await this.db.hasColumn('observations', 'discovery_tokens');
    if (!obsHasDiscoveryTokens) {
      await this.db.run('ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to observations table');
    }

    // Check if discovery_tokens column exists in session_summaries table
    const sumHasDiscoveryTokens = await this.db.hasColumn('session_summaries', 'discovery_tokens');
    if (!sumHasDiscoveryTokens) {
      await this.db.run('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to session_summaries table');
    }

    // Record migration only after successful column verification/addition
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [11, new Date().toISOString()]);
  }

  /**
   * Create pending_messages table for persistent work queue (migration 16)
   * Messages are persisted before processing and deleted after success.
   * Enables recovery from SDK hangs and worker crashes.
   */
  private async createPendingMessagesTable(): Promise<void> {
    // Check if migration already applied
    const applied = (await this.db.get('SELECT version FROM schema_versions WHERE version = ?', [16])) as SchemaVersion | undefined;
    if (applied) return;

    // Check if table already exists
    const hasTable = await this.db.hasTable('pending_messages');
    if (hasTable) {
      await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [16, new Date().toISOString()]);
      return;
    }
    logger.debug('DB', 'Creating pending_messages table');
    await this.db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);
    await this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)');
    await this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)');
    await this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)');
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [16, new Date().toISOString()]);
    logger.debug('DB', 'pending_messages table created successfully');
  }

  /**
   * Rename session ID columns for semantic clarity (migration 17)
   * - claude_session_id → content_session_id (user's observed session)
   * - sdk_session_id → memory_session_id (memory agent's session for resume)
   *
   * IDEMPOTENT: Checks each table individually before renaming.
   * This handles databases in any intermediate state (partial migration, fresh install, etc.)
   */
  private async renameSessionIdColumns(): Promise<void> {
    const applied = (await this.db.get('SELECT version FROM schema_versions WHERE version = ?', [17])) as SchemaVersion | undefined;
    if (applied) return;
    logger.debug('DB', 'Checking session ID columns for semantic clarity rename');
    let renamesPerformed = 0;

    // Helper to safely rename a column if it exists
    const safeRenameColumn = async (table: string, oldCol: string, newCol: string): Promise<boolean> => {
      const hasOldCol = await this.db.hasColumn(table, oldCol);
      const hasNewCol = await this.db.hasColumn(table, newCol);
      if (hasNewCol) {
        // Already renamed, nothing to do
        return false;
      }
      if (hasOldCol) {
        // SQLite 3.25+ supports ALTER TABLE RENAME COLUMN
        await this.db.run(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
        logger.debug('DB', `Renamed ${table}.${oldCol} to ${newCol}`);
        return true;
      }

      // Neither column exists - table might not exist or has different schema
      logger.warn('DB', `Column ${oldCol} not found in ${table}, skipping rename`);
      return false;
    };

    // Rename in sdk_sessions table
    if (await safeRenameColumn('sdk_sessions', 'claude_session_id', 'content_session_id')) renamesPerformed++;
    if (await safeRenameColumn('sdk_sessions', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    // Rename in pending_messages table
    if (await safeRenameColumn('pending_messages', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    // Rename in observations table
    if (await safeRenameColumn('observations', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    // Rename in session_summaries table
    if (await safeRenameColumn('session_summaries', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    // Rename in user_prompts table
    if (await safeRenameColumn('user_prompts', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    // Record migration
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [17, new Date().toISOString()]);
    if (renamesPerformed > 0) {
      logger.debug('DB', `Successfully renamed ${renamesPerformed} session ID columns`);
    } else {
      logger.debug('DB', 'No session ID column renames needed (already up to date)');
    }
  }

  /**
   * Repair session ID column renames (migration 19)
   * DEPRECATED: Migration 17 is now fully idempotent and handles all cases.
   * This migration is kept for backwards compatibility but does nothing.
   */
  private async repairSessionIdColumnRename(): Promise<void> {
    const applied = (await this.db.get('SELECT version FROM schema_versions WHERE version = ?', [19])) as SchemaVersion | undefined;
    if (applied) return;

    // Migration 17 now handles all column rename cases idempotently.
    // Just record this migration as applied.
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [19, new Date().toISOString()]);
  }

  /**
   * Add failed_at_epoch column to pending_messages (migration 20)
   * Used by markSessionMessagesFailed() for error recovery tracking
   */
  private async addFailedAtEpochColumn(): Promise<void> {
    const applied = (await this.db.get('SELECT version FROM schema_versions WHERE version = ?', [20])) as SchemaVersion | undefined;
    if (applied) return;
    const hasColumn = await this.db.hasColumn('pending_messages', 'failed_at_epoch');
    if (!hasColumn) {
      await this.db.run('ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER');
      logger.debug('DB', 'Added failed_at_epoch column to pending_messages table');
    }
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [20, new Date().toISOString()]);
  }

  /**
   * Add ON UPDATE CASCADE to FK constraints on observations and session_summaries (migration 21)
   *
   * Both tables have FK(memory_session_id) -> sdk_sessions(memory_session_id) with ON DELETE CASCADE
   * but missing ON UPDATE CASCADE. This causes FK constraint violations when code updates
   * sdk_sessions.memory_session_id while child rows still reference the old value.
   *
   * SQLite doesn't support ALTER TABLE for FK changes, so we recreate both tables.
   */
  private async addOnUpdateCascadeToForeignKeys(): Promise<void> {
    const applied = (await this.db.get('SELECT version FROM schema_versions WHERE version = ?', [21])) as SchemaVersion | undefined;
    if (applied) return;
    logger.debug('DB', 'Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries');

    // PRAGMA foreign_keys must be set outside a transaction
    await this.db.run('PRAGMA foreign_keys = OFF');
    await this.db.run('BEGIN TRANSACTION');
    try {
      // ==========================================
      // 1. Recreate observations table
      // ==========================================

      // Drop FTS triggers first (they reference the observations table)
      await this.db.run('DROP TRIGGER IF EXISTS observations_ai');
      await this.db.run('DROP TRIGGER IF EXISTS observations_ad');
      await this.db.run('DROP TRIGGER IF EXISTS observations_au');

      // Clean up leftover temp table from a previously-crashed run
      await this.db.run('DROP TABLE IF EXISTS observations_new');
      await this.db.run(`
        CREATE TABLE observations_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          text TEXT,
          type TEXT NOT NULL,
          title TEXT,
          subtitle TEXT,
          facts TEXT,
          narrative TEXT,
          concepts TEXT,
          files_read TEXT,
          files_modified TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `);
      await this.db.run(`
        INSERT INTO observations_new
        SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
               narrative, concepts, files_read, files_modified, prompt_number,
               discovery_tokens, created_at, created_at_epoch
        FROM observations
      `);
      await this.db.run('DROP TABLE observations');
      await this.db.run('ALTER TABLE observations_new RENAME TO observations');

      // Recreate indexes
      await this.db.run(`
        CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
        CREATE INDEX idx_observations_project ON observations(project);
        CREATE INDEX idx_observations_type ON observations(type);
        CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
      `);

      // Recreate FTS triggers only if observations_fts exists
      // (SessionSearch.ensureFTSTables creates it on first use with IF NOT EXISTS)
      const hasFTS = ((await this.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'")) as {
        name: string;
      }[]).length > 0;
      if (hasFTS) {
        await this.db.run(`
          CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END;

          CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
          END;

          CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END;
        `);
      }

      // ==========================================
      // 2. Recreate session_summaries table
      // ==========================================

      // Clean up leftover temp table from a previously-crashed run
      await this.db.run('DROP TABLE IF EXISTS session_summaries_new');
      await this.db.run(`
        CREATE TABLE session_summaries_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
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
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `);
      await this.db.run(`
        INSERT INTO session_summaries_new
        SELECT id, memory_session_id, project, request, investigated, learned,
               completed, next_steps, files_read, files_edited, notes,
               prompt_number, discovery_tokens, created_at, created_at_epoch
        FROM session_summaries
      `);

      // Drop session_summaries FTS triggers before dropping the table
      await this.db.run('DROP TRIGGER IF EXISTS session_summaries_ai');
      await this.db.run('DROP TRIGGER IF EXISTS session_summaries_ad');
      await this.db.run('DROP TRIGGER IF EXISTS session_summaries_au');
      await this.db.run('DROP TABLE session_summaries');
      await this.db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');

      // Recreate indexes
      await this.db.run(`
        CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
        CREATE INDEX idx_session_summaries_project ON session_summaries(project);
        CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
      `);

      // Recreate session_summaries FTS triggers if FTS table exists
      const hasSummariesFTS = ((await this.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'")) as {
        name: string;
      }[]).length > 0;
      if (hasSummariesFTS) {
        await this.db.run(`
          CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
            INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
          END;

          CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
            INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
          END;

          CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
            INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
            INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
          END;
        `);
      }

      // Record migration
      await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [21, new Date().toISOString()]);
      await this.db.run('COMMIT');
      await this.db.run('PRAGMA foreign_keys = ON');
      logger.debug('DB', 'Successfully added ON UPDATE CASCADE to FK constraints');
    } catch (error) {
      await this.db.run('ROLLBACK');
      await this.db.run('PRAGMA foreign_keys = ON');
      throw error;
    }
  }

  /**
   * Add content_hash column to observations for deduplication (migration 22)
   */
  private async addObservationContentHashColumn(): Promise<void> {
    // Check actual schema first — cross-machine DB sync can leave schema_versions
    // claiming this migration ran while the column is actually missing.
    const hasColumn = await this.db.hasColumn('observations', 'content_hash');
    if (hasColumn) {
      await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [22, new Date().toISOString()]);
      return;
    }
    await this.db.run('ALTER TABLE observations ADD COLUMN content_hash TEXT');
    await this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL");
    await this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)');
    logger.debug('DB', 'Added content_hash column to observations table with backfill and index');
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [22, new Date().toISOString()]);
  }

  /**
   * Add custom_title column to sdk_sessions for agent attribution (migration 23)
   */
  private async addSessionCustomTitleColumn(): Promise<void> {
    const applied = (await this.db.get('SELECT version FROM schema_versions WHERE version = ?', [23])) as SchemaVersion | undefined;
    if (applied) return;
    const hasColumn = await this.db.hasColumn('sdk_sessions', 'custom_title');
    if (!hasColumn) {
      await this.db.run('ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT');
      logger.debug('DB', 'Added custom_title column to sdk_sessions table');
    }
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [23, new Date().toISOString()]);
  }

  /**
   * Add platform_source column to sdk_sessions for Claude/Codex isolation (migration 24)
   */
  private async addSessionPlatformSourceColumn(): Promise<void> {
    const hasColumn = await this.db.hasColumn('sdk_sessions', 'platform_source');
    const hasIndex = await this.db.hasIndex('sdk_sessions', 'idx_sdk_sessions_platform_source');
    const applied = (await this.db.get('SELECT version FROM schema_versions WHERE version = ?', [24])) as SchemaVersion | undefined;
    if (applied && hasColumn && hasIndex) return;
    if (!hasColumn) {
      await this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${DEFAULT_PLATFORM_SOURCE}'`);
      logger.debug('DB', 'Added platform_source column to sdk_sessions table');
    }
    await this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${DEFAULT_PLATFORM_SOURCE}'
      WHERE platform_source IS NULL OR platform_source = ''
    `);
    if (!hasIndex) {
      await this.db.run('CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)');
    }
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [24, new Date().toISOString()]);
  }

  /**
   * Add generated_by_model and relevance_count columns to observations (migration 26)
   *
   * Note: Cannot trust schema_versions alone — the old MigrationRunner may have
   * recorded version 26 without the ALTER TABLE actually succeeding. Always
   * check column existence directly.
   */
  private async addObservationModelColumns(): Promise<void> {
    const hasGeneratedByModel = await this.db.hasColumn('observations', 'generated_by_model');
    const hasRelevanceCount = await this.db.hasColumn('observations', 'relevance_count');
    if (hasGeneratedByModel && hasRelevanceCount) return;
    if (!hasGeneratedByModel) {
      await this.db.run('ALTER TABLE observations ADD COLUMN generated_by_model TEXT');
    }
    if (!hasRelevanceCount) {
      await this.db.run('ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0');
    }
    await this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [26, new Date().toISOString()]);
  }

  /**
   * Update the memory session ID for a session
   * Called by SDKAgent when it captures the session ID from the first SDK message
   * Also used to RESET to null on stale resume failures (worker-service.ts)
   */
  async updateMemorySessionId(sessionDbId: number, memorySessionId: string | null): Promise<void> {
    await this.db.run(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `, [memorySessionId, sessionDbId]);
  }
  async markSessionCompleted(sessionDbId: number): Promise<void> {
    const nowEpoch = Date.now();
    const nowIso = new Date(nowEpoch).toISOString();
    await this.db.run(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `, [nowIso, nowEpoch, sessionDbId]);
  }

  /**
   * Ensures memory_session_id is registered in sdk_sessions before FK-constrained INSERT.
   * This fixes Issue #846 where observations fail after worker restart because the
   * SDK generates a new memory_session_id but it's not registered in the parent table
   * before child records try to reference it.
   *
   * @param sessionDbId - The database ID of the session
   * @param memorySessionId - The memory session ID to ensure is registered
   */
  async ensureMemorySessionIdRegistered(sessionDbId: number, memorySessionId: string): Promise<void> {
    const session = (await this.db.get(`
      SELECT id, memory_session_id FROM sdk_sessions WHERE id = ?
    `, [sessionDbId])) as {
      id: number;
      memory_session_id: string | null;
    } | undefined;
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found in sdk_sessions`);
    }
    if (session.memory_session_id !== memorySessionId) {
      await this.db.run(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `, [memorySessionId, sessionDbId]);
      logger.info('DB', 'Registered memory_session_id before storage (FK fix)', {
        sessionDbId,
        oldId: session.memory_session_id,
        newId: memorySessionId
      });
    }
  }

  /**
   * Get recent session summaries for a project
   */
  async getRecentSummaries(project: string, limit: number = 10): Promise<Array<{
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    created_at: string;
  }>> {
    return await this.db.all(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `, [project, limit]);
  }

  /**
   * Get recent summaries with session info for context display
   */
  async getRecentSummariesWithSessionInfo(project: string, limit: number = 3): Promise<Array<{
    memory_session_id: string;
    request: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    prompt_number: number | null;
    created_at: string;
  }>> {
    return await this.db.all(`
      SELECT
        memory_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `, [project, limit]);
  }

  /**
   * Get recent observations for a project
   */
  async getRecentObservations(project: string, limit: number = 20): Promise<Array<{
    type: string;
    text: string;
    prompt_number: number | null;
    created_at: string;
  }>> {
    return await this.db.all(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `, [project, limit]);
  }

  /**
   * Get recent observations across all projects (for web UI)
   */
  async getAllRecentObservations(limit: number = 100): Promise<Array<{
    id: number;
    type: string;
    title: string | null;
    subtitle: string | null;
    text: string;
    project: string;
    platform_source: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }>> {
    return await this.db.all(`
      SELECT
        o.id,
        o.type,
        o.title,
        o.subtitle,
        o.text,
        o.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        o.prompt_number,
        o.created_at,
        o.created_at_epoch
      FROM observations o
      LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `, [limit]);
  }

  /**
   * Get recent summaries across all projects (for web UI)
   */
  async getAllRecentSummaries(limit: number = 50): Promise<Array<{
    id: number;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    project: string;
    platform_source: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }>> {
    return await this.db.all(`
      SELECT
        ss.id,
        ss.request,
        ss.investigated,
        ss.learned,
        ss.completed,
        ss.next_steps,
        ss.files_read,
        ss.files_edited,
        ss.notes,
        ss.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        ss.prompt_number,
        ss.created_at,
        ss.created_at_epoch
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
      ORDER BY ss.created_at_epoch DESC
      LIMIT ?
    `, [limit]);
  }

  /**
   * Get recent user prompts across all sessions (for web UI)
   */
  async getAllRecentUserPrompts(limit: number = 100): Promise<Array<{
    id: number;
    content_session_id: string;
    project: string;
    platform_source: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }>> {
    return await this.db.all(`
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `, [limit]);
  }

  /**
   * Get all unique projects from the database (for web UI project filter)
   */
  async getAllProjects(platformSource?: string): Promise<string[]> {
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : undefined;
    let query = `
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
    `;
    const params: unknown[] = [];
    if (normalizedPlatformSource) {
      query += ' AND COALESCE(platform_source, ?) = ?';
      params.push(DEFAULT_PLATFORM_SOURCE, normalizedPlatformSource);
    }
    query += ' ORDER BY project ASC';
    const rows = (await this.db.all(query, [...params])) as Array<{
      project: string;
    }>;
    return rows.map(row => row.project);
  }
  async getProjectCatalog(): Promise<{
    projects: string[];
    sources: string[];
    projectsBySource: Record<string, string[]>;
  }> {
    const rows = (await this.db.all(`
      SELECT
        COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
      GROUP BY COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}'), project
      ORDER BY latest_epoch DESC
    `)) as Array<{
      platform_source: string;
      project: string;
      latest_epoch: number;
    }>;
    const projects: string[] = [];
    const seenProjects = new Set<string>();
    const projectsBySource: Record<string, string[]> = {};
    for (const row of rows) {
      const source = normalizePlatformSource(row.platform_source);
      if (!projectsBySource[source]) {
        projectsBySource[source] = [];
      }
      if (!projectsBySource[source].includes(row.project)) {
        projectsBySource[source].push(row.project);
      }
      if (!seenProjects.has(row.project)) {
        seenProjects.add(row.project);
        projects.push(row.project);
      }
    }
    const sources = sortPlatformSources(Object.keys(projectsBySource));
    return {
      projects,
      sources,
      projectsBySource: Object.fromEntries(sources.map(source => [source, projectsBySource[source] || []]))
    };
  }

  /**
   * Get latest user prompt with session info for a Claude session
   * Used for syncing prompts to Chroma during session initialization
   */
  async getLatestUserPrompt(contentSessionId: string): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  } | undefined> {
    return (await this.db.get(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.content_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `, [contentSessionId])) as LatestPromptResult | undefined;
  }

  /**
   * Get recent sessions with their status and summary info
   */
  async getRecentSessionsWithStatus(project: string, limit: number = 3): Promise<Array<{
    memory_session_id: string | null;
    status: string;
    started_at: string;
    user_prompt: string | null;
    has_summary: boolean;
  }>> {
    return await this.db.all(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
        WHERE s.project = ? AND s.memory_session_id IS NOT NULL
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `, [project, limit]);
  }

  /**
   * Get observations for a specific session
   */
  async getObservationsForSession(memorySessionId: string): Promise<Array<{
    title: string;
    subtitle: string;
    type: string;
    prompt_number: number | null;
  }>> {
    return await this.db.all(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch ASC
    `, [memorySessionId]);
  }

  /**
   * Get a single observation by ID
   */
  async getObservationById(id: number): Promise<ObservationRecord | null> {
    return (await this.db.get(`
      SELECT *
      FROM observations
      WHERE id = ?
    `, [id])) as ObservationRecord | undefined || null;
  }

  /**
   * Get observations by array of IDs with ordering and limit
   */
  async getObservationsByIds(ids: number[], options: {
    orderBy?: 'date_desc' | 'date_asc';
    limit?: number;
    project?: string;
    type?: string | string[];
    concepts?: string | string[];
    files?: string | string[];
  } = {}): Promise<ObservationRecord[]> {
    if (ids.length === 0) return [];
    const {
      orderBy = 'date_desc',
      limit,
      project,
      type,
      concepts,
      files
    } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';

    // Build placeholders for IN clause
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    const additionalConditions: string[] = [];

    // Apply project filter
    if (project) {
      additionalConditions.push('project = ?');
      params.push(project);
    }

    // Apply type filter
    if (type) {
      if (Array.isArray(type)) {
        const typePlaceholders = type.map(() => '?').join(',');
        additionalConditions.push(`type IN (${typePlaceholders})`);
        params.push(...type);
      } else {
        additionalConditions.push('type = ?');
        params.push(type);
      }
    }

    // Apply concepts filter
    if (concepts) {
      const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
      const conceptConditions = conceptsList.map(() => 'EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)');
      params.push(...conceptsList);
      additionalConditions.push(`(${conceptConditions.join(' OR ')})`);
    }

    // Apply files filter
    if (files) {
      const filesList = Array.isArray(files) ? files : [files];
      const fileConditions = filesList.map(() => {
        return '(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))';
      });
      filesList.forEach(file => {
        params.push(`%${file}%`, `%${file}%`);
      });
      additionalConditions.push(`(${fileConditions.join(' OR ')})`);
    }
    const whereClause = additionalConditions.length > 0 ? `WHERE id IN (${placeholders}) AND ${additionalConditions.join(' AND ')}` : `WHERE id IN (${placeholders})`;
    return (await this.db.all(`
      SELECT *
      FROM observations
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `, [...params])) as ObservationRecord[];
  }

  /**
   * Get summary for a specific session
   */
  async getSummaryForSession(memorySessionId: string): Promise<{
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  } | null> {
    return (await this.db.get(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `, [memorySessionId])) || null;
  }

  /**
   * Get aggregated files from all observations for a session
   */
  async getFilesForSession(memorySessionId: string): Promise<{
    filesRead: string[];
    filesModified: string[];
  }> {
    const rows = (await this.db.all(`
      SELECT files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `, [memorySessionId])) as Array<{
      files_read: string | null;
      files_modified: string | null;
    }>;
    const filesReadSet = new Set<string>();
    const filesModifiedSet = new Set<string>();
    for (const row of rows) {
      // Parse files_read
      parseFileList(row.files_read).forEach(f => filesReadSet.add(f));

      // Parse files_modified
      parseFileList(row.files_modified).forEach(f => filesModifiedSet.add(f));
    }
    return {
      filesRead: Array.from(filesReadSet),
      filesModified: Array.from(filesModifiedSet)
    };
  }

  /**
   * Get session by ID
   */
  async getSessionById(id: number): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
  } | null> {
    return (await this.db.get(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
             user_prompt, custom_title
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `, [id])) || null;
  }

  /**
   * Get SDK sessions by SDK session IDs
   * Used for exporting session metadata
   */
  async getSdkSessionsBySessionIds(memorySessionIds: string[]): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }[]> {
    if (memorySessionIds.length === 0) return [];
    const placeholders = memorySessionIds.map(() => '?').join(',');
    return (await this.db.all(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${placeholders})
      ORDER BY started_at_epoch DESC
    `, [...memorySessionIds])) as any[];
  }

  /**
   * Get current prompt number by counting user_prompts for this session
   * Replaces the prompt_counter column which is no longer maintained
   */
  async getPromptNumberFromUserPrompts(contentSessionId: string): Promise<number> {
    const result = (await this.db.get(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `, [contentSessionId])) as {
      count: number;
    };
    return result.count;
  }

  /**
   * Create a new SDK session (idempotent - returns existing session ID if already exists)
   *
   * CRITICAL ARCHITECTURE: Session ID Threading
   * ============================================
   * This function is the KEY to how claude-mem stays unified across hooks:
   *
   * - NEW hook calls: createSDKSession(session_id, project, prompt)
   * - SAVE hook calls: createSDKSession(session_id, '', '')
   * - Both use the SAME session_id from Claude Code's hook context
   *
   * IDEMPOTENT BEHAVIOR (INSERT OR IGNORE):
   * - Prompt #1: session_id not in database → INSERT creates new row
   * - Prompt #2+: session_id exists → INSERT ignored, fetch existing ID
   * - Result: Same database ID returned for all prompts in conversation
   *
   * Pure get-or-create: never modifies memory_session_id.
   * Multi-terminal isolation is handled by ON UPDATE CASCADE at the schema level.
   */
  async createSDKSession(contentSessionId: string, project: string, userPrompt: string, customTitle?: string, platformSource?: string): Promise<number> {
    const now = new Date();
    const nowEpoch = now.getTime();
    const resolved = resolveCreateSessionArgs(customTitle, platformSource);
    const normalizedPlatformSource = resolved.platformSource ?? DEFAULT_PLATFORM_SOURCE;

    // Session reuse: Return existing session ID if already created for this contentSessionId.
    const existing = (await this.db.get(`
      SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
    `, [contentSessionId])) as {
      id: number;
      platform_source: string | null;
    } | undefined;
    if (existing) {
      // Backfill project if session was created by another hook with empty project
      if (project) {
        await this.db.run(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `, [project, contentSessionId]);
      }
      // Backfill custom_title if provided and not yet set
      if (resolved.customTitle) {
        await this.db.run(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `, [resolved.customTitle, contentSessionId]);
      }
      if (resolved.platformSource) {
        const storedPlatformSource = existing.platform_source?.trim() ? normalizePlatformSource(existing.platform_source) : undefined;
        if (!storedPlatformSource) {
          await this.db.run(`
            UPDATE sdk_sessions SET platform_source = ?
            WHERE content_session_id = ?
              AND COALESCE(platform_source, '') = ''
          `, [resolved.platformSource, contentSessionId]);
        } else if (storedPlatformSource !== resolved.platformSource) {
          throw new Error(`Platform source conflict for session ${contentSessionId}: existing=${storedPlatformSource}, received=${resolved.platformSource}`);
        }
      }
      return existing.id;
    }

    // New session - insert fresh row
    // NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
    // response and stored via ensureMemorySessionIdRegistered(). CRITICAL: memory_session_id
    // must NEVER equal contentSessionId - that would inject memory messages into the user's transcript!
    await this.db.run(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `, [contentSessionId, project, normalizedPlatformSource, userPrompt, resolved.customTitle || null, now.toISOString(), nowEpoch]);

    // Return new ID
    const row = (await this.db.get('SELECT id FROM sdk_sessions WHERE content_session_id = ?', [contentSessionId])) as {
      id: number;
    };
    return row.id;
  }

  /**
   * Save a user prompt
   */
  async saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string): Promise<number> {
    const now = new Date();
    const nowEpoch = now.getTime();
    const result = await this.db.run(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `, [contentSessionId, promptNumber, promptText, now.toISOString(), nowEpoch]);
    return result.lastInsertRowid as number;
  }

  /**
   * Get user prompt by session ID and prompt number
   * Returns the prompt text, or null if not found
   */
  async getUserPrompt(contentSessionId: string, promptNumber: number): Promise<string | null> {
    const result = (await this.db.get(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `, [contentSessionId, promptNumber])) as {
      prompt_text: string;
    } | undefined;
    return result?.prompt_text ?? null;
  }

  /**
   * Store an observation (from SDK parsing)
   * Assumes session already exists (created by hook)
   * Performs content-hash deduplication: skips INSERT if an identical observation exists within 30s
   */
  async storeObservation(memorySessionId: string, project: string, observation: {
    type: string;
    title: string | null;
    subtitle: string | null;
    facts: string[];
    narrative: string | null;
    concepts: string[];
    files_read: string[];
    files_modified: string[];
  }, promptNumber?: number, discoveryTokens: number = 0, overrideTimestampEpoch?: number, generatedByModel?: string): Promise<{
    id: number;
    createdAtEpoch: number;
  }> {
    // Use override timestamp if provided (for processing backlog messages with original timestamps)
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    // Content-hash deduplication
    const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
    const existing = await findDuplicateObservation(this.db, contentHash, timestampEpoch);
    if (existing) {
      return {
        id: existing.id,
        createdAtEpoch: existing.created_at_epoch
      };
    }
    const result = await this.db.run(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
       generated_by_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [memorySessionId, project, observation.type, observation.title, observation.subtitle, JSON.stringify(observation.facts), observation.narrative, JSON.stringify(observation.concepts), JSON.stringify(observation.files_read), JSON.stringify(observation.files_modified), promptNumber || null, discoveryTokens, contentHash, timestampIso, timestampEpoch, generatedByModel || null]);
    return {
      id: Number(result.lastInsertRowid),
      createdAtEpoch: timestampEpoch
    };
  }

  /**
   * Store a session summary (from SDK parsing)
   * Assumes session already exists - will fail with FK error if not
   */
  async storeSummary(memorySessionId: string, project: string, summary: {
    request: string;
    investigated: string;
    learned: string;
    completed: string;
    next_steps: string;
    notes: string | null;
  }, promptNumber?: number, discoveryTokens: number = 0, overrideTimestampEpoch?: number): Promise<{
    id: number;
    createdAtEpoch: number;
  }> {
    // Use override timestamp if provided (for processing backlog messages with original timestamps)
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();
    const result = await this.db.run(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [memorySessionId, project, summary.request, summary.investigated, summary.learned, summary.completed, summary.next_steps, summary.notes, promptNumber || null, discoveryTokens, timestampIso, timestampEpoch]);
    return {
      id: Number(result.lastInsertRowid),
      createdAtEpoch: timestampEpoch
    };
  }

  /**
   * ATOMIC: Store observations + summary (no message tracking)
   *
   * Simplified version for use with claim-and-delete queue pattern.
   * Messages are deleted from queue immediately on claim, so there's no
   * message completion to track. This just stores observations and summary.
   *
   * @param memorySessionId - SDK memory session ID
   * @param project - Project name
   * @param observations - Array of observations to store (can be empty)
   * @param summary - Optional summary to store
   * @param promptNumber - Optional prompt number
   * @param discoveryTokens - Discovery tokens count
   * @param overrideTimestampEpoch - Optional override timestamp
   * @returns Object with observation IDs, optional summary ID, and timestamp
   */
  async storeObservations(memorySessionId: string, project: string, observations: Array<{
    type: string;
    title: string | null;
    subtitle: string | null;
    facts: string[];
    narrative: string | null;
    concepts: string[];
    files_read: string[];
    files_modified: string[];
  }>, summary: {
    request: string;
    investigated: string;
    learned: string;
    completed: string;
    next_steps: string;
    notes: string | null;
  } | null, promptNumber?: number, discoveryTokens: number = 0, overrideTimestampEpoch?: number, generatedByModel?: string): Promise<{
    observationIds: number[];
    summaryId: number | null;
    createdAtEpoch: number;
  }> {
    // Use override timestamp if provided
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    // Create transaction that wraps all operations
    return await this.db.transaction(async (txDb) => {
      const observationIds: number[] = [];

      // 1. Store all observations (with content-hash deduplication)

      for (const observation of observations) {
        // Content-hash deduplication (same logic as storeObservation singular)
        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const existing = await findDuplicateObservation(txDb, contentHash, timestampEpoch);
        if (existing) {
          observationIds.push(existing.id);
          continue;
        }
        const result = await txDb.run(`
          INSERT INTO observations
          (memory_session_id, project, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch, generated_by_model)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [memorySessionId, project, observation.type, observation.title, observation.subtitle, JSON.stringify(observation.facts), observation.narrative, JSON.stringify(observation.concepts), JSON.stringify(observation.files_read), JSON.stringify(observation.files_modified), promptNumber || null, discoveryTokens, contentHash, timestampIso, timestampEpoch, generatedByModel || null]);
        observationIds.push(Number(result.lastInsertRowid));
      }

      // 2. Store summary if provided
      let summaryId: number | null = null;
      if (summary) {
        const result = await txDb.run(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [memorySessionId, project, summary.request, summary.investigated, summary.learned, summary.completed, summary.next_steps, summary.notes, promptNumber || null, discoveryTokens, timestampIso, timestampEpoch]);
        summaryId = Number(result.lastInsertRowid);
      }
      return {
        observationIds,
        summaryId,
        createdAtEpoch: timestampEpoch
      };
    });
  }

  /**
   * @deprecated Use storeObservations instead. This method is kept for backwards compatibility.
   *
   * ATOMIC: Store observations + summary + mark pending message as processed
   *
   * This method wraps observation storage, summary storage, and message completion
   * in a single database transaction to prevent race conditions. If the worker crashes
   * during processing, either all operations succeed together or all fail together.
   *
   * This fixes the observation duplication bug where observations were stored but
   * the message wasn't marked complete, causing reprocessing on crash recovery.
   *
   * @param memorySessionId - SDK memory session ID
   * @param project - Project name
   * @param observations - Array of observations to store (can be empty)
   * @param summary - Optional summary to store
   * @param messageId - Pending message ID to mark as processed
   * @param pendingStore - PendingMessageStore instance for marking complete
   * @param promptNumber - Optional prompt number
   * @param discoveryTokens - Discovery tokens count
   * @param overrideTimestampEpoch - Optional override timestamp
   * @returns Object with observation IDs, optional summary ID, and timestamp
   */
  async storeObservationsAndMarkComplete(memorySessionId: string, project: string, observations: Array<{
    type: string;
    title: string | null;
    subtitle: string | null;
    facts: string[];
    narrative: string | null;
    concepts: string[];
    files_read: string[];
    files_modified: string[];
  }>, summary: {
    request: string;
    investigated: string;
    learned: string;
    completed: string;
    next_steps: string;
    notes: string | null;
  } | null, messageId: number, _pendingStore: PendingMessageStore, promptNumber?: number, discoveryTokens: number = 0, overrideTimestampEpoch?: number, generatedByModel?: string): Promise<{
    observationIds: number[];
    summaryId?: number;
    createdAtEpoch: number;
  }> {
    // Use override timestamp if provided
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    // Create transaction that wraps all operations
    return await this.db.transaction(async (txDb) => {
      const observationIds: number[] = [];

      // 1. Store all observations (with content-hash deduplication)

      for (const observation of observations) {
        // Content-hash deduplication (same logic as storeObservation singular)
        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const existing = await findDuplicateObservation(txDb, contentHash, timestampEpoch);
        if (existing) {
          observationIds.push(existing.id);
          continue;
        }
        const result = await txDb.run(`
          INSERT INTO observations
          (memory_session_id, project, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch, generated_by_model)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [memorySessionId, project, observation.type, observation.title, observation.subtitle, JSON.stringify(observation.facts), observation.narrative, JSON.stringify(observation.concepts), JSON.stringify(observation.files_read), JSON.stringify(observation.files_modified), promptNumber || null, discoveryTokens, contentHash, timestampIso, timestampEpoch, generatedByModel || null]);
        observationIds.push(Number(result.lastInsertRowid));
      }

      // 2. Store summary if provided
      let summaryId: number | undefined;
      if (summary) {
        const result = await txDb.run(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [memorySessionId, project, summary.request, summary.investigated, summary.learned, summary.completed, summary.next_steps, summary.notes, promptNumber || null, discoveryTokens, timestampIso, timestampEpoch]);
        summaryId = Number(result.lastInsertRowid);
      }

      // 3. Mark pending message as processed
      // This UPDATE is part of the same transaction, so if it fails,
      // observations and summary will be rolled back

      await txDb.run(`
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `, [timestampEpoch, messageId]);
      return {
        observationIds,
        summaryId,
        createdAtEpoch: timestampEpoch
      };
    });
  }

  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // There's no such thing as an "orphaned" session. Sessions are created by hooks
  // and managed by Claude Code's lifecycle. Worker restarts don't invalidate them.
  // Marking all active sessions as 'failed' on startup destroys the user's current work.

  /**
   * Get session summaries by IDs (for hybrid Chroma search)
   * Returns summaries in specified temporal order
   */
  async getSessionSummariesByIds(ids: number[], options: {
    orderBy?: 'date_desc' | 'date_asc';
    limit?: number;
    project?: string;
  } = {}): Promise<SessionSummaryRecord[]> {
    if (ids.length === 0) return [];
    const {
      orderBy = 'date_desc',
      limit,
      project
    } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    // Apply project filter
    const whereClause = project ? `WHERE id IN (${placeholders}) AND project = ?` : `WHERE id IN (${placeholders})`;
    if (project) params.push(project);
    return (await this.db.all(`
      SELECT * FROM session_summaries
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `, [...params])) as SessionSummaryRecord[];
  }

  /**
   * Get user prompts by IDs (for hybrid Chroma search)
   * Returns prompts in specified temporal order
   */
  async getUserPromptsByIds(ids: number[], options: {
    orderBy?: 'date_desc' | 'date_asc';
    limit?: number;
    project?: string;
  } = {}): Promise<UserPromptRecord[]> {
    if (ids.length === 0) return [];
    const {
      orderBy = 'date_desc',
      limit,
      project
    } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    // Apply project filter
    const projectFilter = project ? 'AND s.project = ?' : '';
    if (project) params.push(project);
    return (await this.db.all(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${placeholders}) ${projectFilter}
      ORDER BY up.created_at_epoch ${orderClause}
      ${limitClause}
    `, [...params])) as UserPromptRecord[];
  }

  /**
   * Get a unified timeline of all records (observations, sessions, prompts) around an anchor point
   * @param anchorEpoch The anchor timestamp (epoch milliseconds)
   * @param depthBefore Number of records to retrieve before anchor (any type)
   * @param depthAfter Number of records to retrieve after anchor (any type)
   * @param project Optional project filter
   * @returns Object containing observations, sessions, and prompts for the specified window
   */
  async getTimelineAroundTimestamp(anchorEpoch: number, depthBefore: number = 10, depthAfter: number = 10, project?: string): Promise<{
    observations: any[];
    sessions: any[];
    prompts: any[];
  }> {
    return this.getTimelineAroundObservation(null, anchorEpoch, depthBefore, depthAfter, project);
  }

  /**
   * Get timeline around a specific observation ID
   * Uses observation ID offsets to determine time boundaries, then fetches all record types in that window
   */
  async getTimelineAroundObservation(anchorObservationId: number | null, anchorEpoch: number, depthBefore: number = 10, depthAfter: number = 10, project?: string): Promise<{
    observations: any[];
    sessions: any[];
    prompts: any[];
  }> {
    const projectFilter = project ? 'AND project = ?' : '';
    const projectParams = project ? [project] : [];
    let startEpoch: number;
    let endEpoch: number;
    if (anchorObservationId !== null) {
      // Get boundary observations by ID offset
      const beforeQuery = `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${projectFilter}
        ORDER BY id DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${projectFilter}
        ORDER BY id ASC
        LIMIT ?
      `;
      try {
        const beforeRecords = (await this.db.all(beforeQuery, [anchorObservationId, ...projectParams, depthBefore + 1])) as Array<{
          id: number;
          created_at_epoch: number;
        }>;
        const afterRecords = (await this.db.all(afterQuery, [anchorObservationId, ...projectParams, depthAfter + 1])) as Array<{
          id: number;
          created_at_epoch: number;
        }>;

        // Get the earliest and latest timestamps from boundary observations
        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return {
            observations: [],
            sessions: [],
            prompts: []
          };
        }
        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err: any) {
        logger.error('DB', 'Error getting boundary observations', undefined, {
          error: err,
          project
        });
        return {
          observations: [],
          sessions: [],
          prompts: []
        };
      }
    } else {
      // For timestamp-based anchors, use time-based boundaries
      // Get observations to find the time window
      const beforeQuery = `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${projectFilter}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${projectFilter}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;
      try {
        const beforeRecords = (await this.db.all(beforeQuery, [anchorEpoch, ...projectParams, depthBefore])) as Array<{
          created_at_epoch: number;
        }>;
        const afterRecords = (await this.db.all(afterQuery, [anchorEpoch, ...projectParams, depthAfter + 1])) as Array<{
          created_at_epoch: number;
        }>;
        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return {
            observations: [],
            sessions: [],
            prompts: []
          };
        }
        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err: any) {
        logger.error('DB', 'Error getting boundary timestamps', undefined, {
          error: err,
          project
        });
        return {
          observations: [],
          sessions: [],
          prompts: []
        };
      }
    }

    // Now query ALL record types within the time window
    const obsQuery = `
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
    `;
    const sessQuery = `
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
    `;
    const promptQuery = `
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${projectFilter.replace('project', 's.project')}
      ORDER BY up.created_at_epoch ASC
    `;
    const observations = (await this.db.all(obsQuery, [startEpoch, endEpoch, ...projectParams])) as ObservationRecord[];
    const sessions = (await this.db.all(sessQuery, [startEpoch, endEpoch, ...projectParams])) as SessionSummaryRecord[];
    const prompts = (await this.db.all(promptQuery, [startEpoch, endEpoch, ...projectParams])) as UserPromptRecord[];
    return {
      observations,
      sessions: sessions.map(s => ({
        id: s.id,
        memory_session_id: s.memory_session_id,
        project: s.project,
        request: s.request,
        completed: s.completed,
        next_steps: s.next_steps,
        created_at: s.created_at,
        created_at_epoch: s.created_at_epoch
      })),
      prompts: prompts.map(p => ({
        id: p.id,
        content_session_id: p.content_session_id,
        prompt_number: p.prompt_number,
        prompt_text: p.prompt_text,
        project: p.project,
        created_at: p.created_at,
        created_at_epoch: p.created_at_epoch
      }))
    };
  }

  /**
   * Get a single user prompt by ID
   */
  async getPromptById(id: number): Promise<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  } | null> {
    return (await this.db.get(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id = ?
      LIMIT 1
    `, [id])) || null;
  }

  /**
   * Get multiple user prompts by IDs
   */
  async getPromptsByIds(ids: number[]): Promise<Array<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  }>> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return (await this.db.all(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id IN (${placeholders})
      ORDER BY p.created_at_epoch DESC
    `, [...ids])) as Array<{
      id: number;
      content_session_id: string;
      prompt_number: number;
      prompt_text: string;
      project: string;
      created_at: string;
      created_at_epoch: number;
    }>;
  }

  /**
   * Get full session summary by ID (includes request_summary and learned_summary)
   */
  async getSessionSummaryById(id: number): Promise<{
    id: number;
    memory_session_id: string | null;
    content_session_id: string;
    project: string;
    user_prompt: string;
    request_summary: string | null;
    learned_summary: string | null;
    status: string;
    created_at: string;
    created_at_epoch: number;
  } | null> {
    return (await this.db.get(`
      SELECT
        id,
        memory_session_id,
        content_session_id,
        project,
        user_prompt,
        request_summary,
        learned_summary,
        status,
        created_at,
        created_at_epoch
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `, [id])) || null;
  }

  /**
   * Get or create a manual session for storing user-created observations
   * Manual sessions use a predictable ID format: "manual-{project}"
   */
  async getOrCreateManualSession(project: string): Promise<string> {
    const memorySessionId = `manual-${project}`;
    const contentSessionId = `manual-content-${project}`;
    const existing = (await this.db.get('SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?', [memorySessionId])) as {
      memory_session_id: string;
    } | undefined;
    if (existing) {
      return memorySessionId;
    }

    // Create new manual session
    const now = new Date();
    await this.db.run(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `, [memorySessionId, contentSessionId, project, DEFAULT_PLATFORM_SOURCE, now.toISOString(), now.getTime()]);
    logger.info('SESSION', 'Created manual session', {
      memorySessionId,
      project
    });
    return memorySessionId;
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    this.db.close();
  }

  // ===========================================
  // Import Methods (for import-memories script)
  // ===========================================

  /**
   * Import SDK session with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
  async importSdkSession(session: {
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source?: string;
    user_prompt: string;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }): Promise<{
    imported: boolean;
    id: number;
  }> {
    // Check if session already exists
    const existing = (await this.db.get('SELECT id FROM sdk_sessions WHERE content_session_id = ?', [session.content_session_id])) as {
      id: number;
    } | undefined;
    if (existing) {
      return {
        imported: false,
        id: existing.id
      };
    }
    const result = await this.db.run(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [session.content_session_id, session.memory_session_id, session.project, normalizePlatformSource(session.platform_source), session.user_prompt, session.started_at, session.started_at_epoch, session.completed_at, session.completed_at_epoch, session.status]);
    return {
      imported: true,
      id: result.lastInsertRowid as number
    };
  }

  /**
   * Import session summary with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
  async importSessionSummary(summary: {
    memory_session_id: string;
    project: string;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
  }): Promise<{
    imported: boolean;
    id: number;
  }> {
    // Check if summary already exists for this session
    const existing = (await this.db.get('SELECT id FROM session_summaries WHERE memory_session_id = ?', [summary.memory_session_id])) as {
      id: number;
    } | undefined;
    if (existing) {
      return {
        imported: false,
        id: existing.id
      };
    }
    const result = await this.db.run(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [summary.memory_session_id, summary.project, summary.request, summary.investigated, summary.learned, summary.completed, summary.next_steps, summary.files_read, summary.files_edited, summary.notes, summary.prompt_number, summary.discovery_tokens || 0, summary.created_at, summary.created_at_epoch]);
    return {
      imported: true,
      id: result.lastInsertRowid as number
    };
  }

  /**
   * Import observation with duplicate checking
   * Duplicates are identified by memory_session_id + title + created_at_epoch
   * Returns: { imported: boolean, id: number }
   */
  async importObservation(obs: {
    memory_session_id: string;
    project: string;
    text: string | null;
    type: string;
    title: string | null;
    subtitle: string | null;
    facts: string | null;
    narrative: string | null;
    concepts: string | null;
    files_read: string | null;
    files_modified: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
  }): Promise<{
    imported: boolean;
    id: number;
  }> {
    // Check if observation already exists
    const existing = (await this.db.get(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `, [obs.memory_session_id, obs.title, obs.created_at_epoch])) as {
      id: number;
    } | undefined;
    if (existing) {
      return {
        imported: false,
        id: existing.id
      };
    }
    const result = await this.db.run(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [obs.memory_session_id, obs.project, obs.text, obs.type, obs.title, obs.subtitle, obs.facts, obs.narrative, obs.concepts, obs.files_read, obs.files_modified, obs.prompt_number, obs.discovery_tokens || 0, obs.created_at, obs.created_at_epoch]);
    return {
      imported: true,
      id: result.lastInsertRowid as number
    };
  }

  /**
   * Rebuild the FTS5 index for observations.
   * Should be called after bulk imports to ensure imported rows are searchable.
   * No-op if observations_fts table does not exist.
   */
  async rebuildObservationsFTSIndex(): Promise<void> {
    const hasFTS = ((await this.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'")) as {
      name: string;
    }[]).length > 0;
    if (!hasFTS) {
      return;
    }
    await this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
  }

  /**
   * Import user prompt with duplicate checking
   * Duplicates are identified by content_session_id + prompt_number
   * Returns: { imported: boolean, id: number }
   */
  async importUserPrompt(prompt: {
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }): Promise<{
    imported: boolean;
    id: number;
  }> {
    // Check if prompt already exists
    const existing = (await this.db.get(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `, [prompt.content_session_id, prompt.prompt_number])) as {
      id: number;
    } | undefined;
    if (existing) {
      return {
        imported: false,
        id: existing.id
      };
    }
    const result = await this.db.run(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `, [prompt.content_session_id, prompt.prompt_number, prompt.prompt_text, prompt.created_at, prompt.created_at_epoch]);
    return {
      imported: true,
      id: result.lastInsertRowid as number
    };
  }
}