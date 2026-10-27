// A native Think facet: task lineages own their conversation and SQLite workspace.
// Only brief text enters history. Credentials and task capabilities travel through host RPC.
import { Think, type TurnContext, type TurnConfig, type ThinkSubmissionInspection, type StepContext } from "@cloudflare/think";
import { jsonSchema, dynamicTool, type ToolSet, type JSONSchema7 } from "ai";
import type { AeliosConfig } from "./aelios";
import type { StepLike } from "./usage";

type TaskParent = {
  taskWorkerConfig(id: string, code: string): Promise<{ model: string; memory: AeliosConfig | null; gatewayId: string; custom: Partial<Env>; tools: { name: string; description: string; schema: JSONSchema7 }[] }>;
  taskWorkerTool(id: string, code: string, name: string, input: unknown): Promise<unknown>;
  taskWorkerUsage(id: string, code: string, step: StepLike): Promise<void>;
  taskReport(id: string, code: string, kind: "progress" | "result", body: unknown): Promise<unknown>;
  taskWorkerFinished(id: string, code: string, body: unknown): Promise<void>;
};
import { Resident } from "./resident";
import { LOCAL_TASK_STEPS, LOCAL_TASK_SYSTEM, extractHttpsLinks, localStepProgress } from "./cloud-tasks";
import { aeliosModel } from "./via-aelios";
import { customModel, isCustom } from "./custom";
import { fakeModel } from "./fake-model";
import { claudeOnRunPath } from "./claude-run";

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
      model, tools, maxSteps: LOCAL_TASK_STEPS, maxOutputTokens: 4000,
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

  protected override async onSubmissionStatus(submission: ThinkSubmissionInspection): Promise<void> {
    if (!["completed", "error", "aborted", "skipped"].includes(submission.status)) return;
    const { taskId, code } = submission.metadata ?? {};
    if (typeof taskId !== "string" || typeof code !== "string") return;
    const message = submission.messageId ? (await this.getMessages()).find((m) => m.id === submission.messageId) : undefined;
    const summary = message?.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").trim() ?? "";
    const parent = await this.parentAgent(Resident) as unknown as TaskParent;
    await parent.taskWorkerFinished(taskId, code, submission.status === "completed" && !!summary
      ? { status: "done", summary, links: extractHttpsLinks(summary) }
      : { status: "failed", summary: submission.status === "completed" ? "后台跑完了，但没写出结果。" : "后台任务中断或执行失败。" });
  }
}
