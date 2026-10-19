import { useEffect, useRef, useState, type ReactNode } from "react";
import { FONT_PRESETS, resolveFontId, useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { THEME_LIST, themeDef } from "../services/themes";
import type { Settings } from "../types";
import { ThemeCard } from "./ThemeCard";

/**
 * 设置：居中的弹窗，**左侧分类 + 右侧内容**。
 *
 * 为什么不继续用一长条（或两列）滚动：设置项从 6 组涨到二十多项之后，
 * 找"自动保存"要在一屏里扫。分类把每组控制在 3–6 项，视线不用来回跑；
 * 切分类时内容区重新挂载（`key={tab}`），滚动位置也自然回到顶部。
 *
 * 关闭方式三种：关闭按钮、点弹窗外面、Esc（Esc 在 App 的全局键盘处理里）。
 */
const TABS = [
  { id: "appearance", label: "外观", hint: "主题与字体" },
  { id: "editor", label: "编辑器", hint: "字号、行高、输入习惯" },
  { id: "preview", label: "预览", hint: "视图与渲染" },
  { id: "workspace", label: "工作区", hint: "文件夹与数据安全" },
] as const;

type TabId = (typeof TABS)[number]["id"];

interface PaneProps {
  s: Settings;
  update: (patch: Partial<Settings>) => void;
}

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const s = useSettings();
  const update = useSettings((s) => s.update);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<TabId>("appearance");

  // 点空白处关闭：判断"点击是否落在弹窗里"，而不是给压暗层挂点击。
  // 压暗层会吃掉点击，于是"点设置按钮想关掉"会变成：压暗层先关、按钮再开，
  // 永远关不上——这是上一版踩过的坑。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (boxRef.current?.contains(target)) return;
      if (target.closest("[data-settings-toggle]")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <>
      <div className="settings-backdrop" />
      <div className="settings-modal" ref={boxRef} role="dialog" aria-label="设置">
        <div className="settings-modal-head">
          <span>设置</span>
          <span className="settings-modal-hint">点弹窗外面或按 Esc 关闭</span>
          <span className="spacer" />
          <button className="btn" onClick={() => setOpen(false)}>
            关闭
          </button>
        </div>

        <div className="settings-modal-main">
          <nav className="settings-nav" aria-label="设置分类">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`settings-nav-item${tab === t.id ? " active" : ""}`}
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => setTab(t.id)}
              >
                <span className="nav-label">{t.label}</span>
                <span className="nav-hint">{t.hint}</span>
              </button>
            ))}
          </nav>

          <div className="settings-pane" key={tab} role="group" aria-label={`设置：${tabLabel(tab)}`}>
            {tab === "appearance" ? <AppearancePane s={s} update={update} /> : null}
            {tab === "editor" ? <EditorPane s={s} update={update} /> : null}
            {tab === "preview" ? <PreviewSettingsPane s={s} update={update} /> : null}
            {tab === "workspace" ? <WorkspacePane s={s} update={update} /> : null}
          </div>
        </div>
      </div>
    </>
  );
}

function tabLabel(id: TabId): string {
  return TABS.find((t) => t.id === id)?.label ?? "";
}

// ---------------------------------------------------------------- 各分类内容

