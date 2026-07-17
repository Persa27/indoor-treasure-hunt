// エントリポイント。全モジュールの配線を行う。対応SPEC.md: セクション3(ゲームルール), 5(画面遷移)
import type { Scene } from 'three';
import { ARSession, type ARSessionCallbacks, type ARFrameHook } from './ar/session';
import { TreasureAnchor } from './ar/anchor';
import { TreasureView } from './scene/treasure';
import { CoinView } from './scene/coin';
import { DigMarks } from './scene/digMarks';
import { GameStateMachine, type StateChangeCtx } from './game/state';
import { TurnTimer } from './game/timer';
import { DigJudge } from './game/judge';
import { computeRadar } from './game/radar';
import { Beeper } from './audio/beeper';
import { OverlayUI, icon, type UIActions } from './ui/overlay';
import { loadSettings, saveSettings } from './settings';
import type { GamePhase, GameSettings, ITreasureView, Vec3 } from './types';

function createTreasureView(mode: GameSettings['gameMode'], scene: Scene): ITreasureView {
  return mode === 'coin' ? new CoinView(scene) : new TreasureView(scene);
}

const NOT_SUPPORTED_REASON =
  'この端末はAR機能(WebXR immersive-ar)に対応していません。ARCore対応のAndroid Chromeが必要です。';

function mapStartErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : (err as { name?: string } | undefined)?.name;
  if (name === 'NotAllowedError') {
    return 'カメラの使用が許可されませんでした。Chromeのサイト設定からカメラ権限を許可してください。';
  }
  if (name === 'NotSupportedError') {
    return 'この端末はAR機能(WebXR immersive-ar)に対応していません。';
  }
  if (name === 'SecurityError') {
    return 'セキュリティ上の理由でARセッションを開始できませんでした。HTTPS接続でアクセスしているかご確認ください。';
  }
  return 'ARセッションの開始に失敗しました。しばらくしてから再度お試しください。';
}

const root = document.getElementById('overlay');
if (!root) {
  throw new Error('#overlay root element not found');
}

let settings: GameSettings = loadSettings();

const beeper = new Beeper();
beeper.setEnabled(settings.soundEnabled);

const timer = new TurnTimer();

interface TreasureSlot {
  anchor: TreasureAnchor;
  view: ITreasureView;
  found: boolean;
  /** コインモード: プレイヤーが遠いため非表示にしているか(ヒステリシス判定用に保持) */
  hiddenByDistance: boolean;
}

// ゲーム進行中に生成/破棄されるAR依存オブジェクト
let session: ARSession | null = null;
let treasures: TreasureSlot[] = [];
let digMarks: DigMarks | null = null;
let judge: DigJudge | null = null;

let viewerPos: Vec3 | null = null;
let lastFrameTimeMs: number | null = null;

// 隠すターンのダブルタップ削除: 既存のたから(30cm以内)を600ms以内に2回タップで削除
const HIDE_DELETE_TAP_NEAR_M = 0.3;
const HIDE_DOUBLE_TAP_MS = 600;
// ズレなおし: 画面中央のhit-test点から1m以内の未回収コインを置き直す
const RESYNC_SNAP_M = 1.0;

let lastHideTapSlot: TreasureSlot | null = null;
let lastHideTapAtMs = 0;
let resyncPending = false;

let cooldownIntervalId: ReturnType<typeof setInterval> | null = null;
let resultTimeoutId: ReturnType<typeof setTimeout> | null = null;
let sessionEndingIntentionally = false;

function onPhaseChange(phase: GamePhase, ctx: StateChangeCtx): void {
  overlay.showPhase(phase, { result: ctx.result, errorMsg: ctx.errorMsg });
}

const state = new GameStateMachine({ onPhaseChange });

const actions: UIActions = {
  onStartGame: () => {
    void startGame();
  },
  onOpenSettings: () => {
    state.toSettings();
  },
  onCloseSettings: (s) => {
    settings = s;
    saveSettings(settings);
    beeper.setEnabled(settings.soundEnabled);
    overlay.setVibrationEnabled(settings.vibrationEnabled);
    state.toTitle();
  },
  onConfirmHide: () => {
    if (state.getPhase() !== 'hide') return;
    if (treasures.length === 0) return;
    finishHideTurn(true);
  },
  onStartSeek: () => {
    if (state.getPhase() !== 'handover') return;
    judge = new DigJudge(settings);
    timer.start(settings.seekTimeSec, (remain) => overlay.updateTimer(remain), onSeekTimeExpire);
    session?.setSelectEnabled(true);
    startCooldownPolling();
    state.startSeek();
    overlay.updateSeekRemaining(remainingCount());
  },
  onResync: () => {
    if (state.getPhase() !== 'seek' || settings.gameMode !== 'coin') return;
    // hit-test結果はXRフレーム内でしか安全に扱えないため、次のフレームループで処理する
    resyncPending = true;
  },
  onRetry: () => {
    handleRetry();
  },
};

