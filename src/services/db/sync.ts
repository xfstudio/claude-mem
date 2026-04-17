import { IDatabaseProvider } from './provider/IDatabaseProvider.js';
import { logger } from '../../utils/logger.js';

const SYNC_TABLES = [
  'sdk_sessions',
  'observations',
  'session_summaries',
  'pending_messages',
  'user_prompts',
  'observation_feedback'
];

/**
 * Service to handle bidirectional sync between two IDatabaseProviders.
 */
export class SyncService {
  /**
   * Performs an incremental sync of new data from remote (MySQL) to local (SQLite)
   */
  static async syncRemoteToLocal(local: IDatabaseProvider, remote: IDatabaseProvider): Promise<void> {
    logger.info('DB', 'Starting sync from remote to local...');
    
    for (const table of SYNC_TABLES) {
      if (!(await local.hasTable(table))) continue;
      
      try {
        // We use id as a rough high-water mark. Wait, some tables might have updates.
        // It's safer to just fetch everything if we assume small datasets or use created_at_epoch.
        // Let's rely on ID for now, as it's an append-heavy system.
        const maxLocalRes = await local.get<{ maxId: number }>(`SELECT MAX(id) as maxId FROM ${table}`);
        const maxLocalId = maxLocalRes?.maxId || 0;
        
        const newRemoteRows = await remote.all<any>(`SELECT * FROM ${table} WHERE id > ?`, [maxLocalId]);
        
        if (newRemoteRows && newRemoteRows.length > 0) {
          logger.info('DB', `Found ${newRemoteRows.length} new rows in remote ${table}`);
          await this.insertRows(local, table, newRemoteRows);
        } else {
          logger.debug('DB', `No new rows in remote ${table}`);
        }
      } catch (err: any) {
        logger.error('DB', `Error syncing remote to local for table ${table}: ${err.message}`);
      }
    }
    logger.info('DB', 'Finished sync from remote to local.');
  }

  /**
   * Performs an incremental sync of new data from local (SQLite) to remote (MySQL)
   */
  static async syncLocalToRemote(local: IDatabaseProvider, remote: IDatabaseProvider): Promise<void> {
    logger.info('DB', 'Starting sync from local to remote...');
    
    for (const table of SYNC_TABLES) {
      if (!(await local.hasTable(table))) continue;
      
      try {
        // Just push what is not on remote.
        const maxRemoteRes = await remote.get<{ maxId: number }>(`SELECT MAX(id) as maxId FROM ${table}`);
        const maxRemoteId = maxRemoteRes?.maxId || 0;
        
        const newLocalRows = await local.all<any>(`SELECT * FROM ${table} WHERE id > ?`, [maxRemoteId]);
        
        if (newLocalRows && newLocalRows.length > 0) {
          logger.info('DB', `Found ${newLocalRows.length} new rows in local ${table}`);
          await this.insertRows(remote, table, newLocalRows, true); // MySQL needs special INSERT IGNORE or ON DUPLICATE KEY UPDATE
        } else {
          logger.debug('DB', `No new rows in local ${table}`);
        }
      } catch (err: any) {
        logger.error('DB', `Error syncing local to remote for table ${table}: ${err.message}`);
      }
    }
    logger.info('DB', 'Finished sync from local to remote.');
  }
  
  /**
   * Fully synchronizes both databases
   */
  static async syncBidirectional(local: IDatabaseProvider, remote: IDatabaseProvider): Promise<void> {
    logger.info('DB', 'Starting bidirectional sync...');
    await this.syncRemoteToLocal(local, remote);
    await this.syncLocalToRemote(local, remote);
    logger.info('DB', 'Bidirectional sync complete.');
  }

  private static async insertRows(db: IDatabaseProvider, table: string, rows: any[], isMysql = false): Promise<void> {
    if (!rows || rows.length === 0) return;
    
    const keys = Object.keys(rows[0]);
    if (keys.length === 0) return;

    const columns = keys.join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    
    // Different upsert semantics
    // SQLite uses INSERT OR REPLACE
    // MySQL uses INSERT ... ON DUPLICATE KEY UPDATE
    let upsertSql: string;
    if (isMysql) {
      const updates = keys.map(k => `${k}=VALUES(${k})`).join(', ');
      upsertSql = `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
    } else {
      upsertSql = `INSERT OR REPLACE INTO ${table} (${columns}) VALUES (${placeholders})`;
    }

    try {
      await db.run('BEGIN');
      for (const row of rows) {
        // Convert any objects/arrays to strings or nulls
        const values = keys.map(k => {
          let val = row[k];
          if (val === undefined) val = null;
          return val;
        });
        await db.run(upsertSql, values);
      }
      await db.run('COMMIT');
    } catch (err: any) {
      try {
        await db.run('ROLLBACK');
      } catch (rollbackErr) {}
      logger.error('DB', `Failed to insert rows into ${table}`, err);
    }
  }
}
