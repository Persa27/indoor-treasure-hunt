// 担当Phase2エージェントが実装する。対応SPEC.md: 6.2(DOM Overlay), 9章(アクセシビリティ・UI要件)
import type { GamePhase, GameResult, GameSettings, RadarFeedback, RadarLevel } from '../types';

export interface UIActions {
  onStartGame(): void;
  onOpenSettings(): void;
  onCloseSettings(s: GameSettings): void;
  onConfirmHide(): void;
  onStartSeek(): void;
  onRadarPress(): void;
  onRadarRelease(): void;
  onRetry(): void;
}

// 設定フォームの各数値項目のUI定義(min/max/stepはSPEC.mdセクション4に準拠。静的定数のみでinnerHTMLに埋め込む)
interface NumericFieldDef {
  key: 'hideTimeSec' | 'seekTimeSec' | 'successRadiusM' | 'digCooldownSec' | 'radarNearM' | 'radarMidM' | 'radarFarM';
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const NUMERIC_FIELDS: NumericFieldDef[] = [
  { key: 'hideTimeSec', label: '隠す時間', min: 15, max: 300, step: 1, unit: '秒' },
  { key: 'seekTimeSec', label: '探す時間', min: 30, max: 600, step: 1, unit: '秒' },
  { key: 'successRadiusM', label: '成功半径', min: 0.2, max: 1.5, step: 0.05, unit: 'm' },
  { key: 'digCooldownSec', label: '発掘クールダウン', min: 0, max: 10, step: 0.5, unit: '秒' },
  { key: 'radarNearM', label: 'レーダー近しきい値', min: 0.1, max: 5, step: 0.1, unit: 'm' },
  { key: 'radarMidM', label: 'レーダー中しきい値', min: 0.1, max: 10, step: 0.1, unit: 'm' },
  { key: 'radarFarM', label: 'レーダー遠しきい値', min: 0.1, max: 20, step: 0.1, unit: 'm' },
];

const RESULT_MESSAGES: Record<GameResult, string> = {
  'seeker-win': '発掘成功！見つける側の勝ち！',
  'hider-win': '時間切れ！隠す側の勝ち！',
  'hider-forfeit': '宝箱未配置のため隠す側の負け',
  aborted: 'トラッキングが失われたため無効試合',
};

const RADAR_LEVELS: RadarLevel[] = ['far', 'mid', 'near', 'hot'];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export class OverlayUI {
  private readonly root: HTMLElement;
  private readonly actions: UIActions;
  private settings: GameSettings | null = null;

  private readonly screens: Record<GamePhase, HTMLElement>;
  private readonly numericInputs: Partial<Record<NumericFieldDef['key'], HTMLInputElement>> = {};
  private readonly numericValueLabels: Partial<Record<NumericFieldDef['key'], HTMLElement>> = {};
  private soundInput!: HTMLInputElement;
  private vibrationInput!: HTMLInputElement;

  private startGameBtn!: HTMLButtonElement;
  private startReasonEl!: HTMLElement;
  private confirmHideBtn!: HTMLButtonElement;
  private timerHideEl!: HTMLElement;
  private timerSeekEl!: HTMLElement;
  private cooldownRing!: SVGCircleElement;
  private cooldownWrap!: HTMLElement;
  private radarBtn!: HTMLButtonElement;
  private radarGlowEl!: HTMLElement;
  private resultMessageEl!: HTMLElement;
  private errorMsgEl!: HTMLElement;
  private toastContainer!: HTMLElement;

  private vibrationEnabled = true;
  private vibrateTimerId: ReturnType<typeof setInterval> | null = null;

  private static readonly COOLDOWN_RADIUS = 20;
  private static readonly COOLDOWN_CIRC = 2 * Math.PI * OverlayUI.COOLDOWN_RADIUS;

  constructor(root: HTMLElement, actions: UIActions) {
    this.root = root;
    this.actions = actions;
    this.screens = this.build();
  }

  // ---------------------------------------------------------------------
  // DOM構築(静的テンプレートのみ innerHTML を使用。動的値は必ず textContent/プロパティで設定)
  // ---------------------------------------------------------------------

  private build(): Record<GamePhase, HTMLElement> {
    this.root.textContent = '';

    const landscapeWarning = el('div', 'landscape-warning');
    landscapeWarning.innerHTML = '<p>縦向きでご利用ください</p>';
    this.root.appendChild(landscapeWarning);

    const title = this.buildTitle();
    const settings = this.buildSettings();
    const hide = this.buildHide();
    const handover = this.buildHandover();
    const seek = this.buildSeek();
    const result = this.buildResult();
    const error = this.buildError();

    this.root.appendChild(title);
    this.root.appendChild(settings);
    this.root.appendChild(hide);
    this.root.appendChild(handover);
    this.root.appendChild(seek);
    this.root.appendChild(result);
    this.root.appendChild(error);

    this.toastContainer = el('div', 'toast-container');
    this.root.appendChild(this.toastContainer);

    return { title, settings, hide, handover, seek, result, error };
  }

  private buildTitle(): HTMLElement {
    const screen = el('section', 'screen screen-title');
    screen.innerHTML = `
      <div class="title-head">
        <p class="eyebrow">INDOOR TREASURE HUNT</p>
        <h1>AR宝探し</h1>
      </div>
      <div class="howto">
        <p class="eyebrow eyebrow-sub">HOW TO PLAY</p>
        <ol>
          <li>1台の端末を2人で交代しながら使います。</li>
          <li>隠す側: 端末をかざして床や家具の上に宝箱を配置します。</li>
          <li>手渡し: 画面を伏せたり消したりせず、見つける側に渡します。</li>
          <li>見つける側: 画面をタップして発掘し、レーダーを頼りに宝箱を探します。</li>
        </ol>
        <p class="notice">対応環境: ARCore対応の Android + Chrome。iPhone(iOS Safari)には対応していません。</p>
        <p class="notice">カメラ映像は端末内でARの表示にのみ使われ、保存や外部送信は一切行われません。</p>
      </div>
      <div class="bottom-bar">
        <p class="start-reason" data-role="start-reason"></p>
        <div class="button-row">
          <button type="button" class="btn" data-action="settings">設定</button>
          <button type="button" class="btn btn-primary" data-action="start">ゲーム開始</button>
        </div>
      </div>
    `;

    this.startGameBtn = screen.querySelector('[data-action="start"]') as HTMLButtonElement;
    this.startReasonEl = screen.querySelector('[data-role="start-reason"]') as HTMLElement;
    this.startGameBtn.addEventListener('click', () => this.actions.onStartGame());
    (screen.querySelector('[data-action="settings"]') as HTMLButtonElement).addEventListener('click', () =>
      this.actions.onOpenSettings(),
    );
    return screen;
  }

  private buildSettings(): HTMLElement {
    const screen = el('section', 'screen screen-settings');
    const head = el('div', 'title-head title-head-compact');
    head.innerHTML = '<p class="eyebrow">SETTINGS</p><h1>設定</h1>';
    screen.appendChild(head);

    const scroll = el('div', 'settings-scroll');
    const form = el('div', 'settings-form');
    for (const field of NUMERIC_FIELDS) {
      const row = el('div', 'field-row');
      const label = el('label');
      label.htmlFor = `field-${field.key}`;
      label.textContent = field.label;

      const input = el('input', 'field-range');
      input.type = 'range';
      input.id = `field-${field.key}`;
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = String(field.step);

      const valueLabel = el('span', 'field-value');

      input.addEventListener('input', () => {
        this.numericValueLabels[field.key]!.textContent = `${input.value}${field.unit}`;
      });

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valueLabel);
      form.appendChild(row);

      this.numericInputs[field.key] = input;
      this.numericValueLabels[field.key] = valueLabel;
    }

    const toggleRow = el('div', 'field-row-toggles');
    const soundLabel = el('label', 'toggle-label');
    this.soundInput = el('input');
    this.soundInput.type = 'checkbox';
    soundLabel.appendChild(this.soundInput);
    soundLabel.appendChild(document.createTextNode(' 効果音'));

    const vibLabel = el('label', 'toggle-label');
    this.vibrationInput = el('input');
    this.vibrationInput.type = 'checkbox';
    vibLabel.appendChild(this.vibrationInput);
    vibLabel.appendChild(document.createTextNode(' バイブレーション'));

    toggleRow.appendChild(soundLabel);
    toggleRow.appendChild(vibLabel);
    form.appendChild(toggleRow);

    scroll.appendChild(form);
    screen.appendChild(scroll);

    const bottomBar = el('div', 'bottom-bar');
    const buttonRow = el('div', 'button-row');
    const saveBtn = el('button', 'btn btn-primary');
    saveBtn.type = 'button';
    saveBtn.textContent = '保存して戻る';
    saveBtn.addEventListener('click', () => this.handleSaveSettings());
    buttonRow.appendChild(saveBtn);
    bottomBar.appendChild(buttonRow);
    screen.appendChild(bottomBar);

    return screen;
  }

