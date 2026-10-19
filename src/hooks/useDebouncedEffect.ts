import { useEffect } from "react";

/**
 * 给自动保存用的防抖：值变化后延迟触发，期间再变则重新计时。
 * 用 ref 保存最新回调，避免调用方每次渲染都重设定时器。
 */
export function useDebouncedEffect(
  fn: () => void | Promise<void>,
  deps: unknown[],
  delay: number,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled || delay <= 0) return;
    const timer = window.setTimeout(() => {
      void fn();
    }, delay);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, delay, enabled]);
}
