/**
 * 保存成功后的提示策略（纯逻辑，可单测）。
 *
 * 用户报的问题是："保存成功之后再按 Ctrl+S，每次都弹一遍「已保存」"。
 * 提示的意义是"这次按键真的把改动写下去了"，所以判断依据不是"保存成功"，
 * 而是**保存之前有没有改动**（或者刚解决过一次冲突——那种情况必须让用户知道
 * 现在磁盘上是哪个版本）。
 *
 * 注意：这里只决定"弹不弹"，**不决定写不写**。显式保存永远真写盘
 * （见 store/docs.ts 的 save()），否则一旦内存脏标记与磁盘不同步，就会出现
 * "提示已保存、实际没写"的老问题。
 */
export function shouldAnnounceSave(before: { dirty: boolean; conflict: boolean }): boolean {
  return before.dirty || before.conflict;
}

/**
 * 提示文案：非 UTF-8 时把编码带上（CRLF 也一起说清），
 * 免得用户以为保存把编码改掉了。
 */
export function saveToastText(doc: { encoding: string; eol: string | null }): string {
  if (doc.encoding !== "UTF-8") {
    return `已保存（${doc.encoding}${doc.eol === "\r\n" ? " / CRLF" : ""}）`;
  }
  return "已保存";
}
