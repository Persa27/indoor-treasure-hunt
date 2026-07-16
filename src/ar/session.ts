// 担当Phase2エージェントが実装する。対応SPEC.md: 6.2, 6.6, 8.1, 8.2(Permissions-Policy: xr-spatial-tracking)
import * as THREE from 'three';
import type { Vec3 } from '../types';

export interface ARSessionCallbacks {
  onViewerMove(pos: Vec3): void; // 毎フレーム、ビューア(端末)ワールド座標
  onSelect(hit: Vec3 | null): void; // タップ時。hit-test成功なら実面上のワールド座標、失敗ならnull
  onTrackingChange(degraded: boolean): void; // emulatedPosition等でトラッキング劣化/復帰
  onSessionEnd(): void; // セッション終了(タブ切替・ユーザー終了)
}

export type ARFrameHook = (frame: XRFrame, refSpace: XRReferenceSpace) => void;

export class ARSession {
  private readonly overlayRoot: HTMLElement;
  private readonly callbacks: ARSessionCallbacks;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private selectEnabled = true;

  private renderer: THREE.WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private session: XRSession | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private viewerSpace: XRReferenceSpace | null = null;
  private hitTestSource: XRHitTestSource | null = null;
  private lastHitResult: XRHitTestResult | null = null;
  private frameHook: ARFrameHook | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private trackingDegraded = false;

  static async isSupported(): Promise<boolean> {
    if (!navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported('immersive-ar');
    } catch {
      return false;
    }
  }

  constructor(overlayRoot: HTMLElement, callbacks: ARSessionCallbacks) {
    this.overlayRoot = overlayRoot;
    this.callbacks = callbacks;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();

    const ambient = new THREE.AmbientLight(0xffffff, 0.9);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(0.6, 1, 0.4);
    directional.castShadow = false;
    this.scene.add(ambient, directional);
  }

  async start(): Promise<void> {
    // requiredFeatures: ['hit-test', 'dom-overlay', 'local-floor'], optionalFeatures: ['anchors']
    if (!navigator.xr) {
      throw new Error('WebXR not available');
    }

    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'dom-overlay', 'local-floor'],
      optionalFeatures: ['anchors'],
      domOverlay: { root: this.overlayRoot },
    });
    this.session = session;

    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    this.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    this.renderer = renderer;

    // hit-testはレンダラー管理下のreference spaceに合わせる(座標系を一致させる)。
    this.refSpace = renderer.xr.getReferenceSpace();
    this.viewerSpace = await session.requestReferenceSpace('viewer');

    // Android Chromeで確実に動作する、viewer空間に固定した常設hit-test sourceを使う方式。
    // (transient-inputハイテストはブラウザ依存が強いため避ける)
    if (typeof session.requestHitTestSource === 'function' && this.viewerSpace) {
      try {
        this.hitTestSource = (await session.requestHitTestSource({ space: this.viewerSpace })) ?? null;
      } catch {
        this.hitTestSource = null;
      }
    }

    session.addEventListener('select', this.onSelect);
    session.addEventListener('end', this.onSessionEnd);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    await this.requestWakeLock();

    renderer.setAnimationLoop(this.onXRFrame);
  }

  async end(): Promise<void> {
    if (this.session) {
      await this.session.end();
    }
  }

  getScene(): THREE.Scene {
    return this.scene;
  }

  setSelectEnabled(enabled: boolean): void {
    this.selectEnabled = enabled;
  }

  /** TreasureAnchor.updateFromFrame や TreasureView.update をフックするための登録口 */
  setFrameHook(fn: ARFrameHook | null): void {
    this.frameHook = fn;
  }

  /** アンカー作成用に直近のhit-test結果を取得する */
  getLastHitResult(): XRHitTestResult | null {
    return this.lastHitResult;
  }

  private onXRFrame = (_time: number, frame?: XRFrame): void => {
    if (!frame || !this.refSpace || !this.renderer) return;

    if (this.frameHook) {
      this.frameHook(frame, this.refSpace);
    }

    const pose = frame.getViewerPose(this.refSpace);
    if (pose) {
      const p = pose.transform.position;
      this.callbacks.onViewerMove({ x: p.x, y: p.y, z: p.z });
      this.setTrackingDegraded(pose.emulatedPosition === true);
    } else {
      this.setTrackingDegraded(true);
    }

    if (this.hitTestSource) {
      const results = frame.getHitTestResults(this.hitTestSource);
      this.lastHitResult = results.length > 0 ? results[0] : null;
    } else {
      this.lastHitResult = null;
    }

    this.renderer.render(this.scene, this.camera);
  };

  private setTrackingDegraded(degraded: boolean): void {
    if (degraded === this.trackingDegraded) return;
    this.trackingDegraded = degraded;
    this.callbacks.onTrackingChange(degraded);
  }

  private onSelect = (): void => {
    if (!this.selectEnabled) return;

    if (!this.lastHitResult || !this.refSpace) {
      this.callbacks.onSelect(null);
      return;
    }

    const pose = this.lastHitResult.getPose(this.refSpace);
    if (!pose) {
      this.callbacks.onSelect(null);
      return;
    }

    const p = pose.transform.position;
    this.callbacks.onSelect({ x: p.x, y: p.y, z: p.z });
  };

  private onSessionEnd = (): void => {
    this.renderer?.setAnimationLoop(null);

    this.hitTestSource?.cancel();
    this.hitTestSource = null;
    this.lastHitResult = null;
    this.refSpace = null;
    this.viewerSpace = null;

    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.releaseWakeLock();

    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
    }
    this.renderer = null;
    this.session = null;

    this.callbacks.onSessionEnd();
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible' && this.session) {
      void this.requestWakeLock();
    }
  };

  private async requestWakeLock(): Promise<void> {
    try {
      this.wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      this.wakeLock = null;
    }
  }

  private releaseWakeLock(): void {
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (lock) {
      lock.release().catch(() => {
        // 解放失敗は無視(セッション終了時のためすでに無効な場合がある)
      });
    }
  }
}
