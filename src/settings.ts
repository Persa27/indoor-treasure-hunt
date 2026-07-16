// 担当Phase2エージェントが実装する。対応SPEC.md: 4(設定項目), 8.4(localStorageの検証)
import { DEFAULT_SETTINGS, type GameMode, type GameSettings } from './types';

const STORAGE_KEY = 'indoor-treasure-hunt:settings';

const GAME_MODES: GameMode[] = ['chest', 'coin'];

const RANGES: Record<
  Exclude<keyof GameSettings, 'soundEnabled' | 'vibrationEnabled' | 'gameMode'>,
  { min: number; max: number }
> = {
  treasureCount: { min: 1, max: 5 },
  hideTimeSec: { min: 15, max: 300 },
  seekTimeSec: { min: 30, max: 600 },
  successRadiusM: { min: 0.2, max: 1.5 },
  digCooldownSec: { min: 0, max: 10 },
  radarNearM: { min: 0, max: 100 },
  radarMidM: { min: 0, max: 100 },
  radarFarM: { min: 0, max: 100 },
};

function isValidNumber(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    const result: GameSettings = { ...DEFAULT_SETTINGS };

    for (const key of Object.keys(RANGES) as Array<keyof typeof RANGES>) {
      const range = RANGES[key];
      const value = parsed[key];
      if (isValidNumber(value, range.min, range.max)) {
        (result[key] as number) = key === 'treasureCount' ? Math.round(value) : value;
      }
    }
    if (typeof parsed.gameMode === 'string' && (GAME_MODES as string[]).includes(parsed.gameMode)) {
      result.gameMode = parsed.gameMode as GameMode;
    }
    if (typeof parsed.soundEnabled === 'boolean') {
      result.soundEnabled = parsed.soundEnabled;
    }
    if (typeof parsed.vibrationEnabled === 'boolean') {
      result.vibrationEnabled = parsed.vibrationEnabled;
    }
    return result;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: GameSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // localStorageが利用不可(プライベートモード等)の場合は無視する
  }
}
