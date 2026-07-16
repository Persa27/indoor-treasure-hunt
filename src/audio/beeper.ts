// 担当Phase2エージェントが実装する。対応SPEC.md: 3.5(レーダー音), 6.5(効果音), 6.6(オシレータ使い回し)
import type { RadarFeedback } from '../types';

// AudioContextを生成する古いWebKit実装向けのグローバル拡張
interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

export class Beeper {
  private enabled = true;
  private audioCtx: AudioContext | null = null;

  // レーダー用スケジューラ。OscillatorNodeはstart/stopが一度きりの仕様のため
  // 使い回せないが、GC負荷を抑えるためタイマー管理は使い回す(SPEC 6.6)。
  private radarTimerId: ReturnType<typeof setTimeout> | null = null;
  private radarFeedback: RadarFeedback | null = null;
  private radarActive = false;

  constructor() {
    // AudioContextの生成はresume()呼び出し(ユーザー操作後)まで遅延させる想定
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.stopRadar();
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.audioCtx) return this.audioCtx;
    const w = window as WindowWithWebkitAudio;
    const Ctor = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    this.audioCtx = new Ctor();
    return this.audioCtx;
  }

  async resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  /** sine波の短いビープを1回鳴らす。オシレータは都度生成(仕様上使い回せない)だが、
   * クリックノイズ防止用のgainエンベロープはシンプルな形状に統一している。 */
  private playTone(freqHz: number, durationSec: number, peakGain = 0.25, type: OscillatorType = 'sine'): void {
    if (!this.enabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      // resume前は音を出さない(自動再生制限)
      return;
    }

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqHz, now);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.008);
    gain.gain.setValueAtTime(peakGain, now + Math.max(0.008, durationSec - 0.02));
    gain.gain.linearRampToValueAtTime(0, now + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + durationSec + 0.02);
    osc.addEventListener('ended', () => {
      osc.disconnect();
      gain.disconnect();
    });
  }

  startRadar(): void {
    this.radarActive = true;
    this.scheduleNextRadarBeep(0);
  }

  updateRadar(fb: RadarFeedback): void {
    this.radarFeedback = fb;
    if (!this.radarActive) {
      this.startRadar();
    }
  }

  private scheduleNextRadarBeep(delayMs: number): void {
    if (this.radarTimerId !== null) {
      clearTimeout(this.radarTimerId);
      this.radarTimerId = null;
    }
    if (!this.radarActive) return;

    this.radarTimerId = setTimeout(() => {
      if (!this.radarActive) return;
      const fb = this.radarFeedback;
      if (fb) {
        // hot帯は「ピピピ連続音」なのでビープを短く・密に鳴らす
        this.playTone(fb.beepFreqHz, fb.level === 'hot' ? 0.09 : 0.06, 0.22);
        this.scheduleNextRadarBeep(fb.beepIntervalMs);
      } else {
        this.scheduleNextRadarBeep(500);
      }
    }, delayMs);
  }

  stopRadar(): void {
    this.radarActive = false;
    this.radarFeedback = null;
    if (this.radarTimerId !== null) {
      clearTimeout(this.radarTimerId);
      this.radarTimerId = null;
    }
  }

  /** 上昇アルペジオ風ファンファーレ(5音+仕上げのキラキラ和音)。子ども向けに明るく賑やかな音色にする。 */
  playSuccess(): void {
    if (!this.enabled) return;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5]; // C5, E5, G5, C6, E6
    const ctx = this.ensureContext();
    if (!ctx || ctx.state === 'suspended') return;
    notes.forEach((freq, i) => {
      const startAt = ctx.currentTime + i * 0.09;
      const delayMs = Math.max(0, (startAt - ctx.currentTime) * 1000);
      setTimeout(() => this.playTone(freq, 0.2, 0.3, 'triangle'), delayMs);
    });
    // 仕上げのキラキラ和音(高音の同時鳴り)
    const sparkleDelayMs = notes.length * 90 + 40;
    setTimeout(() => {
      this.playTone(1567.98, 0.35, 0.2, 'sine'); // G6
      this.playTone(2093, 0.35, 0.14, 'sine'); // C7
    }, sparkleDelayMs);
  }

  /** スコップで掘る「ポフッ」という軽くコミカルな短い音(子ども向けに柔らかく)。 */
  playMiss(): void {
    if (!this.enabled) return;
    const ctx = this.ensureContext();
    if (!ctx || ctx.state === 'suspended') return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.14);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.24, now + 0.01);
    gain.gain.linearRampToValueAtTime(0, now + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
    osc.addEventListener('ended', () => {
      osc.disconnect();
      gain.disconnect();
    });
  }

  /** 宝箱が地中から飛び出す「ポンッ」という短い音(周波数が急上昇するsine)。 */
  playPop(): void {
    if (!this.enabled) return;
    const ctx = this.ensureContext();
    if (!ctx || ctx.state === 'suspended') return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(900, now + 0.12);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.32, now + 0.015);
    gain.gain.linearRampToValueAtTime(0, now + 0.16);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
    osc.addEventListener('ended', () => {
      osc.disconnect();
      gain.disconnect();
    });
  }
}
