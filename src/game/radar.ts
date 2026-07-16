// 担当Phase2エージェントが実装する。対応SPEC.md: 3.5(レーダー)
import type { GameSettings, RadarFeedback, RadarLevel, Vec3 } from '../types';

function distance3D(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const FAR_INTERVAL_MS = 2000;
const MID_INTERVAL_MS = 1000;
const NEAR_INTERVAL_MS = 400;
const HOT_INTERVAL_MS = 150;

const FAR_FREQ_HZ = 500;
const HOT_FREQ_HZ = 1200;

export function computeRadar(viewer: Vec3, treasure: Vec3, s: GameSettings): RadarFeedback {
  const distanceM = distance3D(viewer, treasure);

  let level: RadarLevel;
  let beepIntervalMs: number;
  if (distanceM > s.radarFarM) {
    level = 'far';
    beepIntervalMs = FAR_INTERVAL_MS;
  } else if (distanceM > s.radarMidM) {
    level = 'mid';
    beepIntervalMs = MID_INTERVAL_MS;
  } else if (distanceM > s.radarNearM) {
    level = 'near';
    beepIntervalMs = NEAR_INTERVAL_MS;
  } else {
    level = 'hot';
    beepIntervalMs = HOT_INTERVAL_MS;
  }

  // 距離に応じ500(遠)〜1200(近)を連続補間。radarFarMを超える距離は500Hzに、0は1200Hzにクランプする。
  const t = 1 - Math.min(1, Math.max(0, distanceM / s.radarFarM));
  const beepFreqHz = FAR_FREQ_HZ + t * (HOT_FREQ_HZ - FAR_FREQ_HZ);

  return { level, distanceM, beepIntervalMs, beepFreqHz };
}
