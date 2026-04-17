/**
 * Observations module tests
 * Tests modular observation functions with in-memory database
 *
 * Sources:
 * - API patterns from src/services/db/observations/store.ts
 * - API patterns from src/services/db/observations/get.ts
 * - API patterns from src/services/db/observations/recent.ts
 * - Type definitions from src/services/db/observations/types.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/db/Database.js';
import { SqliteProvider } from '../../src/services/db/provider/SqliteProvider.js';
import {
  storeObservation,
  getObservationById,
  getRecentObservations,
} from '../../src/services/db/Observations.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/db/Sessions.js';
import type { ObservationInput } from '../../src/services/db/observations/types.js';
import type { Database } from 'bun:sqlite';

describe('Observations Module', () => {
  let rawDb: Database;
  let db: SqliteProvider;

  beforeEach(() => {
    rawDb = new ClaudeMemDatabase(':memory:').db;
    db = new SqliteProvider(rawDb);
  });

  afterEach(() => {
    rawDb.close();
  });

  // Helper to create a valid observation input
  function createObservationInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
    return {
      type: 'discovery',
      title: 'Test Observation',
      subtitle: 'Test Subtitle',
      facts: ['fact1', 'fact2'],
      narrative: 'Test narrative content',
      concepts: ['concept1', 'concept2'],
      files_read: ['/path/to/file1.ts'],
      files_modified: ['/path/to/file2.ts'],
      ...overrides,
    };
  }

  // Helper to create a session and return memory_session_id for FK constraints
  function createSessionWithMemoryId(contentSessionId: string, memorySessionId: string, project: string = 'test-project'): string {
    const sessionId = createSDKSession(rawDb, contentSessionId, project, 'initial prompt');
    updateMemorySessionId(rawDb, sessionId, memorySessionId);
    return memorySessionId;
  }

  describe('storeObservation', () => {
    it('should store observation and return id and createdAtEpoch', async () => {
      const memorySessionId = createSessionWithMemoryId('content-123', 'mem-session-123');
      const project = 'test-project';
      const observation = createObservationInput();

      const result = await storeObservation(db, memorySessionId, project, observation);

      expect(typeof result.id).toBe('number');
      expect(result.id).toBeGreaterThan(0);
      expect(typeof result.createdAtEpoch).toBe('number');
      expect(result.createdAtEpoch).toBeGreaterThan(0);
    });

    it('should store all observation fields correctly', async () => {
      const memorySessionId = createSessionWithMemoryId('content-456', 'mem-session-456');
      const project = 'test-project';
      const observation = createObservationInput({
        type: 'bugfix',
        title: 'Fixed critical bug',
        subtitle: 'Memory leak',
        facts: ['leak found', 'patched'],
        narrative: 'Fixed memory leak in parser',
        concepts: ['memory', 'gc'],
        files_read: ['/src/parser.ts'],
        files_modified: ['/src/parser.ts', '/tests/parser.test.ts'],
      });

      const result = await storeObservation(db, memorySessionId, project, observation, 1, 100);

      const stored = await getObservationById(db, result.id);
      expect(stored).not.toBeNull();
      expect(stored?.type).toBe('bugfix');
      expect(stored?.title).toBe('Fixed critical bug');
      expect(stored?.memory_session_id).toBe(memorySessionId);
      expect(stored?.project).toBe(project);
    });

    it('should respect overrideTimestampEpoch', async () => {
      const memorySessionId = createSessionWithMemoryId('content-789', 'mem-session-789');
      const project = 'test-project';
      const observation = createObservationInput();
      const pastTimestamp = 1600000000000; // Sep 13, 2020

      const result = await storeObservation(
        db,
        memorySessionId,
        project,
        observation,
        1,
        0,
        pastTimestamp
      );

      expect(result.createdAtEpoch).toBe(pastTimestamp);

      const stored = await getObservationById(db, result.id);
      expect(stored?.created_at_epoch).toBe(pastTimestamp);
      // Verify ISO string matches epoch
      expect(new Date(stored!.created_at).getTime()).toBe(pastTimestamp);
    });

    it('should use current time when overrideTimestampEpoch not provided', async () => {
      const memorySessionId = createSessionWithMemoryId('content-now', 'session-now');
      const before = Date.now();
      const observation = createObservationInput();
      const result = await storeObservation(
        db,
        memorySessionId,
        'project',
        observation
      );
      const after = Date.now();

      expect(result.createdAtEpoch).toBeGreaterThanOrEqual(before);
      expect(result.createdAtEpoch).toBeLessThanOrEqual(after);
    });

    it('should handle null subtitle and narrative', async () => {
      const memorySessionId = createSessionWithMemoryId('content-null', 'session-null');
      const observation = createObservationInput({
        subtitle: null as any,
        narrative: null as any,
      });

      const result = await storeObservation(db, memorySessionId, 'project', observation);
      const stored = await getObservationById(db, result.id);

      expect(stored).not.toBeNull();
      expect(stored?.id).toBe(result.id);
    });
  });

  describe('getObservationById', () => {
    it('should retrieve observation by ID', async () => {
      const memorySessionId = createSessionWithMemoryId('content-get', 'session-get');
      const observation = createObservationInput({ title: 'Unique Title' });
      const result = await storeObservation(db, memorySessionId, 'project', observation);

      const retrieved = await getObservationById(db, result.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(result.id);
      expect(retrieved?.title).toBe('Unique Title');
    });

    it('should return null for non-existent observation', async () => {
      const retrieved = await getObservationById(db, 99999);

      expect(retrieved).toBeNull();
    });
  });

  describe('getRecentObservations', () => {
    it('should return observations ordered by date DESC', async () => {
      const project = 'test-project';

      // Create sessions and store observations with different timestamps (oldest first)
      const mem1 = createSessionWithMemoryId('content-1', 'session1', project);
      const mem2 = createSessionWithMemoryId('content-2', 'session2', project);
      const mem3 = createSessionWithMemoryId('content-3', 'session3', project);

      await storeObservation(db, mem1, project, createObservationInput(), 1, 0, 1000000000000);
      await storeObservation(db, mem2, project, createObservationInput(), 2, 0, 2000000000000);
      await storeObservation(db, mem3, project, createObservationInput(), 3, 0, 3000000000000);

      const recent = await getRecentObservations(db, project, 10);

      expect(recent.length).toBe(3);
      // Most recent first (DESC order)
      expect(recent[0].prompt_number).toBe(3);
      expect(recent[1].prompt_number).toBe(2);
      expect(recent[2].prompt_number).toBe(1);
    });

    it('should respect limit parameter', async () => {
      const project = 'test-project';

      const mem1 = createSessionWithMemoryId('content-lim1', 'session-lim1', project);
      const mem2 = createSessionWithMemoryId('content-lim2', 'session-lim2', project);
      const mem3 = createSessionWithMemoryId('content-lim3', 'session-lim3', project);

      await storeObservation(db, mem1, project, createObservationInput(), 1, 0, 1000000000000);
      await storeObservation(db, mem2, project, createObservationInput(), 2, 0, 2000000000000);
      await storeObservation(db, mem3, project, createObservationInput(), 3, 0, 3000000000000);

      const recent = await getRecentObservations(db, project, 2);

      expect(recent.length).toBe(2);
    });

    it('should filter by project', async () => {
      const memA1 = createSessionWithMemoryId('content-a1', 'session-a1', 'project-a');
      const memB1 = createSessionWithMemoryId('content-b1', 'session-b1', 'project-b');
      const memA2 = createSessionWithMemoryId('content-a2', 'session-a2', 'project-a');

      await storeObservation(db, memA1, 'project-a', createObservationInput());
      await storeObservation(db, memB1, 'project-b', createObservationInput());
      await storeObservation(db, memA2, 'project-a', createObservationInput());

      const recentA = await getRecentObservations(db, 'project-a', 10);
      const recentB = await getRecentObservations(db, 'project-b', 10);

      expect(recentA.length).toBe(2);
      expect(recentB.length).toBe(1);
    });

    it('should return empty array for project with no observations', async () => {
      const recent = await getRecentObservations(db, 'nonexistent-project', 10);

      expect(recent).toEqual([]);
    });
  });
});
