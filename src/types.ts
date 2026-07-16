// 全モジュール共通の型契約。
// SPEC.md セクション3-6を参照。Phase2エージェントはこのファイルの型を変更せず利用すること。
// 変更が必要な場合はこのプロジェクトの雛形担当と合意の上で行う。

export type GamePhase =
  | 'title'
  | 'settings'
  | 'hide'
  | 'handover'
  | 'seek'
  | 'result'
  | 'error';

export interface GameSettings {
  treasureCount: number; // default 1, range 1-5
  hideTimeSec: number; // default 60, range 15-300
  seekTimeSec: number; // default 180, range 30-600
  successRadiusM: number; // default 0.5, range 0.2-1.5
  digCooldownSec: number; // default 3, range 0-10
  radarNearM: number; // default 0.5
  radarMidM: number; // default 1.5
  radarFarM: number; // default 3.0
  soundEnabled: boolean; // default true
  vibrationEnabled: boolean; // default true
}

export const DEFAULT_SETTINGS: GameSettings = {
  treasureCount: 1,
  hideTimeSec: 60,
  seekTimeSec: 180,
  successRadiusM: 0.5,
  digCooldownSec: 3,
  radarNearM: 0.5,
  radarMidM: 1.5,
  radarFarM: 3.0,
  soundEnabled: true,
  vibrationEnabled: true,
};

export type RadarLevel = 'far' | 'mid' | 'near' | 'hot';
// far: dist > radarFarM / mid: radarMidM < dist <= radarFarM / near: radarNearM < dist <= radarMidM / hot: dist <= radarNearM

export interface RadarFeedback {
  level: RadarLevel;
  distanceM: number;
  beepIntervalMs: number; // far:2000, mid:1000, near:400, hot:150
  beepFreqHz: number; // 距離に応じ500(遠)〜1200(近)を連続補間
}

export type GameResult = 'seeker-win' | 'hider-win' | 'hider-forfeit' | 'aborted';
// seeker-win:発掘成功 / hider-win:時間切れ / hider-forfeit:未配置で隠し時間切れ / aborted:トラッキング喪失等の無効試合

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface DigJudgement {
  hit: boolean;
  distanceM: number;
}
