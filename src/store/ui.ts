import { create } from "zustand";
import type { Command, Toast } from "../types";
import type { Anchor } from "../services/popover";

/**
 * 应用内对话框。
 *
 * 关键：**不要用 window.prompt / window.confirm**。
 * WebView2 默认把它们静默禁用——不弹窗、不报错，prompt 直接返回 null，
 * 表现为"点了新建什么都没发生，也没有提示"。所以自己实现。
 */

interface ModalBase {
  id: number;
  resolve: ((value: string | boolean | null) => void) | null;
  error: string | null;
}

interface PromptModal extends ModalBase {
  kind: "prompt";
  title: string;
  label?: string;
  value: string;
  placeholder?: string;
  confirmText?: string;
  /** 返回错误信息表示不允许提交（例如名称不合法） */
  validate?: (value: string) => string | null;
}

interface ConfirmModal extends ModalBase {
  kind: "confirm";
  title: string;
  message: string;
  danger?: boolean;
  confirmText?: string;
}

interface MessageModal extends ModalBase {
  kind: "message";
  title: string;
  message: string;
  confirmText?: string;
}

type ModalState = PromptModal | ConfirmModal | MessageModal;

/** 打开对话框时需要提供的部分（id/resolve/error 由 store 补齐） */
export type ModalSpec =
  | Omit<PromptModal, "id" | "resolve" | "error">
  | Omit<ConfirmModal, "id" | "resolve" | "error">
  | Omit<MessageModal, "id" | "resolve" | "error">;

interface ContextMenuState {
  x: number;
  y: number;
  target: string;
  isDir: boolean;
}

interface UiState {
  sidebarVisible: boolean;
  sidebarTab: "files" | "outline";
  settingsOpen: boolean;
  paletteOpen: boolean;
  /**
   * 主题选择面板：null = 关闭；`{ anchor: null }` = 打开但没有锚点
   * （从命令面板打开时就是这种，落点用默认位置）。
   */
  themePicker: { anchor: Anchor | null } | null;
  toasts: Toast[];
  /** 供文件树刷新用（保存/新建/删除后 +1） */
  treeVersion: number;
  modal: ModalState | null;
  contextMenu: ContextMenuState | null;

  setSidebar: (v: boolean) => void;
  toggleSidebar: () => void;
  setSidebarTab: (t: "files" | "outline") => void;
  setSettingsOpen: (v: boolean) => void;
  /** 打开搜索面板（命令 + 文件，只有一个面板，所以没有模式参数） */
  openPalette: () => void;
  closePalette: () => void;
  openThemePicker: (anchor: Anchor | null) => void;
  closeThemePicker: () => void;
  toast: (text: string) => void;
  dismissToast: (id: number) => void;
  bumpTree: () => void;

  /** 内部：打开对话框并挂上 resolve */
  openModal: <T extends ModalSpec>(spec: T) =>
    Promise<T extends { kind: "prompt" } ? string | null : boolean>;
  setModalError: (error: string | null) => void;
  /** 由对话框组件调用：提交 / 取消 */
  settleModal: (value: string | boolean | null) => void;
  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;
}

let toastSeq = 0;
let modalSeq = 0;

export const useUi = create<UiState>((set, get) => ({
  sidebarVisible: true,
  sidebarTab: "files",
  settingsOpen: false,
  paletteOpen: false,
  themePicker: null,
  toasts: [],
  treeVersion: 0,
  modal: null,
  contextMenu: null,

  setSidebar: (v) => set({ sidebarVisible: v }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setSidebarTab: (t) => set({ sidebarTab: t }),
  // 设置弹窗与搜索面板互斥：两个都是盖住整屏的浮层，同时开着只会互相挡
  setSettingsOpen: (v) =>
    set(v ? { settingsOpen: true, paletteOpen: false, themePicker: null } : { settingsOpen: false }),
  openPalette: () => set({ paletteOpen: true, themePicker: null, settingsOpen: false }),
  closePalette: () => set({ paletteOpen: false }),
  openThemePicker: (anchor) => set({ themePicker: { anchor } }),
  closeThemePicker: () => set((s) => (s.themePicker ? { themePicker: null } : {})),
  toast: (text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, text }] }));
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 2600);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  bumpTree: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),

  openModal: ((spec: ModalSpec) =>
    new Promise<string | boolean | null>((resolve) => {
      // 同一时间只允许一个对话框；旧的按取消处理，避免 promise 永远悬着
      const prev = get().modal;
      if (prev?.resolve) prev.resolve(null);
      set({
        modal: {
          ...spec,
          id: ++modalSeq,
          resolve,
          error: null,
        } as ModalState,
        contextMenu: null,
      });
      // 实现返回宽类型，对外按 spec.kind 收紧（prompt → string|null，其余 → boolean）
    })) as unknown as UiState["openModal"],

  setModalError: (error) => set((s) => (s.modal ? { modal: { ...s.modal, error } } : {})),

  settleModal: (value) => {
    const modal = get().modal;
    set({ modal: null });
    modal?.resolve?.(value);
  },

  openContextMenu: (menu) => set({ contextMenu: menu }),
  closeContextMenu: () => set((s) => (s.contextMenu ? { contextMenu: null } : {})),
}));

// ---------------------------------------------------------------- 对话框便捷封装

/** 文本输入。取消返回 null。 */
export async function promptText(
  title: string,
  opts: { value?: string; label?: string; placeholder?: string; confirmText?: string; validate?: (v: string) => string | null } = {},
): Promise<string | null> {
  const res = await useUi.getState().openModal({
    kind: "prompt",
    title,
    value: opts.value ?? "",
    label: opts.label,
    placeholder: opts.placeholder,
    confirmText: opts.confirmText,
    validate: opts.validate,
  });
  return typeof res === "string" ? res : null;
}

/** 确认。取消或关闭返回 false。 */
export async function confirmAction(
  title: string,
  message: string,
  opts: { danger?: boolean; confirmText?: string } = {},
): Promise<boolean> {
  const res = await useUi.getState().openModal({
    kind: "confirm",
    title,
    message,
    danger: opts.danger,
    confirmText: opts.confirmText,
  });
  return res === true;
}

/** 纯提示，只有一个"知道了"。 */
export async function showMessage(title: string, message: string): Promise<void> {
  await useUi.getState().openModal({ kind: "message", title, message, confirmText: "知道了" });
}

// ---------------------------------------------------------------- 命令注册表

const registry = new Map<string, Command>();

export function registerCommands(cmds: Command[]): void {
  for (const c of cmds) registry.set(c.id, c);
}

export function listCommands(): Command[] {
  return Array.from(registry.values());
}

export function runCommand(id: string): void {
  const cmd = registry.get(id);
  if (!cmd) {
    console.warn("未知命令", id);
    return;
  }
  void cmd.run();
}