function AppearancePane({ s, update }: PaneProps) {
  return (
    <>
      <Field label="主题">
        <div className="theme-grid">
          {THEME_LIST.map((t) => (
            <ThemeCard
              key={t.id}
              theme={t}
              active={s.theme === t.id}
              onPick={() => update({ theme: t.id })}
            />
          ))}
        </div>
      </Field>
      <SwitchRow
        label="字体跟随主题"
        hint="开启后切换主题会同时换字体（每套主题都有自己的推荐字体栈）"
        on={s.fontFollowsTheme}
        onChange={(v) => update({ fontFollowsTheme: v })}
      />
      <Field
        label={`中文字体${s.fontFollowsTheme ? "（当前由主题决定）" : ""}`}
        hint={
          s.fontFollowsTheme
            ? `「${themeDef(s.theme).label}」推荐用「${FONT_PRESETS[resolveFontId(s)]?.label ?? "系统默认"}」。关掉上面的开关即可自己固定字体。`
            : "中英混排时字体回退链决定字重与基线是否对齐。装了更纱黑体的话，中文和英文的宽度会是整数倍，表格对齐更整齐。"
        }
      >
        <select
          value={s.fontFollowsTheme ? resolveFontId(s) : s.fontPreset}
          disabled={s.fontFollowsTheme}
          onChange={(e) => update({ fontPreset: e.target.value })}
        >
          {Object.entries(FONT_PRESETS).map(([key, v]) => (
            <option key={key} value={key}>
              {v.label}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

function EditorPane({ s, update }: PaneProps) {
  return (
    <>
      <SliderRow
        label="编辑器字号"
        value={s.editorSize}
        suffix="px"
        min={11}
        max={26}
        step={0.5}
        onChange={(v) => update({ editorSize: v })}
      />
      <SliderRow
        label="编辑器行高"
        value={s.editorLineHeight}
        fixed={2}
        min={1.3}
        max={2.6}
        step={0.05}
        hint="中文推荐 1.8–2.0，英文 1.5 就够。行高太小会让中文挤成一团。"
        onChange={(v) => update({ editorLineHeight: v })}
      />
      <SliderRow
        label="正文字宽"
        value={s.measure}
        suffix="em"
        min={28}
        max={80}
        step={1}
        hint="一行 35–45 个汉字最舒服，约等于 42–50em。"
        onChange={(v) => update({ measure: v })}
      />
      <SwitchRow
        label="显示行号"
        on={s.showLineNumbers}
        onChange={(v) => update({ showLineNumbers: v })}
      />
      <SwitchRow label="自动换行" on={s.softWrap} onChange={(v) => update({ softWrap: v })} />
      <SwitchRow
        label="打字机模式"
        hint="光标所在行始终停在视口中间"
        on={s.typewriterMode}
        onChange={(v) => update({ typewriterMode: v })}
      />
      <SwitchRow
        label="自动保存"
        hint="停止输入后自动写盘；关掉后只有 Ctrl+S 才会保存"
        on={s.autoSave}
        onChange={(v) => update({ autoSave: v })}
      />
      {s.autoSave ? (
        <SliderRow
          label="自动保存延迟"
          value={s.autoSaveDelayMs}
          suffix=" ms"
          min={400}
          max={5000}
          step={100}
          onChange={(v) => update({ autoSaveDelayMs: v })}
        />
      ) : null}
    </>
  );
}

function PreviewSettingsPane({ s, update }: PaneProps) {
  return (
    <>
      <div className="field-row">
        <div className="field-row-text">
          <span>视图</span>
          <span className="hint">编辑与预览是整幅切换，快捷键 Ctrl+Shift+V</span>
        </div>
        <div className="view-switch" role="group" aria-label="视图">
          <button
            className={s.viewMode === "edit" ? "active" : ""}
            onClick={() => update({ viewMode: "edit" })}
          >
            编辑
          </button>
          <button
            className={s.viewMode === "preview" ? "active" : ""}
            onClick={() => update({ viewMode: "preview" })}
          >
            预览
          </button>
        </div>
      </div>
      <SwitchRow
        label="切视图时对齐当前位置"
        hint="切到预览时按编辑器当前行定位，而不是从头开始"
        on={s.syncScroll}
        onChange={(v) => update({ syncScroll: v })}
      />
      <SliderRow
        label="预览字号"
        value={s.previewSize}
        suffix="px"
        min={11}
        max={26}
        step={0.5}
        onChange={(v) => update({ previewSize: v })}
      />
      <SwitchRow
        label="单换行即断行"
        hint="中文写作习惯「一段一行」：开启后单个换行就产生新段落；关闭后遵循严格 CommonMark，必须空一行才是新段落"
        on={s.breakOnSingleNewline}
        onChange={(v) => update({ breakOnSingleNewline: v })}
      />
    </>
  );
}

function WorkspacePane({ s, update }: PaneProps) {
  return (
    <>
      <Field label="当前文件夹">
        <div className="settings-path">{s.workspace ?? "（未打开）"}</div>
      </Field>
      <Field label="最近打开" hint="清空后不会影响磁盘上的文件">
        <div className="preset-row">
          <button onClick={() => update({ recentFiles: [], lastSession: null })}>
            清空最近记录与会话
          </button>
          <button onClick={() => update({ workspace: null })}>关闭文件夹</button>
        </div>
      </Field>
      <Field label="数据安全">
        <div className="hint">
          保存采用「临时文件 + 原子替换」，中途崩溃不会损坏原文件。文件被外部程序修改时，
          如果本地有未保存改动，会提示你选择保留哪一边，绝不静默覆盖。删除操作走系统回收站。
        </div>
      </Field>
    </>
  );
}

// ---------------------------------------------------------------- 复用的小组件

/** 一个带标题、控件、说明的字段 */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

/** 开关行：左标题（可带说明），右开关 */
function SwitchRow({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="field-row">
      <div className="field-row-text">
        <span>{label}</span>
        {hint ? <span className="hint">{hint}</span> : null}
      </div>
      <button
        className={`switch${on ? " on" : ""}`}
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
      />
    </div>
  );
}

/** 滑杆行：标题里带当前值，拖动即时生效 */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  fixed,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  /** 固定小数位（行高这类 1.85 的数值） */
  fixed?: number;
  hint?: string;
  onChange: (v: number) => void;
}) {
  const shown = fixed === undefined ? String(value) : value.toFixed(fixed);
  return (
    <Field label={`${label}：${shown}${suffix}`} hint={hint}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  );
}
