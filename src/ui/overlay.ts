// 担当Phase2エージェントが実装する。対応SPEC.md: 6.2(DOM Overlay), 9章(アクセシビリティ・UI要件)
import type { GameMode, GamePhase, GameResult, GameSettings, RadarFeedback, RadarLevel } from '../types';

export interface UIActions {
  onStartGame(): void;
  onOpenSettings(): void;
  onCloseSettings(s: GameSettings): void;
  onConfirmHide(): void;
  onStartSeek(): void;
  onRetry(): void;
}

// 設定フォームの各数値項目のUI定義(min/max/stepはSPEC.mdセクション4に準拠。静的定数のみでinnerHTMLに埋め込む)
interface NumericFieldDef {
  key:
    | 'treasureCount'
    | 'hideTimeSec'
    | 'seekTimeSec'
    | 'successRadiusM'
    | 'digCooldownSec'
    | 'coinVisibleDistM'
    | 'radarNearM'
    | 'radarMidM'
    | 'radarFarM';
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const NUMERIC_FIELDS: NumericFieldDef[] = [
  { key: 'treasureCount', label: 'たからの数', min: 1, max: 5, step: 1, unit: '個' },
  { key: 'hideTimeSec', label: '<ruby>隠<rt>かく</rt></ruby>す時間', min: 15, max: 300, step: 1, unit: '秒' },
  { key: 'seekTimeSec', label: '<ruby>探<rt>さが</rt></ruby>す時間', min: 30, max: 600, step: 1, unit: '秒' },
  { key: 'successRadiusM', label: 'あたり<ruby>半径<rt>はんけい</rt></ruby>', min: 0.2, max: 1.5, step: 0.05, unit: 'm' },
  { key: 'digCooldownSec', label: 'つぎまでのまち時間', min: 0, max: 10, step: 0.5, unit: '秒' },
  { key: 'coinVisibleDistM', label: 'コインが見えるきょり', min: 0.5, max: 10, step: 0.5, unit: 'm' },
  { key: 'radarNearM', label: 'レーダー近しきい値', min: 0.1, max: 5, step: 0.1, unit: 'm' },
  { key: 'radarMidM', label: 'レーダー中しきい値', min: 0.1, max: 10, step: 0.1, unit: 'm' },
  { key: 'radarFarM', label: 'レーダー遠しきい値', min: 0.1, max: 20, step: 0.1, unit: 'm' },
];

// あそびかた(宝箱モード/コインモード)ごとの文言・アイコンの差し替え定義
interface ModeMeta {
  optionIcon: string;
  optionLabel: string;
  hideEyebrowIcon: string;
  hideGuide: string;
  confirmLabel: string;
  confirmIcon: string;
  successMessage: string;
  forfeitMessage: string;
}

const MODE_META: Record<GameMode, ModeMeta> = {
  chest: {
    optionIcon: 'chest',
    optionLabel: '<ruby>宝箱<rt>たからばこ</rt></ruby>をほる',
    hideEyebrowIcon: 'spade',
    hideGuide: 'タップして<ruby>宝箱<rt>たからばこ</rt></ruby>をうめよう!(さいごの1こは置きなおしOK)',
    confirmLabel: 'ここにうめる！',
    confirmIcon: 'chest',
    successMessage: '<ruby>宝箱<rt>たからばこ</rt></ruby>ぜんぶ発見！さがす人のかち！',
    forfeitMessage: '<ruby>宝箱<rt>たからばこ</rt></ruby>をうめられなかったので、かくす人のまけ',
  },
  coin: {
    optionIcon: 'coin',
    optionLabel: 'コインをあつめる',
    hideEyebrowIcon: 'coin',
    hideGuide: 'タップしてコインを置こう!(さいごの1こは置きなおしOK)',
    confirmLabel: 'ここに置く！',
    confirmIcon: 'coin',
    successMessage: 'コインぜんぶかいしゅう！さがす人のかち！',
    forfeitMessage: 'コインを置けなかったので、かくす人のまけ',
  },
};

function resultMessage(result: GameResult, mode: GameMode): string {
  const meta = MODE_META[mode];
  if (result === 'seeker-win') return meta.successMessage;
  if (result === 'hider-forfeit') return meta.forfeitMessage;
  if (result === 'hider-win') return 'じかんぎれ！かくす人のかち！';
  return 'ARがうまく動かなかったので、引き分け';
}

const RADAR_LEVELS: RadarLevel[] = ['far', 'mid', 'near', 'hot'];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

// 自作SVGスプライト(public/img/icons.svg)を参照する。絵文字は使用しない方針(SPEC 6.5)。
export function icon(name: string): string {
  return `<svg class="icon" aria-hidden="true" focusable="false"><use href="/img/icons.svg#icon-${name}"></use></svg>`;
}

export class OverlayUI {
  private readonly root: HTMLElement;
  private readonly actions: UIActions;
  private settings: GameSettings | null = null;

