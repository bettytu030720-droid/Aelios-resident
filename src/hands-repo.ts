// The resident's hands on GitHub Actions (cloud-tasks.ts, "linux"): with one GitHub token on the settings page, the
// resident makes a private repository of theirs, puts its workflow in it, and starts a run for each job. Nothing
// else is set up by hand: a run fetches public/hands.mjs from the resident, asks the resident for the GitHub token
// (to clone, push and open pull requests elsewhere), and calls the model through the resident (index.ts, /tasks/*),
// so no key is stored on GitHub.

export const HANDS_REPO = "resident-hands";
export const HANDS_WORKFLOW = "resident-hands.yml";
const WORKFLOW_PATH = `.github/workflows/${HANDS_WORKFLOW}`;
const GITHUB_API = "https://api.github.com";
// Where the token is made: a classic token with these two scopes does everything the hands need.
export const TOKEN_PAGE = "https://github.com/settings/tokens/new?scopes=repo,workflow&description=Aelios-resident";

/** The workflow the resident keeps in the repository. Its inputs go through env, never into the script text. */
export const WORKFLOW = `name: Resident Hands

# Made by your Aelios-resident, which keeps this file up to date. It runs only when the resident sends a job.
# This repository must stay private: a run's log and files are visible to whoever can see the repository.

on:
  workflow_dispatch:
    inputs:
      job:
        description: "Job sent by the resident"
        required: true
        type: string
      resident:
        description: "The resident's address"
        required: true
        type: string

permissions:
  contents: write
  pull-requests: write

jobs:
  work:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      RESIDENT_URL: \${{ inputs.resident }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          persist-credentials: false

      - name: Setup Node.js 22
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Get the hands from the resident
        run: curl -fsSL --retry 3 "$RESIDENT_URL/hands.mjs" -o "$RUNNER_TEMP/hands.mjs"

      # The job is read from the run's event file, not put in env: values in env are printed in the log.
      - name: Run resident hands
        timeout-minutes: 25
        env:
          HANDS_RETENTION_DAYS: "30"
          HANDS_OUTPUT_DIR: \${{ runner.temp }}/resident-output
          HANDS_REPORTED_FILE: \${{ runner.temp }}/resident-reported
          # Optional: owner/repo with GitHub Pages on its gh-pages branch, for jobs that ask for a public page.
          HANDS_PUBLISH_REPO: \${{ vars.HANDS_PUBLISH_REPO }}
        run: node "$RUNNER_TEMP/hands.mjs"

      - name: Tell the resident the run stopped
        if: failure() || cancelled()
        env:
          HANDS_REPORTED_FILE: \${{ runner.temp }}/resident-reported
        run: node "$RUNNER_TEMP/hands.mjs" --report-stopped

      - name: Keep generated files
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: resident-files-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ runner.temp }}/resident-output/
          if-no-files-found: ignore
          retention-days: 30
          include-hidden-files: false
`;

/** The repository the hands run in, as the resident set it up. */
export type HandsRepo = { owner: string; repo: string; branch: string; url: string };

type Reply = { status: number; body: Record<string, unknown> | null };

async function github(token: string, method: string, path: string, body?: unknown, apiBase?: string): Promise<Reply | { error: string }> {
  const base = apiBase?.trim() ? apiBase.trim().replace(/\/+$/, "") : GITHUB_API;
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "aelios-resident",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
    const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, body: parsed };
  } catch (error) {
    return { error: `连不上 GitHub：${String(error).slice(0, 120)}` };
  }
}

const said = (reply: Reply) => (typeof reply.body?.message === "string" ? `（GitHub 说：${reply.body.message.slice(0, 160)}）` : "");

const utf8Base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