const overlay = new OverlayUI(root, actions);
overlay.setSettings(settings);

// ---------------------------------------------------------------------
// ARセッションコールバック
// ---------------------------------------------------------------------

const sessionCallbacks: ARSessionCallbacks = {
  onViewerMove(pos) {
    viewerPos = pos;
  },
  onSelect(hit) {
    handleSelect(hit);
  },
  onTrackingChange(degraded) {
    if (degraded) {
      overlay.toast(`${icon('compass')} ちょっと道に迷ったかも。明るい場所でゆっくり動かしてね`);
    }
  },
  onSessionEnd() {
    handleSessionEnd();
  },
};

const frameHook: ARFrameHook = (frame, refSpace) => {
  const now = performance.now();
  const dt = lastFrameTimeMs === null ? 0 : now - lastFrameTimeMs;
  lastFrameTimeMs = now;

  if (resyncPending) {
    resyncPending = false;
    processResync(frame);
  }

  for (const t of treasures) {
    t.anchor.updateFromFrame(frame, refSpace);
    // アンカーの補正済み位置にビューを毎フレーム追従させる(空間マップ補正による見た目のズレ防止)
    const pos = t.anchor.getPosition();
    if (pos) t.view.moveTo(pos);
    t.view.update(dt);
  }

  // コインモード: 探索中は「コインが見える距離」より近づいたときだけコインを表示する(SPEC 3.4b)。
  // 境界での表示ちらつきを防ぐため、非表示に戻す閾値には+0.3mのヒステリシスを持たせる。
  if (settings.gameMode === 'coin' && state.getPhase() === 'seek' && viewerPos) {
    for (const t of treasures) {
      if (t.found) continue;
      const pos = t.anchor.getPosition();
      if (!pos) continue;
      const dx = pos.x - viewerPos.x;
      const dy = pos.y - viewerPos.y;
      const dz = pos.z - viewerPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const limit = t.hiddenByDistance ? settings.coinVisibleDistM : settings.coinVisibleDistM + 0.3;
      const hidden = dist > limit;
      if (hidden !== t.hiddenByDistance) {
        t.hiddenByDistance = hidden;
        t.view.setProximityHidden(hidden);
      }
    }
  }

  // レーダーは探索ターン中は常時起動(SPEC 3.5)。ターン終了時はstopSeekLoopsで必ず停止する。
  if (state.getPhase() === 'seek' && viewerPos) {
    const nearest = nearestRemainingTreasurePos(viewerPos);
    if (nearest) {
      const fb = computeRadar(viewerPos, nearest, settings);
      overlay.setRadarGlow(fb);
      beeper.updateRadar(fb);
    }
  }
};

function remainingCount(): number {
  return treasures.filter((t) => !t.found).length;
}

