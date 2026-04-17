/**
 * Summaries module tests
 * Tests modular summary functions with in-memory database
 *
 * Sources:
 * - API patterns from src/services/db/summaries/store.ts
 * - API patterns from src/services/db/summaries/get.ts
 * - Type definitions from src/services/db/summaries/types.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/db/Database.js';
import {
  storeSummary,
  getSummaryForSession,
} from '../../src/services/db/Summaries.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/db/Sessions.js';
import { SqliteProvider } from '../../src/services/db/provider/SqliteProvider.js';
import type { SummaryInput } from '../../src/services/db/summaries/types.js';
import type { Database } from 'bun:sqlite';

describe('Summaries Module', () => {
  let db: Database;
  let dbProvider: SqliteProvider;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    dbProvider = new SqliteProvider(db);
  });

  afterEach(() => {
    db.close();
  });

  // Helper to create a valid summary input
  function createSummaryInput(overrides: Partial<SummaryInput> = {}): SummaryInput {
    return {
      request: 'User requested feature X',
      investigated: 'Explored the codebase',
      learned: 'Discovered pattern Y',
      completed: 'Implemented feature X',
      next_steps: 'Add tests and documentation',
      notes: 'Consider edge case Z',
      ...overrides,
    };
  }

  // Helper to create a session and return memory_session_id for FK constraints
  function createSessionWithMemoryId(contentSessionId: string, memorySessionId: string, project: string = 'test-project'): string {
    const sessionId = createSDKSession(db, contentSessionId, project, 'initial prompt');
    updateMemorySessionId(db, sessionId, memorySessionId);
    return memorySessionId;
  }

  describe('storeSummary', () => {
    it('should store summary and return id and createdAtEpoch', async () => {
      const memorySessionId = createSessionWithMemoryId('content-sum-123', 'mem-session-sum-123');
      const project = 'test-project';
      const summary = createSummaryInput();

      const result = await storeSummary(dbProvider, memorySessionId, project, summary);

      expect(typeof result.id).toBe('number');
      expect(result.id).toBeGreaterThan(0);
      expect(typeof result.createdAtEpoch).toBe('number');
      expect(result.createdAtEpoch).toBeGreaterThan(0);
    });

    it('should store all summary fields correctly', async () => {
      const memorySessionId = createSessionWithMemoryId('content-sum-456', 'mem-session-sum-456');
      const project = 'test-project';
      const summary = createSummaryInput({
        request: 'Refactor the database layer',
        investigated: 'Analyzed current schema',
        learned: 'Found N+1 query issues',
        completed: 'Optimized queries',
        next_steps: 'Monitor performance',
        notes: 'May need caching',
      });

      const result = await storeSummary(dbProvider, memorySessionId, project, summary, 1, 500);

      const stored = await getSummaryForSession(dbProvider, memorySessionId);
      expect(stored).not.toBeNull();
      expect(stored?.request).toBe('Refactor the database layer');
      expect(stored?.investigated).toBe('Analyzed current schema');
      expect(stored?.learned).toBe('Found N+1 query issues');
      expect(stored?.completed).toBe('Optimized queries');
      expect(stored?.next_steps).toBe('Monitor performance');
      expect(stored?.notes).toBe('May need caching');
      expect(stored?.prompt_number).toBe(1);
    });

    it('should respect overrideTimestampEpoch', async () => {
      const memorySessionId = createSessionWithMemoryId('content-sum-789', 'mem-session-sum-789');
      const project = 'test-project';
      const summary = createSummaryInput();
      const pastTimestamp = 1650000000000; // Apr 15, 2022

      const result = await storeSummary(
        dbProvider,
        memorySessionId,
        project,
        summary,
        1,
        0,
        pastTimestamp
      );

      expect(result.createdAtEpoch).toBe(pastTimestamp);

      const stored = await getSummaryForSession(dbProvider, memorySessionId);
      expect(stored?.created_at_epoch).toBe(pastTimestamp);
    });

    it('should use current time when overrideTimestampEpoch not provided', async () => {
      const memorySessionId = createSessionWithMemoryId('content-sum-now', 'session-sum-now');
      const before = Date.now();
      const result = await storeSummary(
        dbProvider,
        memorySessionId,
        'project',
        createSummaryInput()
      );
      const after = Date.now();

      expect(result.createdAtEpoch).toBeGreaterThanOrEqual(before);
      expect(result.createdAtEpoch).toBeLessThanOrEqual(after);
    });

    it('should handle null notes', async () => {
      const memorySessionId = createSessionWithMemoryId('content-sum-null', 'session-sum-null');
      const summary = createSummaryInput({ notes: null });

      const result = await storeSummary(dbProvider, memorySessionId, 'project', summary);
      const stored = await getSummaryForSession(dbProvider, memorySessionId);

      expect(stored).not.toBeNull();
      expect(stored?.notes).toBeNull();
    });
  });

  describe('getSummaryForSession', () => {
    it('should retrieve summary by memory_session_id', async () => {
      const memorySessionId = createSessionWithMemoryId('content-unique', 'unique-mem-session');
      const summary = createSummaryInput({ request: 'Unique request' });

      await storeSummary(dbProvider, memorySessionId, 'project', summary);

      const retrieved = await getSummaryForSession(dbProvider, memorySessionId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.request).toBe('Unique request');
    });

    it('should return null for session with no summary', async () => {
      const retrieved = await getSummaryForSession(dbProvider, 'nonexistent-session');

      expect(retrieved).toBeNull();
    });

    it('should return most recent summary when multiple exist', async () => {
      const memorySessionId = createSessionWithMemoryId('content-multi', 'multi-summary-session');

      // Store older summary
      await storeSummary(
        dbProvider,
        memorySessionId,
        'project',
        createSummaryInput({ request: 'First request' }),
        1,
        0,
        1000000000000
      );

      // Store newer summary
      await storeSummary(
        dbProvider,
        memorySessionId,
        'project',
        createSummaryInput({ request: 'Second request' }),
        2,
        0,
        2000000000000
      );

      const retrieved = await getSummaryForSession(dbProvider, memorySessionId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.request).toBe('Second request');
      expect(retrieved?.prompt_number).toBe(2);
    });

    it('should return summary with all expected fields', async () => {
      const memorySessionId = createSessionWithMemoryId('content-fields', 'fields-check-session');
      const summary = createSummaryInput();

      await storeSummary(dbProvider, memorySessionId, 'project', summary, 1, 100, 1500000000000);

      const retrieved = await getSummaryForSession(dbProvider, memorySessionId);

      expect(retrieved).not.toBeNull();
      expect(retrieved).toHaveProperty('request');
      expect(retrieved).toHaveProperty('investigated');
      expect(retrieved).toHaveProperty('learned');
      expect(retrieved).toHaveProperty('completed');
      expect(retrieved).toHaveProperty('next_steps');
      expect(retrieved).toHaveProperty('notes');
      expect(retrieved).toHaveProperty('prompt_number');
      expect(retrieved).toHaveProperty('created_at');
      expect(retrieved).toHaveProperty('created_at_epoch');
    });
  });
});
