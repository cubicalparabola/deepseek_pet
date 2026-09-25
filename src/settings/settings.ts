/**
 * 设置窗口页面逻辑。
 *
 * 唯一职责：把滚动条的位置翻译成 `scale`，交给 `window.settingsAPI`，
 * 再把主进程返回的**真实生效尺寸**回显出来。
 *
 * 交互约定（与主进程一致）：**拖动即生效 + 立即写盘**。
 * 界面上的百分比是"用户请求值"，右侧括号里的像素是"实际生效值"
 * —— 两者在显示器高度不够时会不同（见下方 notice）。
 */

import {
  PET_BASE_HEIGHT,
  PET_SCALE_DEFAULT,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  PET_SCALE_STEP,
  formatPetScale,
  scaleToStepIndex,
  stepIndexToScale,
  type PetSettingsState,
} from '../shared/pet-size';
import type { SettingsWindowBridge } from '../shared/settings-window';
import { mountAIPanel } from './ai-panel';

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少必需的 DOM 元素: #${id}`);
  return element as T;
}

const bridge = (window as unknown as { settingsAPI?: SettingsWindowBridge }).settingsAPI;

const slider = requireElement<HTMLInputElement>('scale-slider');
const percentLabel = requireElement('scale-percent');
const detailLabel = requireElement('scale-detail');
const notice = requireElement('notice');
const savedLabel = requireElement('saved');
const alwaysOnTopInput = requireElement<HTMLInputElement>('always-on-top');
const resetButton = requireElement<HTMLButtonElement>('reset');
const openConfigButton = requireElement<HTMLButtonElement>('open-config');
const closeButton = requireElement<HTMLButtonElement>('close');
const stepLabel = requireElement('step');
const rangeLabel = requireElement('range');
const tickMin = requireElement('tick-min');
const tickDefault = requireElement('tick-default');
const tickMax = requireElement('tick-max');

/* 让滚动条的范围与共享模型保持一致（HTML 里的 min/max 只是兜底） */
slider.min = String(scaleToStepIndex(PET_SCALE_MIN));
slider.max = String(scaleToStepIndex(PET_SCALE_MAX));
slider.step = '1';
stepLabel.textContent = formatPetScale(PET_SCALE_STEP);
rangeLabel.textContent = `${formatPetScale(PET_SCALE_MIN)}–${formatPetScale(PET_SCALE_MAX)}`;
// 刻度文字也来自常量，避免改了范围却忘了改刻度
tickMin.innerHTML = `${formatPetScale(PET_SCALE_MIN)}<br /><small>最小</small>`;
tickDefault.innerHTML = `${formatPetScale(PET_SCALE_DEFAULT)}<br /><small>默认</small>`;
tickMax.innerHTML = `${formatPetScale(PET_SCALE_MAX)}<br /><small>上限</small>`;

/** 最后一次用户请求的比例（乐观显示用，避免等待 IPC 往返）。 */
let requestedScale = 1;
/** 正在飞行中的 IPC 调用数（>0 时说明落盘还在进行）。 */
let inFlight = 0;
let savedTimer: number | null = null;

function flashSaved(): void {
  savedLabel.textContent = inFlight > 0 ? '保存中…' : '已保存';
  savedLabel.classList.add('show');
  if (savedTimer !== null) window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => savedLabel.classList.remove('show'), 1100);
}

/** 用请求值刷新文案（立即反馈，不等待主进程）。 */
function renderRequested(scale: number): void {
  percentLabel.textContent = formatPetScale(scale);
  // 请求值的理论像素高度；实际值等主进程回来再覆盖
  const idealHeight = Math.round(PET_BASE_HEIGHT * scale);
  detailLabel.textContent = `目标高度 ${idealHeight}px`;
}

/** 用主进程返回的真实尺寸刷新文案。 */
function renderApplied(state: PetSettingsState): void {
  const { size } = state;
  requestedScale = size.scale;
  slider.value = String(scaleToStepIndex(size.scale));
  percentLabel.textContent = formatPetScale(size.scale);
  detailLabel.textContent = `窗口 ${size.width}×${size.height}px · 实际高度 ${size.height}px`;
  alwaysOnTopInput.checked = state.alwaysOnTop;

  if (size.clampedByDisplay) {
    notice.hidden = false;
    notice.textContent =
      `已按屏幕高度自动收敛：请求 ${formatPetScale(size.scale)}，` +
      `实际生效 ${formatPetScale(size.windowScale)}（${size.height}px）。` +
      '屏幕装不下更高，再往上拖也不会变大。';
  } else if (size.windowScale < size.scale - 0.001) {
    notice.hidden = false;
    notice.textContent = `请求 ${formatPetScale(size.scale)}，实际生效 ${formatPetScale(size.windowScale)}。`;
  } else {
    notice.hidden = true;
  }
}

/**
 * 应用一个新比例。
 *
 * ⚠️ 这里**不做防抖**：滑块每一次移动都必须真实生效，
 * 否则松手那一刻的最终位置可能与窗口尺寸不一致。
 * 改为"单飞 + 补最后一帧"：同一时刻只允许一个 IPC 在飞，
 * 飞行期间记录最新值，回来后立刻再发一次 —— 拖得再快也不会丢终点。
 */
function applyScale(scale: number): void {
  if (!bridge) return;
  requestedScale = scale;
  renderRequested(scale);
  if (inFlight > 0) return;

  const send = (): void => {
    inFlight += 1;
    void bridge
      .setScale(requestedScale)
      .then((state) => {
        inFlight -= 1;
        // 期间用户又拖了：先按最新值再发一次，最后才渲染
        if (Math.abs(state.size.scale - requestedScale) > 1e-6) {
          send();
          return;
        }
        renderApplied(state);
        flashSaved();
      })
      .catch(() => {
        inFlight -= 1;
        savedLabel.textContent = '保存失败';
        savedLabel.classList.add('show');
      });
  };

  send();
}

/* --------------------------------- 事件 --------------------------------- */

slider.addEventListener('input', () => {
  applyScale(stepIndexToScale(Number(slider.value)));
});

alwaysOnTopInput.addEventListener('change', () => {
  if (!bridge) return;
  void bridge.setAlwaysOnTop(alwaysOnTopInput.checked).then(renderApplied);
});

resetButton.addEventListener('click', () => {
  applyScale(1);
});

openConfigButton.addEventListener('click', () => {
  void bridge?.openConfigFolder();
});

closeButton.addEventListener('click', () => {
  void bridge?.close();
});

/* 托盘菜单改尺寸时同步回显（含 notice） */
bridge?.onChanged(renderApplied);

/* --------------------------------- 初始化 -------------------------------- */

if (!bridge) {
  detailLabel.textContent = '设置桥未注入（preload 失败）';
} else {
  renderApplied(bridge.initial.state);
}

/*
 * AI 认知与人格面板（2.1~2.4）。
 *
 * 面板自己是"闭包内聚"的：拿到容器、AI 桥与初始状态后自带事件与刷新逻辑，
 * 因此这里只有一行接线 —— 尺寸设置与 AI 设置互不影响。
 * 面板内部所有文本都用 textContent 落地（模型/用户输入永不进 innerHTML）。
 */
try {
  if (bridge) mountAIPanel(requireElement('ai-panel-root'), bridge.ai, bridge.initial.ai);
} catch (error) {
  // 面板挂载失败不能连累"调尺寸"这个核心功能
  console.error('[settings] mounting ai panel failed', error);
}
