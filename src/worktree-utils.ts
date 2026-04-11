import { existsSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

export interface CICheck {
  name: string;
  state: string;
  bucket: string;
  link: string;
  workflow: string;
}

export interface Worktree {
  root: string;
  worktree: string;
  path: string;
  branch: string;
  repo: string;
  status: string;
  pr_number: number | null;
  updated_at: string;
  ci_summary?: string;
  ci_checks?: CICheck[] | null;
}

export interface StatusFile {
  updated_at: string;
  worktrees: Worktree[] | null;
}

export const WORKTREES_DIR = "/tmp/gh-worktree-status/worktrees";
export const SCRIPT_LINK = "/tmp/gh-worktree-status/script.sh";

export function statusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Open";
    case "draft":
      return "Draft";
    case "merged":
      return "Merged";
    case "closed":
      return "Closed";
    case "remote_no_pr":
      return "No PR";
    case "no_remote_branch":
      return "Not Pushed";
    case "no_remote":
      return "No Remote";
    case "detached_head":
      return "Detached HEAD";
    default:
      return status;
  }
}

export function statusOrder(status: string): number {
  switch (status) {
    case "merged":
      return 0;
    case "open":
      return 1;
    case "draft":
      return 2;
    case "remote_no_pr":
      return 3;
    case "no_remote":
      return 4;
    case "no_remote_branch":
      return 5;
    default:
      return 6;
  }
}

export function statusFileName(
  wt: Pick<Worktree, "root" | "worktree">,
): string {
  return `${wt.root}__${wt.worktree}.json`;
}

export function ciSummaryLabel(ci?: string): string {
  switch (ci) {
    case "pass":
      return "CI Passing";
    case "fail":
      return "CI Failing";
    case "pending":
      return "CI Pending";
    default:
      return "";
  }
}

export function failingChecks(wt: Worktree): CICheck[] {
  if (!wt.ci_checks) return [];
  return wt.ci_checks.filter(
    (c) => c.bucket === "fail" || c.bucket === "cancel",
  );
}

export function loadStatus(): StatusFile | null {
  if (!existsSync(WORKTREES_DIR)) return null;
  try {
    const files = readdirSync(WORKTREES_DIR).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return null;

    let latestTimestamp = "";
    const worktrees: Worktree[] = [];

    for (const file of files) {
      try {
        const wt = JSON.parse(
          readFileSync(join(WORKTREES_DIR, file), "utf-8"),
        ) as Worktree;
        // Option A: skip worktrees whose path no longer exists on disk
        if (!existsSync(wt.path)) continue;
        worktrees.push(wt);
        if (wt.updated_at > latestTimestamp) latestTimestamp = wt.updated_at;
      } catch {
        // skip malformed files
      }
    }

    if (worktrees.length === 0) return null;
    return { updated_at: latestTimestamp, worktrees };
  } catch {
    return null;
  }
}

export function refreshWorktree(worktreePath: string): void {
  execSync(`bash "${SCRIPT_LINK}" "${worktreePath}"`, {
    timeout: 45000,
    stdio: "pipe",
  });
}

export function getMainWorktreePath(worktreePath: string): string {
  const output = execSync(
    `git -C "${worktreePath}" worktree list --porcelain`,
    { encoding: "utf-8" },
  );
  return output
    .split("\n")[0]
    .replace(/^worktree /, "")
    .trim();
}

export function removeWorktree(wt: Worktree): void {
  const mainPath = getMainWorktreePath(wt.path);
  execSync(`git -C "${mainPath}" worktree remove --force "${wt.path}"`);
  if (wt.branch) {
    execSync(`git -C "${mainPath}" branch -D "${wt.branch}"`);
  }
  const statusFile = join(WORKTREES_DIR, statusFileName(wt));
  if (existsSync(statusFile)) {
    unlinkSync(statusFile);
  }
}
