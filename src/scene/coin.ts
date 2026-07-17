// 新規: コインモード用の常時可視オブジェクト。対応SPEC.md: 3.2b/3.4b(コインモード), 6.5, 6.6(パフォーマンス方針)
// 宝箱と異なり「埋める/掘る」演出は行わない。ITreasureView実装として宝箱ビューと差し替え可能にする。
import * as THREE from 'three';
import type { ITreasureView, Vec3 } from '../types';

const COIN_COLOR = 0xffd54a;
const COIN_EMISSIVE = 0xb8860b;

interface ParticleBurst {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  velocities: Float32Array;
  ageMs: number;
  lifeMs: number;
}

let cachedGlowTexture: THREE.Texture | null = null;

/** 加算合成の円形グローテクスチャ(実光源を使わずSPEC 6.6のパフォーマンス方針を守る)。使い回す。 */
function getGlowTexture(): THREE.Texture {
  if (cachedGlowTexture) return cachedGlowTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  cachedGlowTexture = new THREE.CanvasTexture(canvas);
  return cachedGlowTexture;
}

function buildCoin(): { disc: THREE.Mesh; material: THREE.MeshStandardMaterial; glow: THREE.Sprite } {
  const material = new THREE.MeshStandardMaterial({
    color: COIN_COLOR,
    emissive: COIN_EMISSIVE,
    emissiveIntensity: 0.6,
    roughness: 0.25,
    metalness: 0.85,
  });

  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 24), material);

  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.004, 8, 24), material);
  rim.rotation.x = Math.PI / 2;
  disc.add(rim);

  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: getGlowTexture(),
      color: 0xfff2b0,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  glow.scale.set(0.16, 0.16, 1);

  return { disc, material, glow };
}

export class CoinView implements ITreasureView {
  private readonly scene: THREE.Scene;
  private readonly group: THREE.Group;
  private readonly disc: THREE.Mesh;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly glow: THREE.Sprite;

  private ageMs = 0;
  /** showAt済みで、まだ回収されていない(=本来表示すべき)状態か */
  private shown = false;
  /** プレイヤーが「コインが見える距離」より遠いため非表示にしているか */
  private proximityHidden = false;
  private collecting = false;
  private collectAgeMs = 0;
  private readonly collectDurationMs = 420;

  private readonly bursts: ParticleBurst[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.scene.add(this.group);

    const { disc, material, glow } = buildCoin();
    this.disc = disc;
    this.material = material;
    this.glow = glow;
    this.group.add(disc);
    this.group.add(glow);
  }

  /**
   * 隠すターンのプレビュー: コインは埋めずに常時可視化する仕様のため、そのまま表示する。呼ぶたび移動。
   */
  showAt(pos: Vec3): void {
    this.collecting = false;
    this.group.position.set(pos.x, pos.y + 0.015, pos.z);
    this.shown = true;
    this.proximityHidden = false;
    this.applyVisibility();
    this.group.scale.setScalar(1);
    this.ageMs = 0;
  }

  /**
   * アンカー補正への毎フレーム追従。回収演出中は上昇アニメーションがgroup位置を
   * 直接動かしているため追従しない(0.4秒程度のためズレは無視できる)。
   */
  moveTo(pos: Vec3): void {
    if (this.collecting) return;
    this.group.position.set(pos.x, pos.y + 0.015, pos.z);
  }

  /** コインは確定後も常時可視化する仕様のため、非表示にしない。 */
  hide(): void {
    // no-op
  }

  /** 時間切れのネタバラシ: 距離による非表示を解除し、残ったコインを距離に関係なく見せる。 */
  reveal(_pos: Vec3): void {
    this.setProximityHidden(false);
  }

  /** 距離による表示制御。回収済み(shown=false)のコインには影響しない。 */
  setProximityHidden(hidden: boolean): void {
    if (this.proximityHidden === hidden) return;
    this.proximityHidden = hidden;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    this.group.visible = this.shown && !this.proximityHidden;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
      }
    });
    this.material.dispose();
    // glowのテクスチャ(cachedGlowTexture)は全コインで共有しているため破棄しない
    this.glow.material.dispose();
    for (const burst of this.bursts) {
      this.scene.remove(burst.points);
      burst.geometry.dispose();
      burst.material.dispose();
    }
    this.bursts.length = 0;
  }

  /** 見つける側がタップして回収した瞬間の演出(縮みながらキラキラ弾けて消える)。 */
  collect(pos: Vec3): void {
    if (this.collecting) return;
    this.collecting = true;
    this.collectAgeMs = 0;
    this.spawnSparkles(pos);
  }

  /** コインモードには「掘る」概念がないため、ハズレ演出は行わない。 */
  showMiss(_pos: Vec3): void {
    // no-op
  }

  update(dtMs: number): void {
    if (this.group.visible) {
      this.ageMs += dtMs;
      const t = this.ageMs / 1000;
      // コインの縁が見えたり消えたりする「回転」でめだたせる(見つけやすさのための演出)
      this.disc.rotation.x = t * 2.2;

      const pulse = 0.5 + Math.sin(t * 3.4) * 0.5;
      this.material.emissiveIntensity = 0.45 + pulse * 0.45;
      this.glow.material.opacity = 0.45 + pulse * 0.35;

      if (this.collecting) {
        this.collectAgeMs += dtMs;
        const ct = Math.min(1, this.collectAgeMs / this.collectDurationMs);
        this.group.scale.setScalar(Math.max(0, 1 - ct));
        this.group.position.y += dtMs * 0.0012;
        if (ct >= 1) {
          this.collecting = false;
          this.shown = false;
          this.applyVisibility();
        }
      }
    }

    this.updateBursts(dtMs);
  }

  private spawnSparkles(pos: Vec3): void {
    const count = 30;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      positions[idx] = 0;
      positions[idx + 1] = 0.02;
      positions[idx + 2] = 0;

      const angle = Math.random() * Math.PI * 2;
      const radius = 0.1 + Math.random() * 0.2;
      velocities[idx] = Math.cos(angle) * radius;
      velocities[idx + 1] = 0.5 + Math.random() * 0.6;
      velocities[idx + 2] = Math.sin(angle) * radius;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: 0xffe98a,
      size: 0.02,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    points.position.set(pos.x, pos.y, pos.z);
    this.scene.add(points);

    this.bursts.push({ points, geometry, material, velocities, ageMs: 0, lifeMs: 900 });
  }

  private updateBursts(dtMs: number): void {
    if (this.bursts.length === 0) return;
    const dt = dtMs / 1000;

    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      burst.ageMs += dtMs;

      const positions = burst.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = positions.array as Float32Array;

      for (let p = 0; p < arr.length; p += 3) {
        arr[p] += burst.velocities[p] * dt;
        arr[p + 1] += burst.velocities[p + 1] * dt;
        arr[p + 2] += burst.velocities[p + 2] * dt;
        burst.velocities[p + 1] += -0.5 * dt;
      }
      positions.needsUpdate = true;

      const lifeT = burst.ageMs / burst.lifeMs;
      burst.material.opacity = Math.max(0, 1 - lifeT);

      if (burst.ageMs >= burst.lifeMs) {
        this.scene.remove(burst.points);
        burst.geometry.dispose();
        burst.material.dispose();
        this.bursts.splice(i, 1);
      }
    }
  }
}