  private buildHide(): HTMLElement {
    const screen = el('section', 'screen screen-hide');
    screen.innerHTML = `
      <div class="hud-corner hud-tl">
        <p class="eyebrow">HIDER'S TURN</p>
        <div class="timer-pad" data-role="timer"></div>
      </div>
      <div class="guide-pad">タップで宝箱を置く(置き直し可)</div>
      <div class="bottom-bar">
        <div class="button-row">
          <button type="button" class="btn btn-primary btn-large" data-action="confirm-hide" disabled>ここに隠す(確定)</button>
        </div>
      </div>
    `;
    this.timerHideEl = screen.querySelector('[data-role="timer"]') as HTMLElement;
    this.confirmHideBtn = screen.querySelector('[data-action="confirm-hide"]') as HTMLButtonElement;
    this.confirmHideBtn.addEventListener('click', () => this.actions.onConfirmHide());
    return screen;
  }

  private buildHandover(): HTMLElement {
    const screen = el('section', 'screen screen-handover opaque');
    screen.innerHTML = `
      <p class="eyebrow">HANDOVER</p>
      <div class="handover-warning">⚠ 画面を消したり端末を伏せたりしないでください(宝の位置が失われます)</div>
      <div class="bottom-bar">
        <div class="button-row">
          <button type="button" class="btn btn-primary btn-large" data-action="start-seek">探索スタート</button>
        </div>
      </div>
    `;
    (screen.querySelector('[data-action="start-seek"]') as HTMLButtonElement).addEventListener('click', () =>
      this.actions.onStartSeek(),
    );
    return screen;
  }