  private readonly screens: Record<GamePhase, HTMLElement>;
  private readonly numericInputs: Partial<Record<NumericFieldDef['key'], HTMLInputElement>> = {};
  private readonly numericValueLabels: Partial<Record<NumericFieldDef['key'], HTMLElement>> = {};
  private readonly gameModeInputs: Partial<Record<GameMode, HTMLInputElement>> = {};
  private soundInput!: HTMLInputElement;
  private vibrationInput!: HTMLInputElement;

  private startGameBtn!: HTMLButtonElement;
  private startReasonEl!: HTMLElement;
  private confirmHideBtn!: HTMLButtonElement;
  private hideEyebrowIconEl!: HTMLElement;
  private hideGuideEl!: HTMLElement;
  private hideConfirmLabelEl!: HTMLElement;
  private hideProgressEl!: HTMLElement;
  private timerHideEl!: HTMLElement;
  private timerSeekEl!: HTMLElement;
  private cooldownRing!: SVGCircleElement;
  private cooldownWrap!: HTMLElement;
  private radarGlowEl!: HTMLElement;
  private resultMessageEl!: HTMLElement;
  private errorMsgEl!: HTMLElement;
  private toastContainer!: HTMLElement;
  private motionGuideEl!: HTMLElement;
  private motionGuideHideTimerId: ReturnType<typeof setTimeout> | null = null;

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

    this.motionGuideEl = el('div', 'motion-guide');
    this.motionGuideEl.hidden = true;
    // 静的テンプレートのみ(動的値なし)のためinnerHTMLでアイコンを埋め込む
    this.motionGuideEl.innerHTML = `
      <div class="motion-guide-track">
        <div class="motion-guide-phone">${icon('vibrate')}</div>
      </div>
    `;
    this.root.appendChild(this.motionGuideEl);

    this.installBeforeXrSelectGuard();

    return { title, settings, hide, handover, seek, result, error };
  }

  /**
   * DOM overlay上のボタン・リンク・フォーム要素をタップしたとき、ARのselectが同時発火して
   * 宝箱が動いてしまう事故を防ぐ。画面全体でpreventDefaultするとタップ全体が効かなくなる
   * (今回の不具合の原因)ため、対話要素の上でのみpreventDefaultする。
   */
  private installBeforeXrSelectGuard(): void {
    this.root.addEventListener('beforexrselect', (ev) => {
      const target = ev.target as HTMLElement | null;
      if (target && target.closest('button, a, input, select, textarea, label')) {
        ev.preventDefault();
      }
    });
  }

