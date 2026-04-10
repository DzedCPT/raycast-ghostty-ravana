#!/bin/bash
# Read JSON input from stdin
input=$(cat)

# Extract values using jq
MODEL_DISPLAY=$(echo "$input" | jq -r '.model.display_name')
CURRENT_DIR=$(echo "$input" | jq -r '.workspace.current_dir')
CONTEXT_SIZE=$(echo "$input" | jq -r '.context_window.context_window_size')
USAGE=$(echo "$input" | jq '.context_window.current_usage')

# If display_name is an ARN, map it to a friendly name based on the ARN suffix
# When using AWS Bedrock with custom inference profiles, the model.display_name field
# contains the full ARN instead of a human-readable name. The statusline hook doesn't
# receive the env variables from settings, so we manually map the ARN profile IDs
# to friendly model names based on the settings file configuration.
# NOTE: This mapping may need to be updated if the ARNs change in the future.
if [[ "$MODEL_DISPLAY" == arn:* ]]; then
    # Extract the last part of the ARN (the profile ID)
    ARN_SUFFIX="${MODEL_DISPLAY##*/}"

    # Map known ARN suffixes to model names (from your settings file)
    case "$ARN_SUFFIX" in
        "6od9xmd2cbz6") MODEL_DISPLAY="opus-4.5" ;;
        "ogexi6d27led") MODEL_DISPLAY="sonnet-4.0" ;;
        "ipjns1qlcy7k") MODEL_DISPLAY="haiku" ;;
        "9c9vc330rdvj") MODEL_DISPLAY="opus-4.5" ;;
        "gdsg22td462g") MODEL_DISPLAY="opus-4.6" ;;
        "5zsfjpvh8qwx") MODEL_DISPLAY="haiku-4.5" ;;
        "6y61sjrpojee") MODEL_DISPLAY="opus-4.6" ;;
        *) MODEL_DISPLAY="$ARN_SUFFIX" ;;
    esac
fi

# Show git branch if in a git repo
GIT_BRANCH=""
if git -C "$CURRENT_DIR" rev-parse --git-dir > /dev/null 2>&1; then
    BRANCH=$(git -C "$CURRENT_DIR" branch --show-current 2>/dev/null)
    if [ -n "$BRANCH" ]; then
        GIT_BRANCH=" | 🎋 $BRANCH"
    fi
fi

# Get lines added/removed
LINES_ADDED=$(echo "$input" | jq -r '.cost.total_lines_added // 0')
LINES_REMOVED=$(echo "$input" | jq -r '.cost.total_lines_removed // 0')
LINES_INFO=" | +$LINES_ADDED -$LINES_REMOVED"

# Calculate context usage
if [ "$USAGE" != "null" ]; then
    CURRENT_TOKENS=$(echo "$USAGE" | jq '.input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens')
    PERCENT_USED=$((CURRENT_TOKENS * 100 / CONTEXT_SIZE))
    echo "🧠 $MODEL_DISPLAY | 📁 ${CURRENT_DIR##*/}$GIT_BRANCH$LINES_INFO | Context: ${PERCENT_USED}%"
else
    PERCENT_USED=0
    echo "🧠 $MODEL_DISPLAY | 📁 ${CURRENT_DIR##*/}$GIT_BRANCH$LINES_INFO | Context: 0%"
fi

# Write metrics to a separate .metrics.json file, not the hook's .json file.
# Both scripts run concurrently. If they shared one file, this script's frequent
# read-modify-write would race with the hook's status updates — e.g. we read
# status="stopped", the hook sets status="working", then we write back "stopped".
# Separate files let each script write atomically; the Raycast extension merges
# them at read time where it's single-threaded and safe.
SESSION_ID=$(echo "$input" | jq -r '.session_id // empty')
if [ -n "$SESSION_ID" ]; then
    STATE_DIR="/tmp/claude-instances"
    mkdir -p "$STATE_DIR"
    METRICS_FILE="${STATE_DIR}/${SESSION_ID}.metrics.json"

    # Detect terminal env vars
    TERM_VAL="${TERM_PROGRAM:-}"
    WEZTERM_VAL="${WEZTERM_PANE:-}"

    JQ_ARGS=(
        --arg session_id "$SESSION_ID"
        --arg cwd "$CURRENT_DIR"
        --arg model "$MODEL_DISPLAY"
        --argjson lines_added "$LINES_ADDED"
        --argjson lines_removed "$LINES_REMOVED"
        --argjson context_percent "$PERCENT_USED"
        --argjson pid "$PPID"
        --arg updated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    )
    JQ_EXPR='{session_id: $session_id, cwd: $cwd, model: $model, lines_added: $lines_added, lines_removed: $lines_removed, context_percent: $context_percent, pid: $pid, updated_at: $updated_at}'

    if [[ -n "$TERM_VAL" ]]; then
        JQ_ARGS+=(--arg terminal "$TERM_VAL")
        JQ_EXPR="${JQ_EXPR%\}}, terminal: \$terminal}"
    fi
    if [[ -n "$WEZTERM_VAL" ]]; then
        JQ_ARGS+=(--argjson wezterm_pane "$WEZTERM_VAL")
        JQ_EXPR="${JQ_EXPR%\}}, wezterm_pane: \$wezterm_pane}"
    fi

    jq -n "${JQ_ARGS[@]}" "$JQ_EXPR" > "${METRICS_FILE}.tmp" && mv "${METRICS_FILE}.tmp" "$METRICS_FILE"
fi
