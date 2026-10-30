// Roles for cloud_task (cloud-tasks.ts): ready-made job templates, so the resident does not write the same
// instructions out every time. Three come with it (coder, reviewer, researcher); on the settings page they can be
// changed, removed and added to, each with the model its threads use. A role is how to do a kind of work, not a
// person: no name, no persona.
import type { Sql } from "./sticker-store";

export const ROLE_NAME = /^[a-z][a-z0-9-]{0,23}$/;
const TEMPLATE_MAX = 1500;
const MODEL_MAX = 120;
export const ROLES_MAX = 12;

// The three that come with it. Drawn from well-tried agent skills, kept short: obra/superpowers'
// systematic-debugging, test-driven-development and verification-before-completion for coder; its code-reviewer
// template and the confidence bar of Anthropic's code-review plugin for reviewer; Anthropic's research subagent
// prompt for researcher.
export const DEFAULT_ROLES: readonly Role[] = [
  {
    name: "coder",
    template:
      "写代码、修 bug。\n" +
      "1. 先读仓库的 AGENTS.md、CLAUDE.md、README 和要改的代码，照它的约定来；新开一个分支干活。\n" +
      "2. 修 bug 先找根因：读完报错，复现出来，顺着数据往上追到源头，在源头改，不在症状上打补丁。" +
      "先写一个能复现它的测试，跑一下看它确实失败，再改到它通过。同一个问题试了 3 次还没好，就停下，把试过什么、为什么不行交回来。\n" +
      "3. 只改这件事要改的：不顺手重构，不加没人要的配置和抽象；不跳过、不删测试来求通过。\n" +
      "4. 说「好了」之前，仓库里有的检查（类型检查、测试、lint、构建）都亲自从头跑一遍，看完输出、数清失败；" +
      "仓库没有的那项记一句「没有，跳过」，不因此不交付。没跑过的不说「应该能过」。\n" +
      "5. 跑了的都过了就开 PR，写清改了什么、为什么、怎么验证的。绝不合并、不推默认分支、不部署。\n" +
      "交回来写：改了什么、根因（修 bug 时）、跑过的命令和结果、PR 链接、没做完或没把握的。",
    model: ""
  },
  {
    name: "reviewer",
    template:
      "只读审查：不改代码、不推送、不动当前分支（要看别的版本另开一个目录）。\n" +
      "1. 先弄清这次要做成什么：PR 描述、关联的 issue、仓库的 AGENTS.md 和 CLAUDE.md。再一行行读改动，需要时读它牵到的调用方；没读过的代码不评论。\n" +
      "2. 能跑测试和类型检查就跑，写出命令和结果。\n" +
      "3. 找真问题：会出错的逻辑、漏掉的边界和错误处理、安全、丢数据、和需求或仓库约定不符、要紧的地方没测到。" +
      "每条先问自己有几成把握，不到八成的不报；这次没改到的老问题、类型检查和 lint 会抓的、纯个人口味都不报。\n" +
      "4. 按「必须改 / 建议改 / 小毛病」分级，别把小毛病说成必须改。每条写：文件和行号、哪里不对、为什么要紧（什么情况下会出什么错）、怎么改。做得好的也点一两句。\n" +
      "最后一句话下结论：能合、改完能合、还是不能合，带一句理由。",
    model: ""
  },
  {
    name: "researcher",
    template:
      "调研、写文档。\n" +
      "1. 先列出要回答的几个问题和查的计划。简单的查几次就够，难的多查；结果开始重复就停。\n" +
      "2. 优先一手来源：官方文档、原始数据和论文、代码仓库、发布说明。转载、聚合站、营销稿、匿名消息、对未来的预测要打折扣，用到时说明。搜索摘要不算数，点进原文读。\n" +
      "3. 来源说法不一时都写出来，说哪个更可信、为什么；留意日期，过时的标出来。\n" +
      "4. 每条结论附出处链接；没把握的标「不确定」，没查到就说没查到，不拿猜的补。\n" +
      "交回来写：先一段结论，再分条要点（各带出处），最后是还没查清的和下一步能查什么。",
    model: ""
  }
];

