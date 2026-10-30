// One of the resident's threads (cloud-tasks.ts): a Think child with its own conversation and files, one per thread
// of tasks, so a follow-up carries on where the last one stopped. Only the brief enters its history: the task's code
// and every key stay with the host, which the thread reaches over RPC for its model settings and its tools.
import { Think, type TurnContext, type TurnConfig, type ThinkSubmissionInspection, type StepContext } from "@cloudflare/think";
import { jsonSchema, dynamicTool, type ToolSet, type JSONSchema7 } from "ai";
import type { AeliosConfig } from "./aelios";
import type { StepLike } from "./usage";
import { Resident } from "./resident";
import { LOCAL_TASK_OUTPUT, LOCAL_TASK_STEPS, LOCAL_TASK_SYSTEM, extractHttpsLinks, localStepProgress } from "./cloud-tasks";
import { aeliosModel } from "./via-aelios";
import { customModel, isCustom } from "./custom";
import { fakeModel } from "./fake-model";
import { claudeOnRunPath } from "./claude-run";

type TaskParent = {
  taskWorkerConfig(id: string, code: string): Promise<{ model: string; memory: AeliosConfig | null; gatewayId: string; custom: Partial<Env>; tools: { name: string; description: string; schema: JSONSchema7 }[] }>;
  taskWorkerTool(id: string, code: string, name: string, input: unknown): Promise<unknown>;
  taskWorkerUsage(id: string, code: string, step: StepLike): Promise<void>;
  taskReport(id: string, code: string, kind: "progress" | "result", body: unknown): Promise<unknown>;
  taskWorkerFinished(id: string, code: string, body: unknown): Promise<void>;
};

/** A message of the thread as the web page shows it: its words, and a line for each tool it used. */
export type ThreadLine = { id: string; role: "user" | "assistant"; text: string; steps: string[] };
/** A file of the thread's. `at` is when it was last written. */
export type ThreadFile = { path: string; size: number; at: number };

const FILES_MAX = 300;
// What the web page can open or download at once.
export const THREAD_FILE_MAX = 10 * 1024 * 1024;

/**
 * Where a file a run on GitHub Actions hands back goes among the thread's files: its path in the run's workspace,
 * from the top. Null for one that is not a plain relative path (dot files, "..", control characters).
 */
export function handedPath(raw: string): string | null {
  const parts = raw.split("/");
  if (!raw || raw.length > 200 || /[\\\u0000-\u001f\u007f]/.test(raw) || parts.some((part) => !part || part.startsWith(".") || part === "node_modules")) return null;
  return `/${raw}`;
}

const LINES_MAX = 200;
const FINISHED = ["completed", "error", "aborted", "skipped"];

type Part = { type: string; text?: string; toolName?: string; input?: unknown };

export class TaskWorker extends Think<Env> {
  private gatewayId = "";
  override getModel(): string { throw new Error("Task model is supplied by the parent at turn admission"); }
  override getSystemPrompt(): string { return LOCAL_TASK_SYSTEM; }
  override getGateway() { return this.gatewayId ? { id: this.gatewayId } : undefined; }
  override getAIBinding(): Ai { return claudeOnRunPath(super.getAIBinding()); }

  async enqueue(job: { id: string; code: string; brief: string }) {
    return this.submitMessages([{ id: `task_${job.id}`, role: "user", parts: [{ type: "text", text: job.brief }] }], {
      submissionId: job.id, idempotencyKey: job.id, metadata: { taskId: job.id, code: job.code }
    });
  }

  private async currentJob(requestId?: string) {
    const submissions = await this.listSubmissions({ status: "running", limit: 100 });
    const submission = submissions.find((s) => s.requestId === requestId);
    const { taskId, code } = submission?.metadata ?? {};
    if (typeof taskId !== "string" || typeof code !== "string") throw new Error("No admitted task submission");
    return { id: taskId, code };
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    const job = await this.currentJob(ctx.requestId);
    const parent = await this.parentAgent(Resident) as unknown as TaskParent;
    const config = await parent.taskWorkerConfig(job.id, job.code);
    this.gatewayId = config.gatewayId;
    const model = config.model === "fake" && this.env.FAKE_MODEL === "true" ? fakeModel()
      : config.memory ? aeliosModel(config.memory, config.model, { auxiliary: true })
      : isCustom(config.model) ? customModel(config.custom as Env, config.model) : config.model;
    const tools: ToolSet = {};
    for (const descriptor of config.tools) {
      tools[descriptor.name] = dynamicTool({
        description: descriptor.description,
        inputSchema: jsonSchema(descriptor.schema),
        execute: async (input) => parent.taskWorkerTool(job.id, job.code, descriptor.name, input)
      });
    }
    return {
      model, tools, maxSteps: LOCAL_TASK_STEPS, maxOutputTokens: LOCAL_TASK_OUTPUT,
      stopWhen: ({ steps }) => steps.some((step) => step.toolResults.some((result) =>
        result.toolName === "report_result" && !!result.output && typeof result.output === "object" && "ok" in result.output && result.output.ok === true
      ))
    };
  }

