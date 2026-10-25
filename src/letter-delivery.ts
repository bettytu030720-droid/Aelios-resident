import type { AeliosConfig } from "./aelios";
import type { DeliveryRow } from "./letter-state";

export type LetterDeliveryResult = { ok: true } | { ok: false; error: string };

/**
 * Confirm one persisted letter's receipt. The current Aelios ingest endpoint is NOT idempotent:
 * a timeout, partial failure, or lost response can mean it saved the letter already. Retries are
 * at-least-once; the stable header is for tracing only, never a promise of server-side deduplication.
 */
export async function deliverLetter(
  config: AeliosConfig,
  row: Pick<DeliveryRow, "id" | "text" | "url" | "namespace">,
  fetcher: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(30_000)
): Promise<LetterDeliveryResult> {
  if (config.url !== row.url || config.namespace !== row.namespace) {
    return { ok: false, error: "Aelios 目标已改变，未发送交接信。" };
  }
  try {
    const response = await fetcher(`${row.url}/v1/memory/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.key}`,
        "content-type": "application/json",
        "x-resident-letter-id": row.id
      },
      body: JSON.stringify({
        namespace: row.namespace,
        conversation_id: `${row.namespace}:aelios-resident`,
        source: "aelios-resident:letter",
        messages: [{ role: "assistant", content: `（交接信）${row.text}` }]
      }),
      // Workers supports manual/follow, not the browser-only "error" mode. Never forward credentials.
      redirect: "manual",
      signal
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, error: `Aelios 返回 HTTP ${response.status}，未确认送达。` };
    }
    const body: unknown = await response.json();
    const data = body && typeof body === "object" && "data" in body ? body.data : null;
    const ids = data && typeof data === "object" && "message_ids" in data ? data.message_ids : null;
    if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string" || !ids[0].trim()) {
      return { ok: false, error: "Aelios 没有返回有效保存凭据，送达结果未确认；重试可能产生重复原文。" };
    }
    return { ok: true };
  } catch {
    // Never expose an upstream body or exception: it can contain URLs, credentials or private text.
    return { ok: false, error: "连接 Aelios 失败、超时或响应无效，送达结果未确认；重试可能产生重复原文。" };
  }
}
