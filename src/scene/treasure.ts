// 担当Phase2エージェントが実装する。対応SPEC.md: 6.5(宝箱3Dモデル、Three.jsプリミティブ), 6.6(パフォーマンス方針)
import * as THREE from 'three';
import type { Vec3 } from '../types';

const WOOD_COLOR = 0x6b4226;
const GOLD_COLOR = 0xd4af37;

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

function buildChest(): { group: THREE.Group; lid: THREE.Group } {
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

  return { group, lid };
}

export class TreasureView {
  private readonly scene: THREE.Scene;
  private readonly group: THREE.Group;
  private readonly chest: THREE.Group;
  private readonly lid: THREE.Group;

  private floatAgeMs = 0;
  private floating = false;

  private lidOpen = false;
  private lidAngle = 0;
  private readonly lidOpenAngle = -Math.PI * 0.62;

  private readonly bursts: ParticleBurst[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.scene.add(this.group);

    const { group: chest, lid } = buildChest();
    this.chest = chest;
    this.lid = lid;
    this.group.add(chest);
  }

  showAt(pos: Vec3): void {
    // 配置プレビュー表示(隠すターン)。呼ぶたび移動。
    this.group.position.set(pos.x, pos.y, pos.z);
    this.group.visible = true;
    this.chest.visible = true;
    this.setLidOpen(false, true);
    this.floating = true;
    this.floatAgeMs = 0;
  }

  hide(): void {
    // 非表示(手渡し以降)
    this.group.visible = false;
    this.floating = false;
  }

  reveal(pos: Vec3): void {
    // 発掘成功/ネタバラシ演出(蓋が開く+パーティクル)
    this.group.position.set(pos.x, pos.y, pos.z);
    this.group.visible = true;
    this.chest.visible = true;
    this.floating = false;
    this.chest.position.y = 0;
    this.setLidOpen(true, false);
    this.spawnSparkles(pos);
  }

  showMiss(pos: Vec3): void {
    // ハズレ演出(土煙)。宝箱は表示しない。
    this.spawnDust(pos);
  }

  update(dtMs: number): void {
    // アニメーション更新
    if (this.floating) {
      this.floatAgeMs += dtMs;
      const t = this.floatAgeMs / 1000;
      this.chest.position.y = Math.sin(t * 1.6) * 0.02;
    }

    if (this.lidOpen && this.lidAngle > this.lidOpenAngle) {
      const step = (dtMs / 1000) * 3.2;
      this.lidAngle = Math.max(this.lidOpenAngle, this.lidAngle - step);
      this.lid.rotation.x = this.lidAngle;
    }

    this.updateBursts(dtMs);
  }

  private setLidOpen(open: boolean, instantClose: boolean): void {
    this.lidOpen = open;
    if (!open && instantClose) {
      this.lidAngle = 0;
      this.lid.rotation.x = 0;
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
