// 担当Phase2エージェントが実装する。対応SPEC.md: 3.2, 3.4(埋める/掘り出す演出), 6.5(宝箱3Dモデル、Three.jsプリミティブ), 6.6(パフォーマンス方針)
import * as THREE from 'three';
import type { ITreasureView, Vec3 } from '../types';

const WOOD_COLOR = 0x6b4226;
const GOLD_COLOR = 0xd4af37;
const DIRT_COLOR = 0x5a3d22;

type ParticleKind = 'sparkle' | 'dust';

interface ParticleBurst {
  kind: ParticleKind;
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  velocities: Float32Array;
  ageMs: number;
  lifeMs: number;
}

function buildChest(): { group: THREE.Group; lid: THREE.Group; materials: THREE.MeshStandardMaterial[] } {
  const group = new THREE.Group();

  const woodMat = new THREE.MeshStandardMaterial({ color: WOOD_COLOR, roughness: 0.8, metalness: 0.1 });
  const goldMat = new THREE.MeshStandardMaterial({ color: GOLD_COLOR, roughness: 0.35, metalness: 0.8 });

  const bodyWidth = 0.3;
  const bodyHeight = 0.18;
  const bodyDepth = 0.2;

  // 本体
  const body = new THREE.Mesh(new THREE.BoxGeometry(bodyWidth, bodyHeight, bodyDepth), woodMat);
  body.position.y = bodyHeight / 2;
  group.add(body);

  // 本体の金具バンド
  const bandGeo = new THREE.BoxGeometry(bodyWidth + 0.005, 0.02, bodyDepth + 0.005);
  const bandFront = new THREE.Mesh(bandGeo, goldMat);
  bandFront.position.set(0, bodyHeight * 0.5, 0);
  group.add(bandFront);

  // 蓋(ヒンジ回転用にグループの原点を後端に置く)
  const lidHeight = 0.09;
  const lid = new THREE.Group();
  lid.position.set(0, bodyHeight, -bodyDepth / 2);
  group.add(lid);

  const lidMesh = new THREE.Mesh(
    new THREE.BoxGeometry(bodyWidth, lidHeight, bodyDepth),
    woodMat,
  );
  lidMesh.position.set(0, lidHeight / 2, bodyDepth / 2);
  lid.add(lidMesh);

  const lidBand = new THREE.Mesh(
    new THREE.BoxGeometry(bodyWidth + 0.005, 0.02, bodyDepth + 0.005),
    goldMat,
  );
  lidBand.position.set(0, lidHeight * 0.35, bodyDepth / 2);
  lid.add(lidBand);

  // 錠前
  const lock = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.02), goldMat);
  lock.position.set(0, bodyHeight - 0.01, bodyDepth / 2 + 0.01);
  group.add(lock);

  return { group, lid, materials: [woodMat, goldMat] };
}

function buildMound(): THREE.Mesh {
  // 土盛りマーク: 茶色の低い円錐
  const geometry = new THREE.ConeGeometry(0.17, 0.07, 16);
  const material = new THREE.MeshStandardMaterial({ color: DIRT_COLOR, roughness: 1, metalness: 0 });
  const mound = new THREE.Mesh(geometry, material);
  mound.position.y = 0.035;
  return mound;
}

