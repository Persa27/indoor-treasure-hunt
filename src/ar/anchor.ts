// 担当Phase2エージェントが実装する。対応SPEC.md: 2(宝箱位置の空間固定), 6.2, 6.4, 12(将来拡張の抽象化レイヤー)
import type { Vec3 } from '../types';

export class TreasureAnchor {
  private position: Vec3 | null = null;
  private anchor: XRAnchor | null = null;
  private placeToken = 0;

  async place(pos: Vec3, hitResult?: XRHitTestResult): Promise<void> {
    // anchors対応なら hitResult.createAnchor() を利用、非対応時はワールド座標(pos)を保持する(フォールバック)。
    // 置き直しのたびに古いanchorは破棄する。
    // createAnchor()は非同期のため、置き直し連打で複数のplace()が並行実行されうる。
    // 呼び出しごとにトークンを発行し、後から解決した古い呼び出しの結果で
    // 新しい呼び出しの結果を上書きしないようにする。
    const token = ++this.placeToken;
    this.releaseAnchor();

    this.position = pos;

    if (hitResult && typeof hitResult.createAnchor === 'function') {
      try {
        const anchor = await hitResult.createAnchor();
        if (token !== this.placeToken) {
          // 待っている間により新しいplace()が呼ばれた。この結果は破棄する。
          anchor?.delete();
          return;
        }
        if (anchor) {
          this.anchor = anchor;
        }
      } catch {
        if (token !== this.placeToken) return;
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
