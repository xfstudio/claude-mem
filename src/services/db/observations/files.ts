import { IDatabaseProvider } from '../provider/IDatabaseProvider.js';
/**
 * Session file retrieval functions
 * Extracted from SessionStore.ts for modular organization
 */

import { logger } from '../../../utils/logger.js';
import type { SessionFilesResult } from './types.js';

/**
 * Safely parse a JSON array string from the DB.
 * Handles legacy bare-path strings (e.g. "/foo/bar.ts") by wrapping them
 * in an array instead of crashing with a SyntaxError (fix for #1359).
 */
export function parseFileList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return [value];
  }
}

/**
 * Get aggregated files from all observations for a session
 */
export async function getFilesForSession(
  db: IDatabaseProvider,
  memorySessionId: string
): Promise<SessionFilesResult >{
  

  const rows = await db.all(`
    SELECT files_read, files_modified
    FROM observations
    WHERE memory_session_id = ?
  `, [memorySessionId]) as Array<{
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
