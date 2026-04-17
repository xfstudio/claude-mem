import { IDatabaseProvider } from '../provider/IDatabaseProvider.js';
/**
 * Session retrieval functions
 * Database-first parameter pattern for functional composition
 */

import { logger } from '../../../utils/logger.js';
import type {
  SessionBasic,
  SessionFull,
  SessionWithStatus,
  SessionSummaryDetail,
} from './types.js';

/**
 * Get session by ID (basic fields only)
 */
export async function getSessionById(db: IDatabaseProvider, id: number): Promise<SessionBasic | null >{
  

  return (await db.get(`
    SELECT id, content_session_id, memory_session_id, project,
           COALESCE(platform_source, 'claude') as platform_source,
           user_prompt, custom_title
    FROM sdk_sessions
    WHERE id = ?
    LIMIT 1
  `, [id]) as SessionBasic | undefined) || null;
}

/**
 * Get SDK sessions by memory session IDs
 * Used for exporting session metadata
 */
export async function getSdkSessionsBySessionIds(
  db: IDatabaseProvider,
  memorySessionIds: string[]
): Promise<SessionFull[] >{
  if (memorySessionIds.length === 0) return [];

  const placeholders = memorySessionIds.map(() => '?').join(',');
  

  return await db.all(`
    SELECT id, content_session_id, memory_session_id, project,
           COALESCE(platform_source, 'claude') as platform_source,
           user_prompt, custom_title,
           started_at, started_at_epoch, completed_at, completed_at_epoch, status
    FROM sdk_sessions
    WHERE memory_session_id IN (${placeholders})
    ORDER BY started_at_epoch DESC
  `, [...memorySessionIds]) as SessionFull[];
}

/**
 * Get recent sessions with their status and summary info
 * Returns sessions ordered oldest-first for display
 */
export async function getRecentSessionsWithStatus(
  db: IDatabaseProvider,
  project: string,
  limit: number = 3
): Promise<SessionWithStatus[] >{
  

  return await db.all(`
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
  `, [project, limit]) as SessionWithStatus[];
}

/**
 * Get full session summary by ID (includes request_summary and learned_summary)
 */
export async function getSessionSummaryById(
  db: IDatabaseProvider,
  id: number
): Promise<SessionSummaryDetail | null >{
  

  return (await db.get(`
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
  `, [id]) as SessionSummaryDetail | undefined) || null;
}
