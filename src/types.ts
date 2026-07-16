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

export type GameMode = 'chest' | 'coin';
// chest: 埋まった宝箱を掘って探す通常モード / coin: 埋めずに常時可視化されたコインをタップして集めるモード

export interface GameSettings {
  gameMode: GameMode; // default 'chest'
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
  gameMode: 'chest',
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

/**
 * 隠す対象(宝箱/コイン)の見た目・演出を担当するビューの共通契約。
 * game/state.tsやmain.tsはモードを問わずこのインタフェースだけを扱う。
 */
export interface ITreasureView {
  /** 隠すターンのプレビュー表示(呼ぶたび移動)。 */
  showAt(pos: Vec3): void;
  /**
   * アンカーの補正済み位置への毎フレーム追従(位置のみ更新、演出状態はリセットしない)。
   * ARCoreの空間マップ補正でアンカー位置が動いたとき、見た目を実空間に張り付かせるために必要。
   */
  moveTo(pos: Vec3): void;
  /** 確定後の見た目切り替え(宝箱: 非表示化/コイン: 常時可視のため何もしない)。 */
  hide(): void;
  /** 未発見のまま時間切れになった際の開示演出。 */
  reveal(pos: Vec3): void;
  /** 見つける側が発見・回収したときの演出。 */
  collect(pos: Vec3): void;
  /** ハズレのタップに対する演出。 */
  showMiss(pos: Vec3): void;
  update(dtMs: number): void;
}

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
