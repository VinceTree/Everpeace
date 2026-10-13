import { UserSettingsStore } from '../storage/user-settings.js';
export type LanguagePreference = 'auto' | 'en' | 'zh-CN';
export type UiLanguage = Exclude<LanguagePreference, 'auto'>;
export function isLanguagePreference(value: unknown): value is LanguagePreference { return value === 'auto' || value === 'en' || value === 'zh-CN'; }
interface LanguageSettings {
    version: 1;
    language?: LanguagePreference;
}
const valid = (v: unknown): v is LanguageSettings => !!v && typeof v === 'object' && 'version' in v && v.version === 1 && (!('language' in v) || isLanguagePreference(v.language));
export class LanguageSettingsStore extends UserSettingsStore<LanguageSettings> {
    constructor(file?: string) { super('language.json', valid, () => ({ version: 1, language: 'auto' }), file); }
    async save(language: LanguagePreference): Promise<void> { await this.update(current => ({ ...current, language })); }
}
export function resolveLanguage(options: {
    commandLine?: LanguagePreference;
    environment?: string;
    saved?: LanguagePreference;
    system?: string;
} = {}): UiLanguage {
    const selected = options.commandLine ?? (isLanguagePreference(options.environment) ? options.environment : undefined) ?? options.saved ?? 'auto';
    return selected === 'auto' ? (/^zh(?:[-_]|$)/i.test(options.system ?? Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh-CN' : 'en') : selected;
}
let language: UiLanguage = 'en';
const listeners = new Set<() => void>();
export const currentLanguage = (): UiLanguage => language;
export function setUiLanguage(next: UiLanguage): void { if (next === language)
    return; language = next; for (const listener of listeners)
    listener(); }
export function subscribeLanguage(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
let commandLinePreference: LanguagePreference | undefined;
export async function initializeLanguage(preference?: LanguagePreference): Promise<void> { commandLinePreference = preference; const saved: LanguageSettings = preference !== undefined || isLanguagePreference(process.env.EVERPEACE_LANG) ? { version: 1 } : await new LanguageSettingsStore().read(); setUiLanguage(resolveLanguage({ ...(preference ? { commandLine: preference } : {}), ...(process.env.EVERPEACE_LANG ? { environment: process.env.EVERPEACE_LANG } : {}), ...(saved.language ? { saved: saved.language } : {}) })); }
export async function changeLanguage(preference: LanguagePreference): Promise<UiLanguage> { await new LanguageSettingsStore().save(preference); setUiLanguage(resolveLanguage({ ...(commandLinePreference ? { commandLine: commandLinePreference } : {}), ...(process.env.EVERPEACE_LANG ? { environment: process.env.EVERPEACE_LANG } : {}), saved: preference })); return language; }