  private buildSeek(): HTMLElement {
    const screen = el('section', 'screen screen-seek');
    screen.innerHTML = `
      <div class="radar-glow" data-role="radar-glow"></div>
      <div class="hud-corner hud-tl">
        <p class="eyebrow">SEEKER'S TURN</p>
        <div class="timer-pad" data-role="timer"></div>
      </div>
      <div class="cooldown-wrap" data-role="cooldown-wrap" hidden>
        <svg viewBox="0 0 48 48" class="cooldown-ring">
          <circle class="cooldown-ring-bg" cx="24" cy="24" r="20"></circle>
          <circle class="cooldown-ring-fg" data-role="cooldown-ring" cx="24" cy="24" r="20"></circle>
        </svg>
      </div>
      <button type="button" class="radar-btn" data-action="radar" aria-label="レーダー(長押しで作動)"></button>
    `;
    this.timerSeekEl = screen.querySelector('[data-role="timer"]') as HTMLElement;
    this.radarGlowEl = screen.querySelector('[data-role="radar-glow"]') as HTMLElement;
    this.cooldownWrap = screen.querySelector('[data-role="cooldown-wrap"]') as HTMLElement;
    this.cooldownRing = screen.querySelector('[data-role="cooldown-ring"]') as unknown as SVGCircleElement;
    this.cooldownRing.style.strokeDasharray = `${OverlayUI.COOLDOWN_CIRC}`;
    this.radarBtn = screen.querySelector('[data-action="radar"]') as HTMLButtonElement;

    const press = (ev: Event) => {
      ev.preventDefault();
      this.actions.onRadarPress();
    };
    const release = (ev: Event) => {
      ev.preventDefault();
      this.actions.onRadarRelease();
    };
    this.radarBtn.addEventListener('pointerdown', press);
    this.radarBtn.addEventListener('pointerup', release);
    this.radarBtn.addEventListener('pointercancel', release);
    this.radarBtn.addEventListener('pointerleave', release);

    return screen;
  }

