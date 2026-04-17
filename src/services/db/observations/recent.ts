import { IDatabaseProvider } from '../provider/IDatabaseProvider.js';
/**
 * Recent observation retrieval functions
 * Extracted from SessionStore.ts for modular organization
 */

import { logger } from '../../../utils/logger.js';
import type { RecentObservationRow, AllRecentObservationRow } from './types.js';

/**
 * Get recent observations for a project
 */
export async function getRecentObservations(
  db: IDatabaseProvider,
  project: string,
  limit: number = 20
): Promise<RecentObservationRow[] >{
  

  return await db.all(`
    SELECT type, text, prompt_number, created_at
    FROM observations
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `, [project, limit]) as RecentObservationRow[];
}

/**
 * Get recent observations across all projects (for web UI)
 */
export async function getAllRecentObservations(
  db: IDatabaseProvider,
  limit: number = 100
): Promise<AllRecentObservationRow[] >{
  

  return await db.all(`
    SELECT id, type, title, subtitle, text, project, prompt_number, created_at, created_at_epoch
    FROM observations
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `, [limit]) as AllRecentObservationRow[];
}