  override async onStepEnd(step: StepContext): Promise<void> {
    const job = await this.currentJob(this.activeTurn?.requestId);
    const parent = await this.parentAgent(Resident) as unknown as TaskParent;
    await parent.taskWorkerUsage(job.id, job.code, {
      model: step.model, usage: step.usage, response: { modelId: step.response.modelId },
      toolCalls: step.toolCalls.map((call) => ({ toolName: call.toolName }))
    });
    if (step.toolCalls.some((call) => call.toolName === "report_progress" || call.toolName === "report_result")) return;
    for (const call of step.toolCalls) {
      const line = localStepProgress(call.toolName, "input" in call ? call.input : undefined);
      if (line) { await parent.taskReport(job.id, job.code, "progress", { line }); break; }
    }
  }

  /** The result of a finished job that did not call report_result: its last words, or why it stopped. */
  private async reportOf(submission: ThinkSubmissionInspection) {
    const message = submission.messageId ? (await this.getMessages()).find((m) => m.id === submission.messageId) : undefined;
    const summary = message?.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n").trim() ?? "";
    return submission.status === "completed" && summary
      ? { status: "done", summary, links: extractHttpsLinks(summary) }
      : { status: "failed", summary: submission.status === "completed" ? "线程做完了，但没写出结果。" : "线程中途停了，没做完。" };
  }

  protected override async onSubmissionStatus(submission: ThinkSubmissionInspection): Promise<void> {
    if (!FINISHED.includes(submission.status)) return;
    const { taskId, code } = submission.metadata ?? {};
    if (typeof taskId !== "string" || typeof code !== "string") return;
    const parent = await this.parentAgent(Resident) as unknown as TaskParent;
    await parent.taskWorkerFinished(taskId, code, await this.reportOf(submission));
  }

  /**
   * How a job stands, for the host's quiet check: Think does not retry onSubmissionStatus, so a result that did
   * not get through is picked up here. null while it is still running.
   */
  async finishedReport(taskId: string): Promise<{ status: string; summary: string; links?: string[] } | null> {
    const submission = await this.inspectSubmission(taskId);
    if (!submission) return { status: "failed", summary: "线程里找不到这一单。" };
    return FINISHED.includes(submission.status) ? this.reportOf(submission) : null;
  }

  /** The thread's conversation, newest last. */
  async threadView(): Promise<ThreadLine[]> {
    const lines: ThreadLine[] = [];
    for (const message of (await this.getMessages()).slice(-LINES_MAX)) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const parts = message.parts as Part[];
      const steps: string[] = [];
      for (const part of parts) {
        const name = part.type === "dynamic-tool" ? (part.toolName ?? "") : part.type.startsWith("tool-") ? part.type.slice(5) : "";
        if (!name) continue;
        if (name === "report_progress") {
          const line = (part.input as { line?: unknown } | undefined)?.line;
          if (typeof line === "string" && line.trim()) steps.push(line.trim().slice(0, 200));
          continue;
        }
        const line = localStepProgress(name, part.input);
        if (line) steps.push(line);
      }
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").trim();
      lines.push({ id: message.id, role: message.role, text, steps });
    }
    return lines;
  }

  /** The files it has written, the newest first. */
  async listFiles(): Promise<ThreadFile[]> {
    const fs = this.workspace.fs;
    const entries = await fs.find("/", undefined, { limit: FILES_MAX * 3, exclude: [".agents/**"] }).catch(() => []);
    const files: ThreadFile[] = [];
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      const stat = await fs.stat(entry.path).catch(() => null);
      if (stat?.isFile) files.push({ path: entry.path, size: stat.size, at: stat.mtime });
      if (files.length >= FILES_MAX) break;
    }
    return files.sort((a, b) => b.at - a.at);
  }

  /** A file a run on GitHub Actions made for them (handedPath): kept with the thread's own, a newer one over an older. */
  async keepFile(path: string, bytes: Uint8Array): Promise<void> {
    const fs = this.workspace.fs;
    const folder = path.slice(0, path.lastIndexOf("/"));
    if (folder) await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path, bytes);
  }

  /** One file's bytes, for the web page to open or download; null when there is no such file or it is too big. */
  async fileBytes(path: string): Promise<Uint8Array | null> {
    const fs = this.workspace.fs;
    const stat = await fs.stat(path).catch(() => null);
    if (!stat?.isFile || stat.size > THREAD_FILE_MAX) return null;
    const stream = await fs.readFile(path);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
}