  private buildResult(): HTMLElement {
    const screen = el('section', 'screen screen-result');
    screen.innerHTML = `
      <div class="title-head">
        <p class="eyebrow">RESULT</p>
        <h1 data-role="result-message" class="result-message"></h1>
      </div>
      <div class="bottom-bar">
        <div class="button-row">
          <button type="button" class="btn btn-primary btn-large" data-action="retry">もう一度</button>
        </div>
      </div>
    `;
    this.resultMessageEl = screen.querySelector('[data-role="result-message"]') as HTMLElement;
    (screen.querySelector('[data-action="retry"]') as HTMLButtonElement).addEventListener('click', () =>
      this.actions.onRetry(),
    );
    return screen;
  }

  private buildError(): HTMLElement {
    const screen = el('section', 'screen screen-error');
    screen.innerHTML = `
      <div class="title-head">
        <p class="eyebrow">ERROR</p>
        <h1>エラー</h1>
      </div>
      <p data-role="error-message" class="error-message"></p>
      <div class="error-guide">
        <p><strong>非対応端末の場合:</strong> <a href="https://developers.google.com/ar/devices" target="_blank" rel="noopener noreferrer">ARCore対応端末一覧</a> でご利用の端末が対応しているか確認してください。</p>
        <p><strong>iPhone(iOS)をお使いの場合:</strong> iPhoneのブラウザは本アプリのAR機能に非対応です。ARCore対応のAndroid端末をご利用ください。</p>
        <p><strong>カメラ権限を拒否した場合:</strong> Chromeのアドレスバー左のアイコン(サイト情報)から「サイトの設定」を開き、カメラの許可を「許可」に変更して再読み込みしてください。</p>
      </div>
      <div class="bottom-bar">
        <div class="button-row">
          <button type="button" class="btn btn-primary" data-action="retry-error">タイトルへ戻る</button>
        </div>
      </div>
    `;
    this.errorMsgEl = screen.querySelector('[data-role="error-message"]') as HTMLElement;
    (screen.querySelector('[data-action="retry-error"]') as HTMLButtonElement).addEventListener('click', () =>
      this.actions.onRetry(),
    );
    return screen;
  }

  // ---------------------------------------------------------------------
  // 公開API
  // ---------------------------------------------------------------------

  showPhase(phase: GamePhase, ctx?: { result?: GameResult; errorMsg?: string }): void {
    for (const key of Object.keys(this.screens) as GamePhase[]) {
      this.screens[key].classList.toggle('active', key === phase);
    }

    if (phase === 'settings' && this.settings) {
      this.applySettingsToForm(this.settings);
    }
    if (phase === 'result' && ctx?.result) {
      this.resultMessageEl.textContent = RESULT_MESSAGES[ctx.result];
    }
    if (phase === 'error') {
      this.errorMsgEl.textContent = ctx?.errorMsg ?? '不明なエラーが発生しました。';
    }
    if (phase !== 'seek') {
      this.setRadarGlow(null);
      this.updateCooldown(0);
    }
  }

  updateTimer(remainSec: number): void {
    const text = `残り ${Math.max(0, Math.ceil(remainSec))}秒`;
    this.timerHideEl.textContent = text;
    this.timerSeekEl.textContent = text;
  }

