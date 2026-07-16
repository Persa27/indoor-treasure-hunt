// エントリポイント。全モジュールの配線を行う。対応SPEC.md: セクション3(ゲームルール), 5(画面遷移)
import { ARSession, type ARSessionCallbacks, type ARFrameHook } from './ar/session';
import { TreasureAnchor } from './ar/anchor';
import { TreasureView } from './scene/treasure';
import { DigMarks } from './scene/digMarks';
import { GameStateMachine, type StateChangeCtx } from './game/state';
import { TurnTimer } from './game/timer';
import { DigJudge } from './game/judge';
import { computeRadar } from './game/radar';
import { Beeper } from './audio/beeper';
import { OverlayUI, type UIActions } from './ui/overlay';
import { loadSettings, saveSettings } from './settings';
import type { GamePhase, GameSettings, Vec3 } from './types';

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

// ゲーム進行中に生成/破棄されるAR依存オブジェクト
let session: ARSession | null = null;
let anchor: TreasureAnchor | null = null;
let treasureView: TreasureView | null = null;
let digMarks: DigMarks | null = null;
let judge: DigJudge | null = null;

let viewerPos: Vec3 | null = null;
let lastFrameTimeMs: number | null = null;

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
    if (!anchor?.getPosition()) return;
    finishHideTurn(true);
  },
  onStartSeek: () => {
    if (state.getPhase() !== 'handover') return;
    judge = new DigJudge(settings);
    timer.start(settings.seekTimeSec, (remain) => overlay.updateTimer(remain), onSeekTimeExpire);
    session?.setSelectEnabled(true);
    startCooldownPolling();
    state.startSeek();
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
      overlay.toast('トラッキングが不安定です。明るい場所でゆっくり動かしてください');
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

  anchor?.updateFromFrame(frame, refSpace);
  treasureView?.update(dt);

  // レーダーは探索ターン中は常時起動(SPEC 3.5)。ターン終了時はstopSeekLoopsで必ず停止する。
  if (state.getPhase() === 'seek' && viewerPos) {
    const treasurePos = anchor?.getPosition();
    if (treasurePos) {
      const fb = computeRadar(viewerPos, treasurePos, settings);
      overlay.setRadarGlow(fb);
      beeper.updateRadar(fb);
    }
  }
};

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
  treasureView = new TreasureView(session.getScene());
  digMarks = new DigMarks(session.getScene());
  anchor = new TreasureAnchor();
  lastFrameTimeMs = null;
  session.setFrameHook(frameHook);
  session.setSelectEnabled(true);
  overlay.setConfirmEnabled(false);

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
      overlay.toast('平面を検出できません。少し端末を動かしてください');
      return;
    }
    void anchor?.place(hit, session?.getLastHitResult() ?? undefined);
    treasureView?.showAt(hit);
    overlay.setConfirmEnabled(true);
  } else if (phase === 'seek') {
    handleSeekSelect(hit);
  }
}

function onHideTimeExpire(): void {
  finishHideTurn(anchor?.getPosition() != null);
}

function finishHideTurn(placed: boolean): void {
  timer.stop();
  session?.setSelectEnabled(false);
  if (placed) {
    treasureView?.hide();
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
    overlay.toast('平面を検出できません。少し端末を動かしてください');
    return;
  }
  const treasurePos = anchor?.getPosition();
  if (!treasurePos) return;

  const result = judge.judge(hit, treasurePos);
  if (result.hit) {
    handleSeekSuccess(treasurePos);
  } else {
    treasureView?.showMiss(hit);
    digMarks?.addDigMark(hit);
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

function handleSeekSuccess(treasurePos: Vec3): void {
  stopSeekLoops();
  treasureView?.reveal(treasurePos);
  beeper.playPop();
  setTimeout(() => beeper.playSuccess(), 250);
  resultTimeoutId = setTimeout(() => {
    resultTimeoutId = null;
    state.finishSeek('seeker-win');
  }, 1500);
}

function onSeekTimeExpire(): void {
  stopSeekLoops();
  const pos = anchor?.getPosition();
  if (pos) {
    treasureView?.reveal(pos);
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
  anchor = null;
  treasureView = null;
  digMarks = null;
  judge = null;
  viewerPos = null;
  lastFrameTimeMs = null;
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
