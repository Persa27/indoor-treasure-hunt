// 担当Phase2エージェントが実装する。対応SPEC.md: 3.4(発掘判定), 6.4(判定ロジック)
import type { DigJudgement, GameSettings, Vec3 } from '../types';

function distance3D(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class DigJudge {
  private readonly settings: GameSettings;
  private cooldownUntilMs = 0;

  constructor(settings: GameSettings) {
    this.settings = settings;
  }

  judge(tap: Vec3, treasure: Vec3): DigJudgement {
    const distanceM = distance3D(tap, treasure);
    const hit = distanceM <= this.settings.successRadiusM;
    return { hit, distanceM };
  }

  isCoolingDown(now: number = Date.now()): boolean {
    return now < this.cooldownUntilMs;
  }

  cooldownRemainMs(now: number = Date.now()): number {
    return Math.max(0, this.cooldownUntilMs - now);
  }

  startCooldown(now: number = Date.now()): void {
    this.cooldownUntilMs = now + this.settings.digCooldownSec * 1000;
  }
}
