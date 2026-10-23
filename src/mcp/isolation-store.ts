import { UserSettingsStore } from '../storage/user-settings.js';

interface IsolationSettings { version: 1; entries: Array<{ workspace: string; name: string; mode: 'sandbox' | 'host' }> }
export interface McpIsolationStoreLike {
  get(workspace: string, name: string): Promise<'sandbox' | 'host' | undefined>;
  set(workspace: string, name: string, mode: 'sandbox' | 'host'): Promise<void>;
}
export class McpIsolationStore implements McpIsolationStoreLike {
  readonly settings: UserSettingsStore<IsolationSettings>;
  constructor(file?: string) {
    this.settings = new UserSettingsStore('mcp-isolation.json', (value): value is IsolationSettings => {
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('entries' in value) || !Array.isArray(value.entries)) return false;
      return value.entries.length <= 1000 && value.entries.every(entry => entry && typeof entry.workspace === 'string' && typeof entry.name === 'string' && ['sandbox', 'host'].includes(entry.mode));
    }, () => ({ version: 1, entries: [] }), file);
  }
  async get(workspace: string, name: string): Promise<'sandbox' | 'host' | undefined> { return (await this.settings.read()).entries.find(entry => entry.workspace === workspace && entry.name === name)?.mode; }
  async set(workspace: string, name: string, mode: 'sandbox' | 'host'): Promise<void> {
    await this.settings.update(current => ({ version: 1, entries: [...current.entries.filter(entry => entry.workspace !== workspace || entry.name !== name), { workspace, name, mode }] }));
  }
}
