import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import {
  isProcessAlive,
  jsonlPath,
  loadInstances,
  loadRecentActivity,
  modeLabel,
  projectName,
  STATE_DIR,
  timeAgo,
} from "./utils";

vi.mock("fs");
vi.mock("os");

describe("projectName", () => {
  it("returns 'unknown' for undefined", () => {
    expect(projectName(undefined)).toBe("unknown");
  });

  it("returns 'unknown' for empty string", () => {
    expect(projectName("")).toBe("unknown");
  });

  it("returns the last path segment", () => {
    expect(projectName("/foo/bar/baz")).toBe("baz");
  });

  it("returns the path itself when no slashes", () => {
    expect(projectName("myproject")).toBe("myproject");
  });
});

describe("modeLabel", () => {
  it.each([
    ["acceptEdits", "Accept Edits"],
    ["plan", "Plan"],
    ["dontAsk", "Don't Ask"],
    ["bypassPermissions", "Bypass Permissions"],
    [undefined, "Unknown"],
    ["custom", "custom"],
  ])("maps %s → %s", (mode, expected) => {
    expect(modeLabel(mode)).toBe(expected);
  });
});

describe("timeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for undefined", () => {
    expect(timeAgo(undefined)).toBe("");
  });

  it("returns 0s ago for the current time", () => {
    expect(timeAgo("2024-01-01T12:00:00Z")).toBe("0s ago");
  });

  it("returns seconds ago", () => {
    expect(timeAgo("2024-01-01T11:59:30Z")).toBe("30s ago");
  });

  it("returns minutes ago", () => {
    expect(timeAgo("2024-01-01T11:55:00Z")).toBe("5m ago");
  });

  it("returns hours ago", () => {
    expect(timeAgo("2024-01-01T09:00:00Z")).toBe("3h ago");
  });

  it("returns 59s ago at the boundary before minutes", () => {
    expect(timeAgo("2024-01-01T11:59:01Z")).toBe("59s ago");
  });

  it("returns 1m ago at the minute boundary", () => {
    expect(timeAgo("2024-01-01T11:59:00Z")).toBe("1m ago");
  });
});

describe("isProcessAlive", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when pid is undefined", () => {
    expect(isProcessAlive(undefined)).toBe(true);
  });

  it("returns true when process.kill succeeds", () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(isProcessAlive(12345)).toBe(true);
  });

  it("returns false when process.kill throws", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(isProcessAlive(99999)).toBe(false);
  });
});

describe("jsonlPath", () => {
  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue("/Users/test");
  });

  it("returns null when cwd is undefined", () => {
    expect(jsonlPath(undefined, "session1")).toBeNull();
  });

  it("returns null when sessionId is undefined", () => {
    expect(jsonlPath("/foo/bar", undefined)).toBeNull();
  });

  it("returns null when file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(jsonlPath("/foo/bar", "session1")).toBeNull();
  });

  it("returns the constructed path when file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    expect(jsonlPath("/foo/bar", "session1")).toBe(
      "/Users/test/.claude/projects/-foo-bar/session1.jsonl",
    );
  });

  it("converts all slashes in cwd to dashes", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    expect(jsonlPath("/a/b/c", "abc")).toBe(
      "/Users/test/.claude/projects/-a-b-c/abc.jsonl",
    );
  });
});

describe("loadRecentActivity", () => {
  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue("/Users/test");
  });

  it("returns null when jsonlPath returns null (file missing)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadRecentActivity("/foo", "session1")).toBeNull();
  });

  it("returns null when readFileSync throws", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(loadRecentActivity("/foo", "session1")).toBeNull();
  });

  it("parses a generic tool_use entry by name", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Grep", input: {} }],
        },
      }),
    );
    expect(loadRecentActivity("/foo", "session1")?.recentTools).toEqual(["Grep"]);
  });

  it("formats Edit tool with just the filename", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "/path/to/foo.ts" } },
          ],
        },
      }),
    );
    expect(loadRecentActivity("/foo", "session1")?.recentTools).toEqual(["Edit: foo.ts"]);
  });

  it("formats Read tool with just the filename", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/src/index.ts" } },
          ],
        },
      }),
    );
    expect(loadRecentActivity("/foo", "session1")?.recentTools).toEqual(["Read: index.ts"]);
  });

  it("formats Write tool with just the filename", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "/out/result.json" } },
          ],
        },
      }),
    );
    expect(loadRecentActivity("/foo", "session1")?.recentTools).toEqual(["Write: result.json"]);
  });

  it("formats Bash tool with command truncated to 40 chars", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const cmd = "npm run test -- --coverage --reporter verbose extra";
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }],
        },
      }),
    );
    expect(loadRecentActivity("/foo", "session1")?.recentTools).toEqual([
      `Bash: ${cmd.slice(0, 40)}`,
    ]);
  });

  it("keeps only the last 5 tools", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const lines = ["A", "B", "C", "D", "E", "F", "G"].map((name) =>
      JSON.stringify({
        message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] },
      }),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(lines.join("\n"));
    expect(loadRecentActivity("/foo", "session1")?.recentTools).toEqual([
      "C", "D", "E", "F", "G",
    ]);
  });

  it("captures last text block as lastResponse", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
      }),
    );
    expect(loadRecentActivity("/foo", "session1")?.lastResponse).toBe("Hello world");
  });

  it("truncates lastResponse to 200 chars", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(300) }],
        },
      }),
    );
    expect(loadRecentActivity("/foo", "session1")?.lastResponse).toHaveLength(200);
  });

  it("skips malformed JSONL lines without throwing", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        "not valid json {{",
        JSON.stringify({
          message: { role: "assistant", content: [{ type: "tool_use", name: "Grep", input: {} }] },
        }),
      ].join("\n"),
    );
    expect(loadRecentActivity("/foo", "session1")?.recentTools).toEqual(["Grep"]);
  });

  it("ignores non-assistant messages", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "tool_use", name: "Grep", input: {} }],
        },
      }),
    );
    expect(loadRecentActivity("/foo", "session1")?.recentTools).toEqual([]);
  });

  it("returns empty recentTools and lastResponse when no matching content", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ message: { role: "assistant", content: [] } }),
    );
    expect(loadRecentActivity("/foo", "session1")).toEqual({ recentTools: [], lastResponse: "" });
  });
});

