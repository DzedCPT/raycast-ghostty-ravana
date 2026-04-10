import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as child_process from "child_process";
import {
  getMainWorktreePath,
  loadStatus,
  removeWorktree,
  STATUS_FILE,
  statusLabel,
  statusOrder,
  type Worktree,
} from "./worktree-utils";

vi.mock("fs");
vi.mock("child_process");

// ---------------------------------------------------------------------------
// statusLabel
// ---------------------------------------------------------------------------

describe("statusLabel", () => {
  it.each([
    ["open",             "Open"],
    ["draft",            "Draft"],
    ["merged",           "Merged"],
    ["closed",           "Closed"],
    ["remote_no_pr",     "No PR"],
    ["no_remote_branch", "Not Pushed"],
    ["no_remote",        "No Remote"],
    ["detached_head",    "Detached HEAD"],
  ])("maps %s → %s", (status, label) => {
    expect(statusLabel(status)).toBe(label);
  });

  it("returns the raw value for unknown statuses", () => {
    expect(statusLabel("some_future_status")).toBe("some_future_status");
  });
});

// ---------------------------------------------------------------------------
// statusOrder
// ---------------------------------------------------------------------------

describe("statusOrder", () => {
  it.each([
    ["merged",           0],
    ["open",             1],
    ["draft",            2],
    ["remote_no_pr",     3],
    ["no_remote",        4],
    ["no_remote_branch", 5],
  ])("assigns order %i to %s", (status, order) => {
    expect(statusOrder(status)).toBe(order);
  });

  it("returns 6 for unknown statuses", () => {
    expect(statusOrder("detached_head")).toBe(6);
    expect(statusOrder("anything_else")).toBe(6);
  });

  it("sorts worktrees correctly by status", () => {
    const statuses = ["no_remote", "open", "merged", "draft", "remote_no_pr", "no_remote_branch"];
    const sorted = [...statuses].sort((a, b) => statusOrder(a) - statusOrder(b));
    expect(sorted).toEqual(["merged", "open", "draft", "remote_no_pr", "no_remote", "no_remote_branch"]);
  });
});

// ---------------------------------------------------------------------------
// loadStatus
// ---------------------------------------------------------------------------

describe("loadStatus", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns null when the status file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadStatus()).toBeNull();
  });

  it("returns null when the file contains malformed JSON", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json {{");
    expect(loadStatus()).toBeNull();
  });

  it("returns the parsed success shape", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const payload = {
      updated_at: "2026-04-10T14:00:00Z",
      worktrees: [
        {
          root: "my-repo",
          worktree: "feature-branch",
          path: "/Users/jboyle/Developer/worktrees/my-repo/feature-branch",
          branch: "feature-branch",
          repo: "org/my-repo",
          status: "open",
          pr_number: 42,
        },
      ],
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(payload));
    const result = loadStatus();
    expect(result?.updated_at).toBe("2026-04-10T14:00:00Z");
    expect(result?.worktrees).toHaveLength(1);
    expect(result?.worktrees?.[0].pr_number).toBe(42);
  });

  it("returns the error shape with worktrees null", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const payload = { updated_at: "2026-04-10T14:00:00Z", error: true, exit_code: 1, worktrees: null };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(payload));
    const result = loadStatus();
    expect(result?.error).toBe(true);
    expect(result?.exit_code).toBe(1);
    expect(result?.worktrees).toBeNull();
  });

  it("reads from the correct file path", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    loadStatus();
    expect(fs.existsSync).toHaveBeenCalledWith(STATUS_FILE);
  });
});

// ---------------------------------------------------------------------------
// getMainWorktreePath
// ---------------------------------------------------------------------------

describe("getMainWorktreePath", () => {
  afterEach(() => vi.restoreAllMocks());

  it("extracts the path from the first line of porcelain output", () => {
    vi.mocked(child_process.execSync).mockReturnValue(
      "worktree /Users/jboyle/Developer/worktrees/frontends/.bare\nbare\n\nworktree /other\nHEAD abc\n" as unknown as Buffer,
    );
    expect(getMainWorktreePath("/some/worktree")).toBe(
      "/Users/jboyle/Developer/worktrees/frontends/.bare",
    );
  });

  it("runs git with -C set to the given worktree path", () => {
    vi.mocked(child_process.execSync).mockReturnValue(
      "worktree /main\nbare\n" as unknown as Buffer,
    );
    getMainWorktreePath("/my/worktree");
    expect(child_process.execSync).toHaveBeenCalledWith(
      expect.stringContaining('-C "/my/worktree"'),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe("removeWorktree", () => {
  const BASE_WT: Worktree = {
    root: "my-repo",
    worktree: "feature",
    path: "/worktrees/my-repo/feature",
    branch: "feature-branch",
    repo: "org/my-repo",
    status: "merged",
    pr_number: null,
  };

  beforeEach(() => {
    // First execSync call is always `git worktree list --porcelain`
    vi.mocked(child_process.execSync)
      .mockReset()
      .mockReturnValueOnce("worktree /worktrees/my-repo/.bare\nbare\n" as unknown as Buffer)
      .mockReturnValue(Buffer.from(""));
  });

  afterEach(() => vi.restoreAllMocks());

  it("removes the worktree using the main worktree path", () => {
    removeWorktree(BASE_WT);
    const calls = vi.mocked(child_process.execSync).mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("worktree remove --force") && c.includes("/worktrees/my-repo/feature"))).toBe(true);
  });

  it("deletes the branch when branch is non-empty", () => {
    removeWorktree(BASE_WT);
    const calls = vi.mocked(child_process.execSync).mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("branch -D") && c.includes("feature-branch"))).toBe(true);
  });

  it("does not delete a branch when branch is empty", () => {
    removeWorktree({ ...BASE_WT, branch: "" });
    const calls = vi.mocked(child_process.execSync).mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("branch -D"))).toBe(false);
  });

  it("uses the bare repo path for all git commands", () => {
    removeWorktree(BASE_WT);
    const calls = vi.mocked(child_process.execSync).mock.calls
      .slice(1) // skip the worktree list call
      .map((c) => c[0] as string);
    expect(calls.every((c) => c.includes('-C "/worktrees/my-repo/.bare"'))).toBe(true);
  });
});
