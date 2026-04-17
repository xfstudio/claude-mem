#!/usr/bin/env bun
import { logger } from '../utils/logger.js';
import { getDatabaseProvider } from '../services/db/DatabaseFactory.js';
import { SyncService } from '../services/db/sync.js';
import { HybridDatabaseProvider } from '../services/db/provider/HybridDatabaseProvider.js';

async function main() {
  logger.info('SYSTEM', 'Starting DB Sync Script');

  const provider = await getDatabaseProvider();

  if (!(provider instanceof HybridDatabaseProvider)) {
    logger.warn('SYSTEM', 'Database engine is not set to mysql. Sync script only works in hybrid mode.');
    await provider.close();
    process.exit(0);
  }

  try {
    // Perform bidirectional sync
    await SyncService.syncBidirectional(provider.getSqliteProvider(), provider.getMysqlProvider());
    logger.info('SYSTEM', 'Database sync completed successfully.');
  } catch (err: any) {
    logger.error('SYSTEM', `Error during sync: ${err.message}`, err);
    process.exit(1);
  } finally {
    await provider.close();
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
