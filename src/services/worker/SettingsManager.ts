/**
 * SettingsManager: DRY settings CRUD utility
 *
 * Responsibility:
 * - DRY helper for viewer settings CRUD
 * - Eliminates duplication in settings read/write logic
 * - Type-safe settings management
 */

import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { ViewerSettings } from '../worker-types.js';

export class SettingsManager {
  private dbManager: DatabaseManager;
  private readonly defaultSettings: ViewerSettings = {
    sidebarOpen: true,
    selectedProject: null,
    theme: 'system'
  };

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /**
   * Get current viewer settings (with defaults)
   */
  async getSettings(): Promise<ViewerSettings> {
    const db = this.dbManager.getSessionStore().db;

    try {
      const rows = await db.all<{ key: string; value: string }>('SELECT key, value FROM viewer_settings', []);

      const settings: ViewerSettings = { ...this.defaultSettings };
      for (const row of rows) {
        const key = row.key as keyof ViewerSettings;
        if (key in settings) {
          (settings as any)[key] = JSON.parse(row.value);
        }
      }

      return settings;
    } catch (error) {
      logger.debug('WORKER', 'Failed to load settings, using defaults', {}, error as Error);
      return { ...this.defaultSettings };
    }
  }

  /**
   * Update viewer settings (partial update)
   */
  async updateSettings(updates: Partial<ViewerSettings>): Promise<ViewerSettings> {
    const db = this.dbManager.getSessionStore().db;

    for (const [key, value] of Object.entries(updates)) {
      await db.run(`
        INSERT OR REPLACE INTO viewer_settings (key, value)
        VALUES (?, ?)
      `, [key, JSON.stringify(value)]);
    }

    return await this.getSettings();
  }
}