  private buildTitle(): HTMLElement {
    const screen = el('section', 'screen screen-title');
    screen.innerHTML = `
      <div class="title-head">
        <p class="eyebrow">${icon('skull')} たからさがしぼうけん</p>
        <h1>AR<ruby>宝<rt>たから</rt></ruby>さがし</h1>
      </div>
      <div class="howto">
        <p class="eyebrow eyebrow-sub">${icon('map')} あそびかた</p>
        <ol>
          <li>1台のスマホを2人で<ruby>交代<rt>こうたい</rt></ruby>してつかうよ。</li>
          <li><ruby>隠<rt>かく</rt></ruby>す人: スマホをかざして、ゆかや家具の上に<ruby>宝箱<rt>たからばこ</rt></ruby>をうめよう。</li>
          <li>わたすとき: 画面を消したり伏せたりしないで、さがす人にわたそう。</li>
          <li><ruby>探<rt>さが</rt></ruby>す人: 画面をタップしてほって、レーダーをたよりに宝箱を見つけよう!</li>
        </ol>
        <p class="notice">${icon('gear')} <ruby>設定<rt>せってい</rt></ruby>で「<ruby>宝箱<rt>たからばこ</rt></ruby>をほる」か「コインをあつめる」かをえらべるよ。</p>
        <p class="notice">つかえる機種: ARCore対応のAndroid + Chrome。iPhoneでは遊べません。</p>
        <p class="notice">カメラの映像はARの表示だけに使われ、保存や外部そうしんは一切ありません。</p>
      </div>
      <div class="bottom-bar">
        <p class="start-reason" data-role="start-reason"></p>
        <div class="button-row">
          <button type="button" class="btn" data-action="settings">${icon('gear')} <ruby>設定<rt>せってい</rt></ruby></button>
          <button type="button" class="btn btn-primary" data-action="start">スタート！${icon('compass')}</button>
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

  private buildModeOption(mode: GameMode): HTMLLabelElement {
    const meta = MODE_META[mode];
    const label = el('label', 'mode-option');

    const input = el('input');
    input.type = 'radio';
    input.name = 'game-mode';
    input.value = mode;
    label.appendChild(input);

    const body = el('span', 'mode-option-body');
    // MODE_METAはソース定数(ユーザー入力なし)のためinnerHTMLでアイコン表示を許容する
    body.innerHTML = `${icon(meta.optionIcon)}<span>${meta.optionLabel}</span>`;
    label.appendChild(body);

    this.gameModeInputs[mode] = input;
    return label;
  }

  private buildSettings(): HTMLElement {
    const screen = el('section', 'screen screen-settings');
    const head = el('div', 'title-head title-head-compact');
    head.innerHTML = `<p class="eyebrow">${icon('gear')} せってい</p><h1><ruby>設定<rt>せってい</rt></ruby></h1>`;
    screen.appendChild(head);

    const scroll = el('div', 'settings-scroll');
    const form = el('div', 'settings-form');

    const modeRow = el('div', 'field-row-mode');
    const modeLegend = el('p', 'field-mode-legend');
    modeLegend.innerHTML = `${icon('map')} あそびかたをえらぼう`;
    modeRow.appendChild(modeLegend);

    const modeOptions = el('div', 'mode-options');
    (Object.keys(MODE_META) as GameMode[]).forEach((mode) => {
      modeOptions.appendChild(this.buildModeOption(mode));
    });
    modeRow.appendChild(modeOptions);
    form.appendChild(modeRow);

    for (const field of NUMERIC_FIELDS) {
      const row = el('div', 'field-row');
      const label = el('label');
      label.htmlFor = `field-${field.key}`;
      // fieldはソース定数(NUMERIC_FIELDS)のみでユーザー入力はないため、ルビ表示にinnerHTMLを使う
      label.innerHTML = field.label;

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
    const soundText = el('span');
    soundText.innerHTML = ` ${icon('speaker')} <ruby>効果音<rt>こうかおん</rt></ruby>`;
    soundLabel.appendChild(this.soundInput);
    soundLabel.appendChild(soundText);

    const vibLabel = el('label', 'toggle-label');
    this.vibrationInput = el('input');
    this.vibrationInput.type = 'checkbox';
    const vibText = el('span');
    vibText.innerHTML = ` ${icon('vibrate')} ぶるぶる`;
    vibLabel.appendChild(this.vibrationInput);
    vibLabel.appendChild(vibText);

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
        <p class="eyebrow"><span data-role="hide-eyebrow-icon"></span> <ruby>隠<rt>かく</rt></ruby>す番</p>
        <div class="timer-pad" data-role="timer"></div>
        <div class="timer-pad" data-role="hide-progress"></div>
      </div>
      <div class="guide-pad" data-role="hide-guide"></div>
      <div class="bottom-bar">
        <div class="button-row">
          <button type="button" class="btn btn-primary btn-large" data-action="confirm-hide" disabled>
            <span data-role="hide-confirm-label"></span>
          </button>
        </div>
      </div>
    `;
    this.timerHideEl = screen.querySelector('[data-role="timer"]') as HTMLElement;
    this.hideEyebrowIconEl = screen.querySelector('[data-role="hide-eyebrow-icon"]') as HTMLElement;
    this.hideGuideEl = screen.querySelector('[data-role="hide-guide"]') as HTMLElement;
    this.hideConfirmLabelEl = screen.querySelector('[data-role="hide-confirm-label"]') as HTMLElement;
    this.hideProgressEl = screen.querySelector('[data-role="hide-progress"]') as HTMLElement;
    this.confirmHideBtn = screen.querySelector('[data-action="confirm-hide"]') as HTMLButtonElement;
    this.confirmHideBtn.addEventListener('click', () => this.actions.onConfirmHide());
    return screen;
  }

  private applyHideScreenMode(mode: GameMode): void {
    const meta = MODE_META[mode];
    // MODE_METAはソース定数(ユーザー入力なし)のためinnerHTMLでアイコン表示を許容する
    this.hideEyebrowIconEl.innerHTML = icon(meta.hideEyebrowIcon);
    this.hideGuideEl.innerHTML = meta.hideGuide;
    this.hideConfirmLabelEl.innerHTML = `${meta.confirmLabel}${icon(meta.confirmIcon)}`;
  }

