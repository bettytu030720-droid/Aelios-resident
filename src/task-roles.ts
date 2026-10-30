// Roles for cloud_task (cloud-tasks.ts): ready-made job templates, so the resident does not write the same
// instructions out every time. Three come with it (coder, reviewer, researcher); on the settings page they can be
// changed, removed and added to, each with the model its threads use. A role is how to do a kind of work, not a
// person: no name, no persona.
import type { Sql } from "./sticker-store";

export const ROLE_NAME = /^[a-z][a-z0-9-]{0,23}$/;
const TEMPLATE_MAX = 1500;
const MODEL_MAX = 120;
export const ROLES_MAX = 12;

export const DEFAULT_ROLES: readonly Role[] = [
  {
    name: "coder",
    template:
      "改代码。先新开一个分支，改完跑 typecheck 和测试，都过了再开 PR。绝不合并、不推默认分支、不部署。" +
      "交回来写：改了什么、测试结果、PR 链接。",
    model: ""
  },
  {
    name: "reviewer",
    template:
      "只读审查：不改代码、不推送。能跑测试就跑。问题按「必须改 / 建议改 / 小毛病」分三级，每条写出文件和位置。" +
      "最后一句话下结论：能不能合。",
    model: ""
  },
  {
    name: "researcher",
    template: "调研、写文档。每条结论附出处链接，没把握的标「不确定」。交回来写：结论、出处、还没查清的。",
    model: ""
  }
];

export type Role = { name: string; template: string; model: string };

export class RoleStore {
  constructor(private readonly sql: Sql) {
    // The three that come with it are put in once, when the table is made; after that the list is theirs.
    const [made] = sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'res_task_roles'`;
    if (made) return;
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
