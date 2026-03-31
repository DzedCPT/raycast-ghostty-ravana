import {
  ActionPanel,
  Action,
  List,
  Color,
  Icon,
  closeMainWindow,
} from "@raycast/api";
import { execSync } from "child_process";
import { readdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";

const STATE_DIR = "/tmp/claude-instances";

interface ClaudeInstance {
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

function statusIcon(status?: string): { source: Icon; tintColor: Color } {
  switch (status) {
    case "working":
      return { source: Icon.CircleFilled, tintColor: Color.Green };
    case "permission":
      return { source: Icon.CircleFilled, tintColor: Color.Orange };
    case "stopped":
      return { source: Icon.CircleFilled, tintColor: Color.SecondaryText };
    default:
      return { source: Icon.QuestionMarkCircle, tintColor: Color.SecondaryText };
  }
}

function modeIcon(mode?: string): { source: Icon; tintColor: Color } {
  switch (mode) {
    case "acceptEdits":
      return { source: Icon.CircleFilled, tintColor: Color.Purple };
    case "plan":
      return { source: Icon.CircleFilled, tintColor: { light: "#0d9488", dark: "#2dd4bf" } };
    case "dontAsk":
    case "bypassPermissions":
      return { source: Icon.CircleFilled, tintColor: Color.Red };
    default:
      return { source: Icon.CircleFilled, tintColor: Color.SecondaryText };
  }
}

function projectName(cwd?: string): string {
  if (!cwd) return "unknown";
  return cwd.split("/").pop() || cwd;
}

function timeAgo(dateStr?: string): string {
  if (!dateStr) return "";
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function isProcessAlive(pid?: number): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function focusGhosttyTerminal(cwd: string) {
  const script = `
tell application "Ghostty"
  set matches to every terminal whose working directory is "${cwd}"
  if (count of matches) > 0 then
    focus (item 1 of matches)
  end if
end tell`;
  execSync(`osascript -e '${script}'`);
}

function loadInstances(): ClaudeInstance[] {
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

export default function Command() {
  const instances = loadInstances();

  return (
    <List>
      {instances.length === 0 ? (
        <List.EmptyView
          title="No Claude instances running"
          description="Start a Claude Code session to see it here"
        />
      ) : (
        instances.map((instance) => {
          const added = instance.lines_added ?? 0;
          const removed = instance.lines_removed ?? 0;
          const hasLines = added > 0 || removed > 0;
          const contextPct = instance.context_percent ?? 0;

          return (
            <List.Item
              key={instance.session_id}
              title={instance.custom_name || instance.prompt || projectName(instance.cwd)}
              subtitle={instance.cwd?.split("/").slice(-2).join("/")}
              icon={statusIcon(instance.status)}
              accessories={[
                ...(instance.model ? [{ tag: instance.model }] : []),
                {
                  text: {
                    value: `+${added}`,
                    color: hasLines ? Color.Green : Color.SecondaryText,
                  },
                },
                {
                  text: {
                    value: `-${removed}`,
                    color: hasLines ? Color.Red : Color.SecondaryText,
                  },
                },
                { text: `${contextPct}%`, tooltip: "Context usage" },
                { icon: modeIcon(instance.permission_mode) },
                { text: timeAgo(instance.updated_at), tooltip: instance.updated_at },
              ]}
              actions={
                <ActionPanel>
                  <Action
                    title="Focus in Ghostty"
                    icon={Icon.Terminal}
                    onAction={() => {
                      closeMainWindow();
                      if (instance.cwd) {
                        focusGhosttyTerminal(instance.cwd);
                      }
                    }}
                  />
                  <Action
                    title="Open in Zed"
                    icon={Icon.Code}
                    onAction={() => {
                      closeMainWindow();
                      execSync(`zed -r "${instance.cwd}"`);
                    }}
                  />
                  <Action.CopyToClipboard title="Copy Working Directory" content={instance.cwd ?? ""} />
                  <Action.CopyToClipboard title="Copy Session ID" content={instance.session_id} />
                </ActionPanel>
              }
            />
          );
        })
      )}
    </List>
  );
}