// Templates an earlier version came with. A role that still has one, as it came, gets the new one; one they changed
// stays theirs.
const EARLIER_TEMPLATES: Record<string, readonly string[]> = {
  coder: ["改代码。先新开一个分支，改完跑 typecheck 和测试，都过了再开 PR。绝不合并、不推默认分支、不部署。交回来写：改了什么、测试结果、PR 链接。"],
  reviewer: [
    "只读审查：不改代码、不推送。能跑测试就跑。问题按「必须改 / 建议改 / 小毛病」分三级，每条写出文件和位置。最后一句话下结论：能不能合。"
  ],
  researcher: ["调研、写文档。每条结论附出处链接，没把握的标「不确定」。交回来写：结论、出处、还没查清的。"]
};

export type Role = { name: string; template: string; model: string };

export class RoleStore {
  constructor(private readonly sql: Sql) {
    // The three that come with it are put in once, when the table is made; after that the list is theirs.
    const [made] = sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'res_task_roles'`;
    if (made) {
      for (const role of DEFAULT_ROLES) {
        for (const old of EARLIER_TEMPLATES[role.name] ?? []) sql`UPDATE res_task_roles SET template = ${role.template} WHERE name = ${role.name} AND template = ${old}`;
      }
      return;
    }
    sql`CREATE TABLE res_task_roles (name TEXT PRIMARY KEY, template TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL)`;
    DEFAULT_ROLES.forEach((role, i) => sql`INSERT INTO res_task_roles (name, template, model, at) VALUES (${role.name}, ${role.template}, ${role.model}, ${i})`);
  }

  list(): Role[] {
    return this.sql<Role>`SELECT name, template, model FROM res_task_roles ORDER BY at, name`;
  }

  get(name: string): Role | null {
    const [row] = this.sql<Role>`SELECT name, template, model FROM res_task_roles WHERE name = ${name}`;
    return row ?? null;
  }

  /** Adds a role or changes one; why not, when it cannot be saved. */
  save(input: { name?: unknown; template?: unknown; model?: unknown }): Role | { error: string } {
    const name = String(input.name ?? "").trim().toLowerCase();
    const template = String(input.template ?? "").trim();
    const model = String(input.model ?? "").trim();
    if (!ROLE_NAME.test(name)) return { error: "名字用小写英文字母开头，只用小写字母、数字和 -，最多 24 个" };
    if (!template) return { error: "写一下这个角色怎么干活" };
    if (template.length > TEMPLATE_MAX) return { error: `最多 ${TEMPLATE_MAX} 个字` };
    if (model.length > MODEL_MAX || /\s/.test(model)) return { error: "模型写成一个 id，比如 anthropic/claude-haiku-5.5" };
    if (!this.get(name) && this.list().length >= ROLES_MAX) return { error: `最多 ${ROLES_MAX} 个角色` };
    this.sql`INSERT INTO res_task_roles (name, template, model, at) VALUES (${name}, ${template}, ${model}, ${Date.now()})
      ON CONFLICT (name) DO UPDATE SET template = excluded.template, model = excluded.model`;
    return { name, template, model };
  }

  remove(name: string): void {
    this.sql`DELETE FROM res_task_roles WHERE name = ${name}`;
  }
}

/** The job a role's thread gets: the role's template, then the resident's own words. */
export function withRole(role: Role, job: string): string {
  return `${role.template}\n\n${job}`;
}

/** Why cloud_task's role cannot be used: the roles there are. */
export function unknownRole(name: string, roles: readonly Role[]): string {
  const names = roles.map((role) => role.name).join(", ");
  return `Not sent: there is no role ${name}. ${names ? `Their roles: ${names}.` : "They have no roles."} Leave role out to write the whole job yourself.`;
}
