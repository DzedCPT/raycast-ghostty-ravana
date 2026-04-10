#!/bin/bash
# Claude Code hook script for the Raycast "Agent Ghostty" extension.
#
# Each Claude Code session has a JSON state file in /tmp/claude-instances/<session_id>.json.
# This hook updates the "status" and "permission_mode" fields in response to hook events.
# The statusline script (~/.claude/statusline.sh) writes the rest of the data
# (cwd, model, context usage, lines changed, pid).
#
# This hook also handles session naming:
#   - prompt: updated on every prompt to the latest user prompt (truncated to 50 chars)
#   - custom_name: set when the user types "name: <value>" as a prompt. This blocks the
#     prompt from reaching Claude and just renames the session. custom_name takes priority
#     over prompt in the Raycast UI.

set -e

STATE_DIR="/tmp/claude-instances"
mkdir -p "$STATE_DIR"

INPUT=$(cat)

if ! command -v jq &> /dev/null; then
    exit 0
fi

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
NOTIFICATION_TYPE=$(echo "$INPUT" | jq -r '.notification_type // empty')
PERMISSION_MODE=$(echo "$INPUT" | jq -r '.permission_mode // empty')

if [[ -z "$SESSION_ID" ]]; then
    exit 0
fi

STATE_FILE="${STATE_DIR}/${SESSION_ID}.json"

# Merges status (and permission_mode when available) into the existing state file,
# preserving all other fields (prompt, custom_name, cwd, pid, etc.).
# Creates a minimal state file if one doesn't exist yet (SessionStart runs before
# the statusline has written the full state).
#
# IMPORTANT: The statusline script also writes to STATE_FILE concurrently.
# This causes race conditions where jq reads a partially-written file and fails.
# All jq calls that read STATE_FILE must: suppress stderr, and on failure clean up
# the .tmp file so the original (possibly corrupt) file is left for the next write
# to overwrite cleanly. Pattern: jq ... > tmp 2>/dev/null && mv tmp file || rm -f tmp
update_status() {
    local status="$1"
    if [[ -f "$STATE_FILE" && -s "$STATE_FILE" ]]; then
        local jq_expr='.status = $status'
        local jq_args=(--arg status "$status")
        if [[ -n "$PERMISSION_MODE" ]]; then
            jq_expr="$jq_expr | .permission_mode = \$pm"
            jq_args+=(--arg pm "$PERMISSION_MODE")
        fi
        jq "${jq_args[@]}" "$jq_expr" "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null && mv "${STATE_FILE}.tmp" "$STATE_FILE" || rm -f "${STATE_FILE}.tmp"
    else
        # Detect terminal and WezTerm pane from env vars on initial creation
        local term="${TERM_PROGRAM:-}"
        local wez_pane="${WEZTERM_PANE:-}"
        local wez_pane_json="null"
        if [[ -n "$wez_pane" ]]; then wez_pane_json="$wez_pane"; fi
        jq -n --arg session_id "$SESSION_ID" --arg status "$status" --arg pm "${PERMISSION_MODE:-default}" --arg terminal "$term" --argjson wezterm_pane "$wez_pane_json" \
            '{session_id: $session_id, status: $status, permission_mode: $pm, terminal: $terminal, wezterm_pane: $wezterm_pane}' > "$STATE_FILE"
    fi
}

case "$HOOK_EVENT" in
    "SessionStart")
        update_status "stopped"
        # Capture the Ghostty terminal UUID for the pane we're running in.
        # We match by exact cwd at session start, before Claude navigates anywhere.
        if command -v osascript &> /dev/null; then
            GHOSTTY_ID=$(osascript -e "tell application \"Ghostty\" to get id of (first terminal whose working directory is \"$PWD\")" 2>/dev/null || true)
            if [[ -n "$GHOSTTY_ID" && -f "$STATE_FILE" && -s "$STATE_FILE" ]]; then
                jq --arg gid "$GHOSTTY_ID" '.ghostty_terminal_id = $gid' "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null && mv "${STATE_FILE}.tmp" "$STATE_FILE" || rm -f "${STATE_FILE}.tmp"
            fi
        fi
        ;;
    "UserPromptSubmit")
        USER_PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

        # "name: ..." sets a custom session name and blocks the prompt from reaching Claude
        if [[ "$USER_PROMPT" =~ ^[Nn][Aa][Mm][Ee]:[[:space:]]*(.*) ]]; then
            CUSTOM_NAME="${BASH_REMATCH[1]}"
            if [[ -f "$STATE_FILE" && -s "$STATE_FILE" ]]; then
                jq --arg name "$CUSTOM_NAME" '.custom_name = $name' "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null && mv "${STATE_FILE}.tmp" "$STATE_FILE" || rm -f "${STATE_FILE}.tmp"
            fi
            echo "{\"decision\": \"block\", \"reason\": \"Session renamed to: $CUSTOM_NAME\"}"
            exit 0
        fi

        # Otherwise, use the prompt (truncated) as the auto-generated name
        AUTO_NAME=$(echo "$USER_PROMPT" | cut -c1-140)
        update_status "working"
        if [[ -n "$AUTO_NAME" && -f "$STATE_FILE" && -s "$STATE_FILE" ]]; then
            NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
            jq --arg name "$AUTO_NAME" --arg ts "$NOW" '.prompt = $name | .last_prompt_at = $ts' "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null && mv "${STATE_FILE}.tmp" "$STATE_FILE" || rm -f "${STATE_FILE}.tmp"
        fi
        ;;
    "PreToolUse")
        update_status "working"
        ;;
    "PostToolUse")
        # No status change needed
        ;;
    "Stop"|"SubagentStop")
        update_status "stopped"
        ;;
    "Notification")
        if [[ "$NOTIFICATION_TYPE" == "permission_prompt" ]]; then
            update_status "permission"
        fi
        ;;
    "SessionEnd")
        rm -f "$STATE_FILE" "${STATE_DIR}/${SESSION_ID}.metrics.json"
        ;;
esac

# Clean up stale sessions (older than 24 hours)
find "$STATE_DIR" -name "*.json" -o -name "*.metrics.json" -type f -mmin +1440 -delete 2>/dev/null || true

exit 0