  private buildHandover(): HTMLElement {
    const screen = el('section', 'screen screen-handover opaque');
    screen.innerHTML = `
      <p class="eyebrow">${icon('hourglass')} わたすとき</p>
      <div class="handover-warning">${icon('warning')} 画面を消したり、下に向けたりしないでね!(宝の場所がわからなくなっちゃうよ)</div>
      <div class="bottom-bar">
        <div class="button-row">
          <button type="button" class="btn btn-primary btn-large" data-action="start-seek">たんけんスタート！${icon('lantern')}</button>
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
        <p class="eyebrow">${icon('lantern')} <ruby>探<rt>さが</rt></ruby>す番</p>
        <div class="timer-pad" data-role="timer"></div>
      </div>
      <div class="cooldown-wrap" data-role="cooldown-wrap" hidden>
        <svg viewBox="0 0 48 48" class="cooldown-ring">
          <circle class="cooldown-ring-bg" cx="24" cy="24" r="20"></circle>
          <circle class="cooldown-ring-fg" data-role="cooldown-ring" cx="24" cy="24" r="20"></circle>
        </svg>
      </div>
    `;
    this.timerSeekEl = screen.querySelector('[data-role="timer"]') as HTMLElement;
    this.radarGlowEl = screen.querySelector('[data-role="radar-glow"]') as HTMLElement;
    this.cooldownWrap = screen.querySelector('[data-role="cooldown-wrap"]') as HTMLElement;
    this.cooldownRing = screen.querySelector('[data-role="cooldown-ring"]') as unknown as SVGCircleElement;
    this.cooldownRing.style.strokeDasharray = `${OverlayUI.COOLDOWN_CIRC}`;

    return screen;
  }

  private buildResult(): HTMLElement {
    const screen = el('section', 'screen screen-result');
    screen.innerHTML = `
      <div class="title-head">
        <p class="eyebrow">${icon('trophy')} けっか</p>
        <h1 data-role="result-message" class="result-message"></h1>
      </div>
      <div class="bottom-bar">
        <div class="button-row">
          <button type="button" class="btn btn-primary btn-large" data-action="retry">もういっかい！${icon('replay')}</button>
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
        <p class="eyebrow">${icon('warning')} エラー</p>
        <h1>あれ、うまくいかないよ</h1>
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
    if (phase === 'hide') {
      this.applyHideScreenMode(this.settings?.gameMode ?? 'chest');
    }
    if (phase === 'result' && ctx?.result) {
      // resultMessage()は固定文言テーブルを参照するのみ(ユーザー入力なし)のためinnerHTMLでルビ表示を許容する
      this.resultMessageEl.innerHTML = resultMessage(ctx.result, this.settings?.gameMode ?? 'chest');
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
    const text = `のこり ${Math.max(0, Math.ceil(remainSec))}秒`;
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

  updateHideProgress(placed: number, total: number): void {
    // placed/totalは内部カウンタ(数値)のみでユーザー入力はないため、アイコン表示にinnerHTMLを使う
    this.hideProgressEl.innerHTML = total > 1 ? `${icon('coin')} うめた数: ${placed} / ${total}` : '';
  }

  // msgは呼び出し側の固定文言のみを渡す想定(ユーザー入力は含めない)のためinnerHTMLでアイコン表示を許容する
  toast(msg: string): void {
    const node = el('div', 'toast');
    node.innerHTML = msg;
    this.toastContainer.appendChild(node);

    // フェードイン
    requestAnimationFrame(() => node.classList.add('visible'));

    setTimeout(() => {
      node.classList.remove('visible');
      setTimeout(() => node.remove(), 300);
    }, 2200);
  }

  /**
   * 面が検出できないときのガイド: メッセージのトーストに加えて、
   * スマホを8の字に動かすお手本を半透明のアニメーションで表示する。
   */
  showMoveGuide(msg: string): void {
    this.toast(msg);

    this.motionGuideEl.hidden = false;
    requestAnimationFrame(() => this.motionGuideEl.classList.add('visible'));

    if (this.motionGuideHideTimerId !== null) {
      clearTimeout(this.motionGuideHideTimerId);
    }
    this.motionGuideHideTimerId = setTimeout(() => {
      this.motionGuideHideTimerId = null;
      this.motionGuideEl.classList.remove('visible');
      setTimeout(() => {
        this.motionGuideEl.hidden = true;
      }, 300);
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
    for (const mode of Object.keys(this.gameModeInputs) as GameMode[]) {
      const input = this.gameModeInputs[mode];
      if (input) input.checked = mode === s.gameMode;
    }
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
    const checkedMode = (Object.keys(this.gameModeInputs) as GameMode[]).find(
      (mode) => this.gameModeInputs[mode]?.checked,
    );
    if (checkedMode) {
      next.gameMode = checkedMode;
    }
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
