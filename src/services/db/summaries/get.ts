/**
 * Get session summaries from the database
 */
import { IDatabaseProvider } from '../provider/IDatabaseProvider.js';
import { logger } from '../../../utils/logger.js';
import type { SessionSummaryRecord } from '../../../types/database.js';
import type { SessionSummary, GetByIdsOptions } from './types.js';

/**
 * Get summary for a specific session
 *
 * @param db - Database instance
 * @param memorySessionId - SDK memory session ID
 * @returns Most recent summary for the session, or null if none exists
 */
export async function getSummaryForSession(
  db: IDatabaseProvider,
  memorySessionId: string
): Promise<SessionSummary | null >{
  

  return (await db.get(`
    SELECT
      request, investigated, learned, completed, next_steps,
      files_read, files_edited, notes, prompt_number, created_at,
      created_at_epoch
    FROM session_summaries
    WHERE memory_session_id = ?
    ORDER BY created_at_epoch DESC
    LIMIT 1
  `, [memorySessionId]) as SessionSummary | undefined) || null;
}

/**
 * Get a single session summary by ID
 *
 * @param db - Database instance
 * @param id - Summary ID
 * @returns Full summary record or null if not found
 */
export async function getSummaryById(
  db: IDatabaseProvider,
  id: number
): Promise<SessionSummaryRecord | null >{
  

  return (await db.get(`
    SELECT * FROM session_summaries WHERE id = ?
  `, [id]) as SessionSummaryRecord | undefined) || null;
}

/**
 * Get session summaries by IDs (for hybrid Chroma search)
 * Returns summaries in specified temporal order
 *
 * @param db - Database instance
 * @param ids - Array of summary IDs
 * @param options - Query options (orderBy, limit, project)
 */
export async function getSummariesByIds(
  db: IDatabaseProvider,
  ids: number[],
  options: GetByIdsOptions = {}
): Promise<SessionSummaryRecord[] >{
  if (ids.length === 0) return [];

  const { orderBy = 'date_desc', limit, project } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const placeholders = ids.map(() => '?').join(',');
  const params: (number | string)[] = [...ids];

  // Apply project filter
  const whereClause = project
    ? `WHERE id IN (${placeholders}) AND project = ?`
    : `WHERE id IN (${placeholders})`;
  if (project) params.push(project);

  

  return await db.all(`
    SELECT * FROM session_summaries
    ${whereClause}
    ORDER BY created_at_epoch ${orderClause}
    ${limitClause}
  `, [...params]) as SessionSummaryRecord[];
}
