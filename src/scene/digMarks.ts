// 新規: 探索ターンでハズレ発掘した位置に「掘った跡」を恒久表示する。対応SPEC.md: 3.4
import * as THREE from 'three';
import type { Vec3 } from '../types';

const HOLE_COLOR = 0x2b2118;
const RING_COLOR = 0x4a3320;

export class DigMarks {
  private readonly scene: THREE.Scene;
  private readonly group: THREE.Group;
  private readonly holeGeometry: THREE.CircleGeometry;
  private readonly ringGeometry: THREE.RingGeometry;
  private readonly holeMaterial: THREE.MeshBasicMaterial;
  private readonly ringMaterial: THREE.MeshBasicMaterial;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.scene.add(this.group);

    // ジオメトリ/マテリアルは全マークで使い回す(SPEC 6.6: GCによるカクつき防止)
    this.holeGeometry = new THREE.CircleGeometry(0.09, 20);
    this.ringGeometry = new THREE.RingGeometry(0.09, 0.14, 20);
    this.holeMaterial = new THREE.MeshBasicMaterial({ color: HOLE_COLOR, transparent: true, opacity: 0.85 });
    this.ringMaterial = new THREE.MeshBasicMaterial({ color: RING_COLOR, transparent: true, opacity: 0.7 });
  }

  /** 掘った跡(暗い色の穴+周囲の土盛りリング)を恒久表示する。 */
  addDigMark(pos: Vec3): void {
    const mark = new THREE.Group();
    mark.position.set(pos.x, pos.y, pos.z);

    const hole = new THREE.Mesh(this.holeGeometry, this.holeMaterial);
    hole.rotation.x = -Math.PI / 2;
    hole.position.y = 0.001; // z-fighting防止のためわずかに床から浮かせる
    mark.add(hole);

    const ring = new THREE.Mesh(this.ringGeometry, this.ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.0015;
    mark.add(ring);

    this.group.add(mark);
  }

  /** ゲームリセット(もう一度)時に全消去する。 */
  clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
    }
  }
}
