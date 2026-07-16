// 担当Phase2エージェントが実装する。対応SPEC.md: 3.2, 3.4(ターン制限時間)
export class TurnTimer {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private startedAtMs = 0;
  private durationSec = 0;
  private onTick: ((remainSec: number) => void) | null = null;
  private onExpire: (() => void) | null = null;
  private expired = false;

  start(sec: number, onTick: (remainSec: number) => void, onExpire: () => void): void {
    // 前のタイマーが動いていれば停止してから開始する
    this.stop();

    this.durationSec = sec;
    this.onTick = onTick;
    this.onExpire = onExpire;
    this.startedAtMs = performance.now();
    this.expired = false;

    // 即座に開始時点の残り時間を通知する
    onTick(sec);

    this.intervalId = setInterval(() => {
      this.tick();
    }, 200);
  }

  private tick(): void {
    if (this.expired || !this.onTick || !this.onExpire) return;

    const elapsedSec = (performance.now() - this.startedAtMs) / 1000;
    const remainSec = Math.max(0, Math.ceil(this.durationSec - elapsedSec));

    this.onTick(remainSec);

    if (remainSec <= 0) {
      this.expired = true;
      const onExpire = this.onExpire;
      this.stop();
      onExpire();
    }
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