function distance3D(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 未発見のたからのうち、posから半径radiusM以内で最も近いスロットを返す。 */
function findSlotNear(pos: Vec3, radiusM: number): TreasureSlot | null {
  let best: TreasureSlot | null = null;
  let bestDist = radiusM;
  for (const t of treasures) {
    if (t.found) continue;
    const p = t.anchor.getPosition();
    if (!p) continue;
    const d = distance3D(pos, p);
    if (d <= bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

/**
 * コインのズレなおし(XRフレーム内で実行): 画面中央のhit-test点に最も近い未回収コイン(1m以内)を
 * その点へ置き直し、アンカーも実面上で再作成する。空間マップのズレでコインが面から浮いて見え、
 * タップ光線が別の面に当たって判定距離が合わなくなった状態を復旧する。
 */
function processResync(frame: XRFrame): void {
  if (!session || settings.gameMode !== 'coin' || state.getPhase() !== 'seek') return;

  const viewerHit = session.getViewerHitFromFrame(frame);
  if (!viewerHit) {
    overlay.showMoveGuide(`${icon('magnifier')} ゆかや棚が見つからないよ。スマホを8の字に動かしてね`);
    return;
  }

  const slot = findSlotNear(viewerHit.pos, RESYNC_SNAP_M);
  if (!slot) {
    overlay.toast(`${icon('compass')} コインの近くで、コインを画面のまんなかにうつして押してね`);
    return;
  }

  void slot.anchor.place(viewerHit.pos, viewerHit.hitResult);
  slot.hiddenByDistance = false;
  slot.view.showAt(viewerHit.pos);
  overlay.toast(`${icon('coin')} コインの場所をなおしたよ！`);
}

function nearestRemainingTreasurePos(from: Vec3): Vec3 | null {
  let best: Vec3 | null = null;
  let bestDistSq = Infinity;
  for (const t of treasures) {
    if (t.found) continue;
    const pos = t.anchor.getPosition();
    if (!pos) continue;
    const dx = pos.x - from.x;
    const dy = pos.y - from.y;
    const dz = pos.z - from.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = pos;
    }
  }
  return best;
}

// ---------------------------------------------------------------------
// ゲーム開始
// ---------------------------------------------------------------------

async function startGame(): Promise<void> {
  await beeper.resume();

  const newSession = new ARSession(root!, sessionCallbacks);
  try {
    await newSession.start();
  } catch (err) {
    state.toError(mapStartErrorMessage(err));
    return;
  }

  session = newSession;
  treasures = [];
  digMarks = new DigMarks(session.getScene());
  lastFrameTimeMs = null;
  session.setFrameHook(frameHook);
  session.setSelectEnabled(true);
  overlay.setConfirmEnabled(false);
  overlay.updateHideProgress(0, settings.treasureCount);

  timer.start(settings.hideTimeSec, (remain) => overlay.updateTimer(remain), onHideTimeExpire);
  state.startGame();
}

// ---------------------------------------------------------------------
// 隠すターン
// ---------------------------------------------------------------------

function handleSelect(hit: Vec3 | null): void {
  const phase = state.getPhase();
  if (phase === 'hide') {
    if (!hit) {
      overlay.showMoveGuide(`${icon('magnifier')} ゆかや棚が見つからないよ。スマホを8の字に動かしてね`);
      return;
    }

    // 置いたたからの近く(30cm以内)のタップは配置・移動ではなく削除操作として扱う。
    // 600ms以内の2回タップ(ダブルタップ)でそのたからを削除し、再配置できるようにする。
    const nearSlot = findSlotNear(hit, HIDE_DELETE_TAP_NEAR_M);
    if (nearSlot) {
      const now = performance.now();
      if (nearSlot === lastHideTapSlot && now - lastHideTapAtMs <= HIDE_DOUBLE_TAP_MS) {
        lastHideTapSlot = null;
        removeTreasureSlot(nearSlot);
        overlay.toast(`${icon('spade')} けしたよ！べつの場所に置けるよ`);
        overlay.updateHideProgress(treasures.length, settings.treasureCount);
        overlay.setConfirmEnabled(treasures.length >= settings.treasureCount);
      } else {
        lastHideTapSlot = nearSlot;
        lastHideTapAtMs = now;
        overlay.toast(`もういちどすばやくタップすると消せるよ`);
      }
      return;
    }
    lastHideTapSlot = null;

    const hitResult = session?.getLastHitResult() ?? undefined;
    if (treasures.length < settings.treasureCount) {
      const slot: TreasureSlot = {
        anchor: new TreasureAnchor(),
        view: createTreasureView(settings.gameMode, session!.getScene()),
        found: false,
        hiddenByDistance: false,
      };
      void slot.anchor.place(hit, hitResult);
      slot.view.showAt(hit);
      treasures.push(slot);
    } else {
      const last = treasures[treasures.length - 1];
      void last.anchor.place(hit, hitResult);
      last.view.showAt(hit);
    }
    overlay.updateHideProgress(treasures.length, settings.treasureCount);
    overlay.setConfirmEnabled(treasures.length >= settings.treasureCount);
  } else if (phase === 'seek') {
    handleSeekSelect(hit);
  }
}

/** 隠すターンでのたから削除: アンカー・ビューを破棄してスロットを取り除く。 */
function removeTreasureSlot(slot: TreasureSlot): void {
  const idx = treasures.indexOf(slot);
  if (idx < 0) return;
  treasures.splice(idx, 1);
  slot.anchor.clear();
  slot.view.dispose();
}

function onHideTimeExpire(): void {
  finishHideTurn(treasures.length > 0);
}

function finishHideTurn(placed: boolean): void {
  timer.stop();
  session?.setSelectEnabled(false);
  if (placed) {
    for (const t of treasures) t.view.hide();
    state.confirmHide(true);
  } else {
    state.confirmHide(false);
  }
}

// ---------------------------------------------------------------------
// 見つけるターン
// ---------------------------------------------------------------------

function handleSeekSelect(hit: Vec3 | null): void {
  if (!judge || judge.isCoolingDown()) return;
  if (!hit) {
    overlay.showMoveGuide(`${icon('magnifier')} ゆかや棚が見つからないよ。スマホを8の字に動かしてね`);
    return;
  }

  let bestSlot: TreasureSlot | null = null;
  let bestDist = Infinity;
  for (const t of treasures) {
    if (t.found) continue;
    const pos = t.anchor.getPosition();
    if (!pos) continue;
    const result = judge.judge(hit, pos);
    if (result.hit && result.distanceM < bestDist) {
      bestDist = result.distanceM;
      bestSlot = t;
    }
  }

  if (bestSlot) {
    handleSeekSuccess(bestSlot);
  } else {
    // showMissは位置にダストを出すだけの演出。コインモードでは「掘る」概念がないためno-opになる
    treasures[0].view.showMiss(hit);
    if (settings.gameMode === 'chest') {
      digMarks?.addDigMark(hit);
    }
    beeper.playMiss();
    judge.startCooldown();
  }
}

function stopSeekLoops(): void {
  timer.stop();
  session?.setSelectEnabled(false);
  stopCooldownPolling();
  overlay.setRadarGlow(null);
  beeper.stopRadar();
}

function handleSeekSuccess(slot: TreasureSlot): void {
  slot.found = true;
  const pos = slot.anchor.getPosition();
  if (pos) slot.view.collect(pos);
  beeper.playPop();
  setTimeout(() => beeper.playSuccess(), 250);

  overlay.updateSeekRemaining(remainingCount());

  const remaining = treasures.some((t) => !t.found);
  if (remaining) {
    // まだ未発見の宝箱が残っているため探索を継続する
    judge?.startCooldown();
    return;
  }

  stopSeekLoops();
  resultTimeoutId = setTimeout(() => {
    resultTimeoutId = null;
    state.finishSeek('seeker-win');
  }, 1500);
}

function onSeekTimeExpire(): void {
  stopSeekLoops();
  for (const t of treasures) {
    if (t.found) continue;
    const pos = t.anchor.getPosition();
    if (pos) t.view.reveal(pos);
  }
  // コインモードは常時可視のため、時間切れ時の「ポンッ」演出は宝箱モードのみ鳴らす
  if (settings.gameMode === 'chest') {
    beeper.playPop();
  }
  resultTimeoutId = setTimeout(() => {
    resultTimeoutId = null;
    state.finishSeek('hider-win');
  }, 1500);
}

function startCooldownPolling(): void {
  stopCooldownPolling();
  cooldownIntervalId = setInterval(() => {
    overlay.updateCooldown(judge?.cooldownRemainMs() ?? 0);
  }, 100);
}

function stopCooldownPolling(): void {
  if (cooldownIntervalId !== null) {
    clearInterval(cooldownIntervalId);
    cooldownIntervalId = null;
  }
}

// ---------------------------------------------------------------------
// セッション終了・異常系・リセット
// ---------------------------------------------------------------------

function handleSessionEnd(): void {
  const wasIntentional = sessionEndingIntentionally;
  sessionEndingIntentionally = false;
  const phaseAtEnd = state.getPhase();

  resetMatchState();

  if (wasIntentional) {
    state.toTitle();
    return;
  }

  if (phaseAtEnd === 'hide' || phaseAtEnd === 'handover' || phaseAtEnd === 'seek') {
    state.abort();
  }
}

function resetMatchState(): void {
  timer.stop();
  stopCooldownPolling();
  if (resultTimeoutId !== null) {
    clearTimeout(resultTimeoutId);
    resultTimeoutId = null;
  }
  overlay.setRadarGlow(null);
  beeper.stopRadar();

  session = null;
  treasures = [];
  digMarks = null;
  judge = null;
  viewerPos = null;
  lastFrameTimeMs = null;
  lastHideTapSlot = null;
  lastHideTapAtMs = 0;
  resyncPending = false;
}

function handleRetry(): void {
  if (session) {
    sessionEndingIntentionally = true;
    void session.end();
  } else {
    resetMatchState();
    state.toTitle();
  }
}

// ---------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  const supported = await ARSession.isSupported();
  overlay.setStartEnabled(supported, supported ? undefined : NOT_SUPPORTED_REASON);
  state.toTitle();
}

void bootstrap();
