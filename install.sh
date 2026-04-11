#!/bin/bash
# Install Agent Ghostty hooks into Claude Code configuration.
# Symlinks the hook scripts into ~/.claude/ and patches ~/.claude/settings.json.
# Idempotent — safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
SETTINGS="$CLAUDE_DIR/settings.json"

mkdir -p "$HOOKS_DIR"

link_file() {
    local src="$1" dst="$2"
    if [[ -L "$dst" ]]; then
        local current
        current=$(readlink "$dst")
        if [[ "$current" == "$src" ]]; then
            echo "  ✓ $dst (already linked)"
            return
        fi
        echo "  → $dst (updating symlink)"
        ln -sf "$src" "$dst"
    elif [[ -e "$dst" ]]; then
        echo "  ⚠ $dst exists and is not a symlink — backing up to ${dst}.bak"
        mv "$dst" "${dst}.bak"
        ln -s "$src" "$dst"
    else
        echo "  → $dst"
        ln -s "$src" "$dst"
    fi
}

echo "Linking hooks..."
link_file "$SCRIPT_DIR/hooks/statusline.sh" "$CLAUDE_DIR/statusline.sh"
link_file "$SCRIPT_DIR/hooks/raycast-status.sh" "$HOOKS_DIR/raycast-status.sh"

chmod +x "$SCRIPT_DIR/hooks/statusline.sh" "$SCRIPT_DIR/hooks/raycast-status.sh"

echo "Patching settings.json..."

HOOK_CMD="~/.claude/hooks/raycast-status.sh"
STATUSLINE_CMD="~/.claude/statusline.sh"
HOOK_ENTRY='{"type": "command", "command": "'"$HOOK_CMD"'"}'
HOOK_EVENTS=(PreToolUse PostToolUse SessionStart UserPromptSubmit Stop SubagentStop Notification SessionEnd)

if [[ ! -f "$SETTINGS" ]]; then
    echo "Creating $SETTINGS..."
    echo '{}' > "$SETTINGS"
fi

JQ_EXPR='.'
for event in "${HOOK_EVENTS[@]}"; do
    JQ_EXPR="$JQ_EXPR"'
    | .hooks.'"$event"' as $arr
    | if ($arr // [] | map(.hooks // [] | map(.command) | flatten) | flatten | any(. == "'"$HOOK_CMD"'"))
      then .
      else .hooks.'"$event"' = (($arr // []) + [{"hooks": ['"$HOOK_ENTRY"']}])
      end'
done

JQ_EXPR="$JQ_EXPR"'
    | if .statusLine.command == "'"$STATUSLINE_CMD"'"
      then .
      else .statusLine = {"type": "command", "command": "'"$STATUSLINE_CMD"'", "padding": 0}
      end'

jq "$JQ_EXPR" "$SETTINGS" > "${SETTINGS}.tmp" && mv "${SETTINGS}.tmp" "$SETTINGS"

echo "Setting up launchd jobs..."
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
WORKTREE_SCRIPT="$SCRIPT_DIR/scripts/gh-worktree-status.sh"
chmod +x "$WORKTREE_SCRIPT"

mkdir -p "$LAUNCH_AGENTS_DIR"
mkdir -p /tmp/gh-worktree-status/worktrees

# Symlink the script to a well-known path so the Raycast extension can find it
# regardless of where the repo is checked out
ln -sf "$WORKTREE_SCRIPT" /tmp/gh-worktree-status/script.sh

# Migrate: remove the old monolithic status file if it exists
rm -f /tmp/gh-worktree-status/status.json

LABEL="com.jboyle.worktree-status"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$WORKTREE_SCRIPT</string>
    </array>
    <key>StartInterval</key>
    <integer>600</integer>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
EOF

# Reload if already running, otherwise just load
if launchctl list | grep -q "$LABEL"; then
    launchctl unload "$PLIST"
fi
launchctl load "$PLIST"
echo "  ✓ Loaded $LABEL"

echo "Done! Restart Claude Code sessions for changes to take effect."