  updateCooldown(remainMs: number): void {
    if (remainMs <= 0) {
      this.cooldownWrap.hidden = true;
      return;
    }
    this.cooldownWrap.hidden = false;
    const totalMs = this.settings?.digCooldownSec ? this.settings.digCooldownSec * 1000 : remainMs;
    const ratio = totalMs > 0 ? Math.min(1, remainMs / totalMs) : 0;
    const offset = OverlayUI.COOLDOWN_CIRC * (1 - ratio);
    this.cooldownRing.style.strokeDashoffset = `${offset}`;
  }

  setRadarGlow(fb: RadarFeedback | null): void {
    for (const level of RADAR_LEVELS) {
      this.radarGlowEl.classList.remove(`level-${level}`);
    }
    if (!fb) {
      this.radarGlowEl.classList.remove('active');
      this.stopVibration();
      return;
    }
    this.radarGlowEl.classList.add('active');
    this.radarGlowEl.classList.add(`level-${fb.level}`);

    if (fb.level === 'hot' && this.vibrationEnabled) {
      this.startVibration();
    } else {
      this.stopVibration();
    }
  }

  setVibrationEnabled(on: boolean): void {
    this.vibrationEnabled = on;
    if (!on) this.stopVibration();
  }

  private startVibration(): void {
    if (this.vibrateTimerId !== null) return;
    const vibrate = () => {
      if (typeof navigator.vibrate === 'function') {
        navigator.vibrate(80);
      }
    };
    vibrate();
    this.vibrateTimerId = setInterval(vibrate, 350);
  }

  private stopVibration(): void {
    if (this.vibrateTimerId !== null) {
      clearInterval(this.vibrateTimerId);
      this.vibrateTimerId = null;
    }
  }

  setStartEnabled(enabled: boolean, reason?: string): void {
    this.startGameBtn.disabled = !enabled;
    this.startReasonEl.textContent = enabled ? '' : (reason ?? 'このデバイスではプレイできません。');
  }

  setConfirmEnabled(enabled: boolean): void {
    this.confirmHideBtn.disabled = !enabled;
  }

  toast(msg: string): void {
    const node = el('div', 'toast');
    node.textContent = msg;
    this.toastContainer.appendChild(node);

    // フェードイン
    requestAnimationFrame(() => node.classList.add('visible'));

    setTimeout(() => {
      node.classList.remove('visible');
      setTimeout(() => node.remove(), 300);
    }, 2200);
  }

  getSettings(): GameSettings {
    if (!this.settings) {
      throw new Error('not implemented');
    }
    return this.readSettingsFromForm(this.settings);
  }

  setSettings(s: GameSettings): void {
    this.settings = s;
    this.applySettingsToForm(s);
  }

  private applySettingsToForm(s: GameSettings): void {
    for (const field of NUMERIC_FIELDS) {
      const input = this.numericInputs[field.key];
      const label = this.numericValueLabels[field.key];
      if (!input || !label) continue;
      const value = s[field.key];
      input.value = String(value);
      label.textContent = `${value}${field.unit}`;
    }
    this.soundInput.checked = s.soundEnabled;
    this.vibrationInput.checked = s.vibrationEnabled;
  }

  private readSettingsFromForm(base: GameSettings): GameSettings {
    const next: GameSettings = { ...base };
    for (const field of NUMERIC_FIELDS) {
      const input = this.numericInputs[field.key];
      if (!input) continue;
      const num = Number(input.value);
      if (Number.isFinite(num)) {
        (next[field.key] as number) = num;
      }
    }
    next.soundEnabled = this.soundInput.checked;
    next.vibrationEnabled = this.vibrationInput.checked;
    return next;
  }

  private handleSaveSettings(): void {
    if (!this.settings) return;
    const next = this.readSettingsFromForm(this.settings);
    this.settings = next;
    this.actions.onCloseSettings(next);
  }
}
