import { useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../store/ui";

/**
 * 应用内对话框：输入 / 确认 / 提示。
 *
 * 之所以不用 window.prompt / window.confirm：WebView2 下它们被静默禁用，
 * 不弹窗也不报错，直接返回 null——用户看到的是"点了没反应"。
 */
export function ModalDialog() {
  const modal = useUi((s) => s.modal);
  const settle = useUi((s) => s.settleModal);
  const setError = useUi((s) => s.setModalError);

  const [value, setValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const overlayDown = useRef(false);
  /** 输入法是否正在组词（用于避免回车误提交） */
  const composing = useRef(false);

  const id = modal?.id ?? 0;
  const isPrompt = modal?.kind === "prompt";

  useEffect(() => {
    // 只在"换了一个对话框"时初始化输入框。
    //
    // 依赖必须是 [id]，**不能带 modal**：modal 是 store 里每次 set() 都新建的对象，
    // 输入框的 onChange 会调用 setError(null) 触发 store 更新 → modal 引用变化 →
    // 这个 effect 重跑 → 把用户刚输入的内容重置回初始值。
    // 表现就是"打字看着进去了，一回车提交的还是旧名字"。
    const current = useUi.getState().modal;
    if (!current) return;
    setLocalError(null);
    setValue(current.kind === "prompt" ? current.value : "");
  }, [id]);

  useEffect(() => {
    if (!isPrompt) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // 只选中文件名主体，扩展名保留，方便直接改名
    const dot = el.value.lastIndexOf(".");
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [id, isPrompt]);

  const error = useMemo(() => localError ?? modal?.error ?? null, [localError, modal?.error]);

  if (!modal) return null;

  const submit = () => {
    if (modal.kind === "prompt") {
      const v = value.trim();
      if (!v) {
        setLocalError("名称不能为空");
        return;
      }
      const problem = modal.validate?.(v) ?? null;
      if (problem) {
        setLocalError(problem);
        return;
      }
      settle(v);
      return;
    }
    settle(true);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      settle(null);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const confirmText = modal.confirmText ?? (modal.kind === "confirm" ? "确定" : "创建");

  return (
    <div
      className="overlay modal-overlay"
      // 只在"按下与抬起都落在遮罩本身"时才算点击外部关闭。
      // 要求 mouseup 也检查，是为了避免误触：在输入框里按下、顺手滑出去松开，
      // 不会把正在填写的对话框关掉。
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) overlayDown.current = true;
      }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && overlayDown.current) settle(null);
        overlayDown.current = false;
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={modal.title}
        onMouseDown={(e) => {
          e.stopPropagation();
          overlayDown.current = false;
        }}
        onMouseUp={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="modal-title">{modal.title}</div>

        {modal.kind === "prompt" ? (
          <div className="modal-body">
            {modal.label ? <label className="modal-label">{modal.label}</label> : null}
            <input
              ref={inputRef}
              className="modal-input"
              value={value}
              placeholder={modal.placeholder}
              // 关掉 WebView2 的自动填充/历史建议下拉：对文件名输入毫无价值，
              // 而且它浮在页面上时可能抢走键盘输入
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              name="inkdown-filename"
              onChange={(e) => {
                setValue(e.target.value);
                setLocalError(null);
                setError(null);
              }}
              // 回车直接提交：绑在输入框自身，不依赖事件冒泡到对话框容器。
              // 组合期间（中文输入法正在选词）必须放行——否则用户敲回车选词时
              // 会把还没上屏的拼音当成文件名提交掉。
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                if (e.nativeEvent.isComposing || composing.current) return;
                e.preventDefault();
                e.stopPropagation();
                submit();
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
            />
            {error ? <div className="modal-error">{error}</div> : null}
          </div>
        ) : (
          <div className="modal-body">
            <div className="modal-message">{modal.message}</div>
            {error ? <div className="modal-error">{error}</div> : null}
          </div>
        )}

        <div className="modal-actions">
          {modal.kind === "message" ? null : (
            <button className="btn" onClick={() => settle(null)}>
              取消
            </button>
          )}
          <button
            className={`btn primary${modal.kind === "confirm" && modal.danger ? " danger" : ""}`}
            onClick={submit}
            autoFocus={modal.kind !== "prompt"}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