// 着地バウンド付きのジャンプイージング(easeOutBack)。1を少し超えてから1へ収束する。
function easeOutBackJump(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = Math.min(1, Math.max(0, t));
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export class TreasureView implements ITreasureView {
  private readonly scene: THREE.Scene;
  private readonly group: THREE.Group;
  private readonly chest: THREE.Group;
  private readonly lid: THREE.Group;
  private readonly chestMaterials: THREE.MeshStandardMaterial[];
  private readonly mound: THREE.Mesh;

  private idleAgeMs = 0;
  private idleFloating = false;

  private lidOpen = false;
  private lidAngle = 0;
  private readonly lidOpenAngle = -Math.PI * 0.62;

  // 発掘演出(地中からポンッと飛び出す)用の状態
  private popping = false;
  private popAgeMs = 0;
  private readonly popDurationMs = 480;
  private popLanded = false;
  private popTargetPos: Vec3 | null = null;

  private readonly bursts: ParticleBurst[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.scene.add(this.group);

    const { group: chest, lid, materials } = buildChest();
    this.chest = chest;
    this.lid = lid;
    this.chestMaterials = materials;
    this.group.add(chest);

    this.mound = buildMound();
    this.mound.visible = false;
    this.group.add(this.mound);
  }

  /**
   * 隠すターンのプレビュー: 埋まった見た目にはせず、宝箱を完全に不透明・地上に置いた状態で表示する。
   * 呼ぶたび移動。
   */
  showAt(pos: Vec3): void {
    this.popping = false;
    this.group.position.set(pos.x, pos.y, pos.z);
    this.group.visible = true;

    this.mound.visible = false;
    this.setChestOpacity(1);
    this.chest.visible = true;
    this.chest.position.y = 0;
    this.setLidOpen(false, true);

    this.idleFloating = true;
    this.idleAgeMs = 0;
  }

  /**
   * アンカー補正への毎フレーム追従。位置だけを動かし、浮遊・ポップ等の演出状態には触れない
   * (演出はすべてgroup配下の子のローカル座標で行っているため、group位置の更新と干渉しない)。
   */
  moveTo(pos: Vec3): void {
    this.group.position.set(pos.x, pos.y, pos.z);
    if (this.popTargetPos) {
      this.popTargetPos = pos;
    }
  }

  /**
   * 確定後(手渡し以降): すべて非表示(埋まった状態)。
   */
  hide(): void {
    this.group.visible = false;
    this.mound.visible = false;
    this.idleFloating = false;
    this.popping = false;
  }

  /**
   * 発掘成功/ネタバラシ演出: 地中から宝箱がポンッと飛び出す(跳ね上がり+着地で小バウンド)。
   * 着地後に蓋が開き、金色パーティクルを発生させる。
   */
  reveal(pos: Vec3): void {
    this.idleFloating = false;
    this.mound.visible = false;
    this.setChestOpacity(1);

    this.group.position.set(pos.x, pos.y, pos.z);
    this.group.visible = true;
    this.chest.visible = true;
    this.chest.position.y = -0.3;
    this.setLidOpen(false, true);

    this.popping = true;
    this.popAgeMs = 0;
    this.popLanded = false;
    this.popTargetPos = pos;
  }

  showMiss(pos: Vec3): void {
    // ハズレ演出(土煙)。宝箱は表示しない。恒久的な「掘った跡」はDigMarksが別途担当する。
    this.spawnDust(pos);
  }

  /** 宝箱は探索中もともと非表示(埋まっている)ため、距離による表示制御は不要。 */
  setProximityHidden(_hidden: boolean): void {
    // no-op
  }

  /** 見つける側が発掘成功した瞬間の演出。宝箱は「地中から出てくる」点でreveal()と同一の演出でよい。 */
  collect(pos: Vec3): void {
    this.reveal(pos);
  }

  update(dtMs: number): void {
    if (this.idleFloating) {
      this.idleAgeMs += dtMs;
      const t = this.idleAgeMs / 1000;
      this.chest.position.y = Math.sin(t * 1.6) * 0.01;
    }

    if (this.popping) {
      this.updatePop(dtMs);
    }

    if (this.lidOpen && this.lidAngle > this.lidOpenAngle) {
      const step = (dtMs / 1000) * 3.2;
      this.lidAngle = Math.max(this.lidOpenAngle, this.lidAngle - step);
      this.lid.rotation.x = this.lidAngle;
    }

    this.updateBursts(dtMs);
  }

  private updatePop(dtMs: number): void {
    this.popAgeMs += dtMs;
    const t = this.popAgeMs / this.popDurationMs;
    if (t >= 1) {
      this.chest.position.y = 0;
      this.popping = false;
      if (!this.popLanded && this.popTargetPos) {
        this.popLanded = true;
        this.setLidOpen(true, false);
        this.spawnSparkles(this.popTargetPos);
      }
      return;
    }
    // -0.3 -> 0 をeaseOutBackで補間(1を少し超えるオーバーシュートが「小バウンド」になる)
    const startY = -0.3;
    this.chest.position.y = startY + (0 - startY) * easeOutBackJump(t);
  }

  private setLidOpen(open: boolean, instantClose: boolean): void {
    this.lidOpen = open;
    if (!open && instantClose) {
      this.lidAngle = 0;
      this.lid.rotation.x = 0;
    }
  }

  private setChestOpacity(opacity: number): void {
    for (const mat of this.chestMaterials) {
      mat.transparent = opacity < 1;
      mat.opacity = opacity;
      mat.depthWrite = opacity >= 1;
    }
  }

  private spawnSparkles(pos: Vec3): void {
    const count = 60;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      positions[idx] = 0;
      positions[idx + 1] = 0.15;
      positions[idx + 2] = 0;

      const angle = Math.random() * Math.PI * 2;
      const radius = 0.15 + Math.random() * 0.35;
      velocities[idx] = Math.cos(angle) * radius;
      velocities[idx + 1] = 0.6 + Math.random() * 0.8;
      velocities[idx + 2] = Math.sin(angle) * radius;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: GOLD_COLOR,
      size: 0.025,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    points.position.set(pos.x, pos.y, pos.z);
    this.scene.add(points);

    this.bursts.push({
      kind: 'sparkle',
      points,
      geometry,
      material,
      velocities,
      ageMs: 0,
      lifeMs: 1400,
    });
  }

  private spawnDust(pos: Vec3): void {
    const count = 36;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      positions[idx] = 0;
      positions[idx + 1] = 0;
      positions[idx + 2] = 0;

      const angle = Math.random() * Math.PI * 2;
      const radius = 0.05 + Math.random() * 0.2;
      velocities[idx] = Math.cos(angle) * radius;
      velocities[idx + 1] = 0.15 + Math.random() * 0.25;
      velocities[idx + 2] = Math.sin(angle) * radius;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: 0x9a9a92,
      size: 0.03,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    points.position.set(pos.x, pos.y, pos.z);
    this.scene.add(points);

    this.bursts.push({
      kind: 'dust',
      points,
      geometry,
      material,
      velocities,
      ageMs: 0,
      lifeMs: 700,
    });
  }

  private updateBursts(dtMs: number): void {
    if (this.bursts.length === 0) return;
    const dt = dtMs / 1000;

    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      burst.ageMs += dtMs;

      const positions = burst.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = positions.array as Float32Array;
      const gravity = burst.kind === 'sparkle' ? -0.4 : -0.05;

      for (let p = 0; p < arr.length; p += 3) {
        arr[p] += burst.velocities[p] * dt;
        arr[p + 1] += burst.velocities[p + 1] * dt;
        arr[p + 2] += burst.velocities[p + 2] * dt;
        burst.velocities[p + 1] += gravity * dt;
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