function fromBase64(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

/** A short fingerprint, to know whether the token or the workflow changed since the repository was set up. */
export async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Makes sure the private repository exists and holds the current workflow: creates it when it is missing, and
 * refuses a public one. Safe to run again: it writes only what changed.
 */
export async function setUpHands(token: string, apiBase?: string): Promise<HandsRepo | { error: string }> {
  const user = await github(token, "GET", "/user", undefined, apiBase);
  if ("error" in user) return user;
  if (user.status === 401) return { error: "GitHub 不认这个 token：可能填错了，或者过期了。重新生成一个再填。" };
  const owner = typeof user.body?.login === "string" ? user.body.login : "";
  if (user.status !== 200 || !owner) return { error: `GitHub 没回答这个 token 是谁的（HTTP ${user.status}）${said(user)}` };

  let repo = await github(token, "GET", `/repos/${owner}/${HANDS_REPO}`, undefined, apiBase);
  if ("error" in repo) return repo;
  if (repo.status === 404) {
    repo = await github(token, "POST", "/user/repos", {
      name: HANDS_REPO,
      private: true,
      auto_init: true,
      description: "Aelios-resident runs jobs here on GitHub Actions. Keep it private."
    }, apiBase);
    if ("error" in repo) return repo;
    if (repo.status === 422) return { error: `你已经有个叫 ${HANDS_REPO} 的仓库，但这个 token 看不到它：给 token 加上它的权限，或者把它改名。` };
    if (repo.status !== 201) return { error: "这个 token 建不了仓库：生成时要勾上 repo 和 workflow。" };
  } else if (repo.status !== 200) {
    return { error: `GitHub 没让看 ${owner}/${HANDS_REPO}（HTTP ${repo.status}）${said(repo)}` };
  }
  if (repo.body?.private !== true) return { error: `${owner}/${HANDS_REPO} 是公开的，运行日志谁都看得见。把它改成私有，或者删掉让住户重建。` };
  const branch = typeof repo.body?.default_branch === "string" && repo.body.default_branch ? repo.body.default_branch : "main";
  const url = typeof repo.body?.html_url === "string" && /^https:\/\/github\.com\//.test(repo.body.html_url) ? repo.body.html_url : `https://github.com/${owner}/${HANDS_REPO}`;

  const path = `/repos/${owner}/${HANDS_REPO}/contents/${WORKFLOW_PATH}`;
  const current = await github(token, "GET", `${path}?ref=${encodeURIComponent(branch)}`, undefined, apiBase);
  if ("error" in current) return current;
  if (current.status === 200 && fromBase64(current.body?.content) === WORKFLOW) return { owner, repo: HANDS_REPO, branch, url };
  const sha = current.status === 200 && typeof current.body?.sha === "string" ? current.body.sha : undefined;
  const written = await github(token, "PUT", path, {
    message: sha ? "Update the resident's workflow" : "Add the resident's workflow",
    content: utf8Base64(WORKFLOW),
    branch,
    ...(sha ? { sha } : {})
  }, apiBase);
  if ("error" in written) return written;
  if (written.status === 403 || written.status === 404) return { error: "这个 token 写不了工作流文件：生成时要勾上 workflow。" };
  if (written.status !== 200 && written.status !== 201) return { error: `工作流文件没写进去（HTTP ${written.status}）${said(written)}` };
  return { owner, repo: HANDS_REPO, branch, url };
}

/**
 * Starts a run for one job. `missing`: GitHub does not know the repository or the workflow (deleted, or written a
 * moment ago and not picked up yet), so setting up again and retrying may help.
 */
export async function dispatchHands(
  hands: HandsRepo,
  token: string,
  job: string,
  resident: string,
  apiBase?: string
): Promise<{ sessionId: string; sessionUrl: string } | { error: string; missing?: boolean }> {
  const fired = await github(token, "POST", `/repos/${hands.owner}/${hands.repo}/actions/workflows/${HANDS_WORKFLOW}/dispatches`, {
    ref: hands.branch,
    inputs: { job, resident },
    // The reply names this run, so the card links to it rather than to every run.
    return_run_details: true
  }, apiBase);
  if ("error" in fired) return fired;
  if (fired.status === 401) return { error: "GitHub 不认这个 token 了：去设置页重填。" };
  if (fired.status === 403) return { error: "这个 token 开不了 Actions：生成时要勾上 repo 和 workflow。" };
  if (fired.status === 404 || fired.status === 422) return { error: `GitHub 还没认出 ${hands.owner}/${hands.repo} 里的工作流${said(fired)}`, missing: true };
  if (fired.status === 429) return { error: "这一个小时派得太多了，过一会儿再派" };
  if (fired.status !== 200 && fired.status !== 204) return { error: `GitHub 没接（HTTP ${fired.status}）${said(fired)}` };
  const runUrl = typeof fired.body?.html_url === "string" && /^https:\/\/github\.com\//.test(fired.body.html_url) ? fired.body.html_url : "";
  return {
    sessionId: fired.body?.workflow_run_id !== undefined ? String(fired.body.workflow_run_id) : `gh_${hands.owner}_${hands.repo}`,
    sessionUrl: runUrl || `${hands.url}/actions/workflows/${HANDS_WORKFLOW}`
  };
}
