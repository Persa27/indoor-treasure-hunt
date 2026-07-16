// 担当Phase2エージェントが実装する。対応SPEC.md: 2(宝箱位置の空間固定), 6.2, 6.4, 12(将来拡張の抽象化レイヤー)
import type { Vec3 } from '../types';

export class TreasureAnchor {
  private position: Vec3 | null = null;
  private anchor: XRAnchor | null = null;

  async place(pos: Vec3, hitResult?: XRHitTestResult): Promise<void> {
    // anchors対応なら hitResult.createAnchor() を利用、非対応時はワールド座標(pos)を保持する(フォールバック)。
    // 置き直しのたびに古いanchorは破棄する。
    this.releaseAnchor();

    this.position = pos;

    if (hitResult && typeof hitResult.createAnchor === 'function') {
      try {
        const anchor = await hitResult.createAnchor();
        if (anchor) {
          this.anchor = anchor;
        }
      } catch {
        // anchors非対応・作成失敗時はワールド座標フォールバックのまま
        this.anchor = null;
      }
    }
  }

  getPosition(): Vec3 | null {
    return this.position;
  }

  clear(): void {
    this.releaseAnchor();
    this.position = null;
  }

  updateFromFrame(frame: XRFrame, refSpace: XRReferenceSpace): void {
    if (!this.anchor) return;
    const pose = frame.getPose(this.anchor.anchorSpace, refSpace);
    if (pose) {
      const p = pose.transform.position;
      this.position = { x: p.x, y: p.y, z: p.z };
    }
  }

  private releaseAnchor(): void {
    if (this.anchor) {
      try {
        this.anchor.delete();
      } catch {
        // 既に破棄済み等は無視
      }
      this.anchor = null;
    }
  }
}
