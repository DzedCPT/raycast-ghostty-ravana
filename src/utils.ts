import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const STATE_DIR = "/tmp/claude-instances";

export interface ClaudeInstance {
  session_id: string;
  status?: string;
  cwd?: string;
  model?: string;
  lines_added?: number;
  lines_removed?: number;
  context_percent?: number;
  pid?: number;
  permission_mode?: string;
  prompt?: string;
  custom_name?: string;
  terminal?: string;
  updated_at?: string;
}

export interface RecentActivity {
  recentTools: string[];
  lastResponse: string;
}

export function projectName(cwd?: string): string {
  if (!cwd) return "unknown";
  return cwd.split("/").pop() || cwd;
}

export function timeAgo(dateStr?: string): string {
  if (!dateStr) return "";
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function isProcessAlive(pid?: number): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function modeLabel(mode?: string): string {
  switch (mode) {
    case "acceptEdits":
      return "Accept Edits";
    case "plan":
      return "Plan";
    case "dontAsk":
      return "Don't Ask";
    case "bypassPermissions":
      return "Bypass Permissions";
    default:
      return mode ?? "Unknown";
  }
}

export function jsonlPath(cwd?: string, sessionId?: string): string | null {
  if (!cwd || !sessionId) return null;
  const projectDir = cwd.replace(/\//g, "-");
  const path = join(homedir(), ".claude", "projects", projectDir, `${sessionId}.jsonl`);
  return existsSync(path) ? path : null;
}

export function loadRecentActivity(cwd?: string, sessionId?: string): RecentActivity | null {
  const path = jsonlPath(cwd, sessionId);
  if (!path) return null;

  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const tail = lines.slice(-40);

    const recentTools: string[] = [];
    let lastResponse = "";

    for (const line of tail) {
      try {
        const obj = JSON.parse(line);
        const msg = obj.message;
        if (!msg) continue;

        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_use") {
              const name = block.name as string;
              const input = block.input as Record<string, unknown>;
              let detail = name;
              if (name === "Edit" || name === "Read" || name === "Write") {
                const fp = input.file_path as string | undefined;
                if (fp) detail = `${name}: ${fp.split("/").pop()}`;
              } else if (name === "Bash") {
                const cmd = input.command as string | undefined;
                if (cmd) detail = `Bash: ${cmd.slice(0, 40)}`;
              }
              recentTools.push(detail);
            } else if (block.type === "text" && block.text) {
              lastResponse = (block.text as string).slice(0, 200);
            }
          }
        }
      } catch {
        /* skip malformed lines */
      }
    }

    return {
      recentTools: recentTools.slice(-5),
      lastResponse,
    };
  } catch {
    return null;
  }
}

export function focusGhosttyTerminal(cwd: string) {
  const script = `
tell application "Ghostty"
  set matches to every terminal whose working directory is "${cwd}"
  if (count of matches) > 0 then
    focus (item 1 of matches)
  end if
end tell`;
  execSync(`osascript -e '${script}'`);
}

export function loadInstances(): ClaudeInstance[] {
  try {
    const files = readdirSync(STATE_DIR).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".metrics.json"),
    );
    const instances = files
      .map((file) => {
        try {
          const content = readFileSync(join(STATE_DIR, file), "utf-8");
          if (!content.trim()) return null;
          const hook = JSON.parse(content) as ClaudeInstance;

          const metricsFile = file.replace(".json", ".metrics.json");
          try {
            const metricsContent = readFileSync(join(STATE_DIR, metricsFile), "utf-8");
            if (metricsContent.trim()) {
              const metrics = JSON.parse(metricsContent) as Partial<ClaudeInstance>;
              // Hook-owned fields win
              const merged = { ...hook, ...metrics };
              merged.status = hook.status;
              merged.permission_mode = hook.permission_mode;
              merged.prompt = hook.prompt;
              merged.custom_name = hook.custom_name;
              Object.assign(hook, merged);
            }
          } catch {
            /* no metrics yet */
          }

          if (!isProcessAlive(hook.pid)) {
            try {
              unlinkSync(join(STATE_DIR, file));
              unlinkSync(join(STATE_DIR, metricsFile));
            } catch {
              /* ignore */
            }
            return null;
          }
          return hook;
        } catch {
          return null;
        }
      })
      .filter((instance): instance is ClaudeInstance => instance !== null)
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));

    // Deduplicate by PID
    const seenPids = new Set<number>();
    return instances.filter((i) => {
      if (!i.pid) return true;
      if (seenPids.has(i.pid)) return false;
      seenPids.add(i.pid);
      return true;
    });
  } catch {
    return [];
  }
}
