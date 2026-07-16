// 担当Phase2エージェントが実装する。対応SPEC.md: セクション5(画面遷移)
import type { GamePhase, GameResult, Vec3 } from '../types';

export interface StateChangeCtx {
  result?: GameResult;
  treasurePos?: Vec3;
  errorMsg?: string;
}

export interface StateEvents {
  onPhaseChange(phase: GamePhase, ctx: StateChangeCtx): void;
}

export class GameStateMachine {
  private phase: GamePhase = 'title';
  private readonly events: StateEvents;

  constructor(events: StateEvents) {
    this.events = events;
  }

  getPhase(): GamePhase {
    return this.phase;
  }

  private transition(phase: GamePhase, ctx: StateChangeCtx = {}): void {
    this.phase = phase;
    this.events.onPhaseChange(phase, ctx);
  }

  toTitle(): void {
    this.transition('title');
  }

  toSettings(): void {
    this.transition('settings');
  }

  startGame(): void {
    // ARStart -> HideTurn (成功時)。ARStart -> Error (非対応/権限拒否時)はtoErrorで表現する。
    this.transition('hide');
  }

  confirmHide(placed: boolean): void {
    // 確定 or 時間切れ(配置済み) -> Handover / 未配置で時間切れ -> Result(hider-forfeit)
    if (placed) {
      this.transition('handover');
    } else {
      this.transition('result', { result: 'hider-forfeit' });
    }
  }

  startSeek(): void {
    this.transition('seek');
  }

  finishSeek(result: GameResult): void {
    this.transition('result', { result });
  }

  abort(): void {
    this.transition('result', { result: 'aborted' });
  }

  toError(msg: string): void {
    this.transition('error', { errorMsg: msg });
  }
}