describe("loadInstances", () => {
  beforeEach(() => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns [] when STATE_DIR does not exist", () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(loadInstances()).toEqual([]);
  });

  it("returns [] when there are no json files", () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as fs.Dirent[]);
    expect(loadInstances()).toEqual([]);
  });

  it("loads a basic instance", () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["abc.json"] as unknown as fs.Dirent[]);
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (String(path).endsWith("abc.json")) {
        return JSON.stringify({ session_id: "abc", status: "working", pid: 123 });
      }
      throw new Error("ENOENT");
    });
    const result = loadInstances();
    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe("abc");
  });

  it("skips .metrics.json files from the main instance list", () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      "a.json",
      "a.metrics.json",
    ] as unknown as fs.Dirent[]);
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (String(path).endsWith("a.json")) {
        return JSON.stringify({ session_id: "a", pid: 1 });
      }
      throw new Error("ENOENT");
    });
    expect(loadInstances()).toHaveLength(1);
  });

  it("skips empty files", () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["empty.json"] as unknown as fs.Dirent[]);
    vi.mocked(fs.readFileSync).mockReturnValue("   ");
    expect(loadInstances()).toHaveLength(0);
  });

  it("merges metrics data with hook data, hook fields winning", () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["abc.json"] as unknown as fs.Dirent[]);
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith("abc.json")) {
        return JSON.stringify({
          session_id: "abc",
          status: "working",
          permission_mode: "plan",
          pid: 1,
          model: "claude-3",
        });
      }
      if (p.endsWith("abc.metrics.json")) {
        return JSON.stringify({
          status: "stopped",
          permission_mode: "bypassPermissions",
          model: "claude-opus",
          context_percent: 45,
          lines_added: 10,
        });
      }
      throw new Error("ENOENT");
    });
    const [inst] = loadInstances();
    expect(inst.status).toBe("working");          // hook wins
    expect(inst.permission_mode).toBe("plan");    // hook wins
    expect(inst.model).toBe("claude-opus");       // metrics wins (not a hook-owned field)
    expect(inst.context_percent).toBe(45);        // from metrics
    expect(inst.lines_added).toBe(10);            // from metrics
  });

  it("filters out dead processes and attempts to delete their files", () => {
    vi.mocked(process.kill).mockImplementation((pid) => {
      if (pid === 999) throw new Error("ESRCH");
      return true;
    });
    vi.mocked(fs.readdirSync).mockReturnValue(["dead.json"] as unknown as fs.Dirent[]);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ session_id: "dead", pid: 999 }),
    );
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});

    expect(loadInstances()).toHaveLength(0);
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${STATE_DIR}/dead.json`);
  });

  it("deduplicates instances with the same PID, keeping the most recent", () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      "a.json",
      "b.json",
    ] as unknown as fs.Dirent[]);
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith("a.json")) {
        return JSON.stringify({ session_id: "a", pid: 123, updated_at: "2024-01-01T12:00:00Z" });
      }
      if (p.endsWith("b.json")) {
        return JSON.stringify({ session_id: "b", pid: 123, updated_at: "2024-01-01T11:00:00Z" });
      }
      throw new Error("ENOENT");
    });
    const result = loadInstances();
    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe("a"); // newer updated_at survives dedup
  });

  it("sorts instances by updated_at descending", () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      "old.json",
      "new.json",
    ] as unknown as fs.Dirent[]);
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith("old.json")) {
        return JSON.stringify({ session_id: "old", pid: 1, updated_at: "2024-01-01T10:00:00Z" });
      }
      if (p.endsWith("new.json")) {
        return JSON.stringify({ session_id: "new", pid: 2, updated_at: "2024-01-01T12:00:00Z" });
      }
      throw new Error("ENOENT");
    });
    const result = loadInstances();
    expect(result[0].session_id).toBe("new");
    expect(result[1].session_id).toBe("old");
  });

  it("includes instances without a PID (no dedup)", () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      "a.json",
      "b.json",
    ] as unknown as fs.Dirent[]);
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith("a.json")) return JSON.stringify({ session_id: "a" });
      if (p.endsWith("b.json")) return JSON.stringify({ session_id: "b" });
      throw new Error("ENOENT");
    });
    expect(loadInstances()).toHaveLength(2);
  });
});
