import type { LetterStateStore, WriteState } from "./letter-state";

export function letterWriteStatus(state: WriteState | null): string {
  if (!state) return "还没写过";
  switch (state.state) {
    case "writing": return "正在写信";
    case "recovering": return "正在恢复上次写信或收起旧聊天，请稍后查看";
    case "written": return "已写好，旧聊天已收起";
    case "empty": return "没有近期保留范围之外的旧聊天可收起";
    case "failed": return `写信失败：${state.error ?? "未能完成"} 可用 /handoff 重试，不会自动反复调用模型。`;
  }
}

export function letterDeliveryStatus(summary: ReturnType<LetterStateStore["summary"]>): string {
  const parts: string[] = [];
  if (summary.pending) parts.push(`${summary.pending} 封待送达或等待重试`);
  if (summary.failed) parts.push(`${summary.failed} 封重试次数用尽，可在设置页重试同步`);
  if (summary.blocked) parts.push(`${summary.blocked} 封因 Aelios 配置改变而暂停`);
  if (summary.latest?.status === "sent") parts.push("最近一封已送达 Aelios");
  if (summary.latest?.lastError) parts.push(summary.latest.lastError);
  return parts.join("；") || "还没有同步记录（未配置 Aelios 时只保存在本地）";
}
