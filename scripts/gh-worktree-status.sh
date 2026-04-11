#!/usr/bin/env bash
# Scans ~/Developer/worktrees/**/* and checks each worktree's GitHub PR status.
# Output is saved as individual per-worktree JSON files under:
#   /tmp/gh-worktree-status/worktrees/<root>__<worktree>.json
#
# Usage:
#   gh-worktree-status.sh                      # batch: scan all worktrees
#   gh-worktree-status.sh /path/to/worktree    # single: update one worktree
#
# Statuses:
#   open            - PR is open and ready for review
#   draft           - PR is open but marked as draft
#   merged          - PR was merged
#   closed          - PR was closed without merging
#   remote_no_pr    - branch pushed to remote, no PR exists
#   no_remote_branch- remote configured, but branch not pushed yet
#   no_remote       - no remote configured
#   detached_head   - worktree is in detached HEAD state

set -euo pipefail

DIR="/tmp/gh-worktree-status"
WORKTREES_DIR="$DIR/worktrees"
WORKTREES_ROOT="$HOME/Developer/worktrees"

mkdir -p "$WORKTREES_DIR"

# ---------------------------------------------------------------------------
# process_worktree <wt_dir>
# Computes PR status for one worktree and writes an atomic per-worktree file.
# ---------------------------------------------------------------------------
process_worktree() {
  local wt_dir="${1%/}"
  [[ -d "$wt_dir" ]] || return 1
  [[ -e "$wt_dir/.git" ]] || return 1

  local root_name wt_name branch remote_url repo pr_number status

  root_name=$(basename "$(dirname "$wt_dir")")
  wt_name=$(basename "$wt_dir")
  branch=$(git -C "$wt_dir" branch --show-current 2>/dev/null || true)
  remote_url=$(git -C "$wt_dir" remote get-url origin 2>/dev/null || true)

  repo=""
  pr_number="null"

  if [[ -z "$branch" ]]; then
    status="detached_head"

  elif [[ -z "$remote_url" ]]; then
    status="no_remote"

  else
    # Parse "owner/repo" from https or ssh GitHub URLs
    repo=$(echo "$remote_url" \
      | sed -E 's|.*github\.com[:/]([^/]+/[^/.]+)(\.git)?$|\1|')

    # Fetch the PR associated with this branch (handles open, draft, merged, closed)
    pr_json=$(gh pr view "$branch" \
      --repo "$repo" \
      --json number,state,isDraft 2>/dev/null || echo "null")

    # Fallback: gh pr view can silently return null even when a PR exists.
    # This happens when the remote branch has been deleted (e.g. auto-deleted
    # after merge) and GitHub's API can't resolve the branch ref, or when the
    # API returns a transient error that gets swallowed by 2>/dev/null.
    #
    # gh pr list --state all --head "$branch" is more reliable in this case
    # because it queries PRs by their stored head-branch name rather than
    # resolving the live branch ref. GitHub retains this metadata even after
    # the branch is deleted, so merged/closed PRs are still found.
    if [[ "$pr_json" == "null" ]]; then
      list_json=$(gh pr list \
        --repo "$repo" \
        --state all \
        --head "$branch" \
        --json number,state,isDraft \
        --limit 1 2>/dev/null || echo "null")
      if [[ "$list_json" != "null" && "$list_json" != "[]" ]]; then
        pr_json=$(echo "$list_json" | jq '.[0]')
      fi
    fi

    if [[ "$pr_json" == "null" ]]; then
      # No PR — check if branch exists on remote at all
      if git -C "$wt_dir" ls-remote --exit-code --heads origin "$branch" &>/dev/null; then
        status="remote_no_pr"
      else
        status="no_remote_branch"
      fi

    else
      pr_state=$(echo "$pr_json" | jq -r '.state')
      pr_draft=$(echo "$pr_json" | jq -r '.isDraft')
      pr_number=$(echo "$pr_json" | jq '.number')

      case "$pr_state" in
        MERGED) status="merged" ;;
        CLOSED) status="closed" ;;
        OPEN)
          if [[ "$pr_draft" == "true" ]]; then
            status="draft"
          else
            status="open"
          fi
          ;;
        *) status="unknown" ;;
      esac
    fi
  fi

  local filename="${root_name}__${wt_name}.json"
  # PID suffix ensures unique temp files when concurrent runs target the same worktree
  local tmpfile="$WORKTREES_DIR/.${filename}.tmp.$$"

  jq -n \
    --arg  ts        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg  root      "$root_name" \
    --arg  worktree  "$wt_name" \
    --arg  path      "$wt_dir" \
    --arg  branch    "$branch" \
    --arg  repo      "$repo" \
    --arg  status    "$status" \
    --argjson pr_number "$pr_number" \
    '{
      updated_at: $ts,
      root:       $root,
      worktree:   $worktree,
      path:       $path,
      branch:     $branch,
      repo:       $repo,
      status:     $status,
      pr_number:  $pr_number
    }' > "$tmpfile"

  mv "$tmpfile" "$WORKTREES_DIR/$filename"
  echo "  [$status] $root_name/$wt_name ($branch)"
}

# ---------------------------------------------------------------------------
# Main: targeted mode (args given) or batch mode (no args)
# ---------------------------------------------------------------------------

if [[ $# -gt 0 ]]; then
  # Targeted mode — no hour guard, process only the given worktree paths
  exec >> "$DIR/run.log" 2>> "$DIR/run.error.log"
  for wt_dir in "$@"; do
    process_worktree "$wt_dir"
  done

else
  # Batch mode — only run between 8am and 10pm
  hour=$(( 10#$(date +%H) ))
  if [[ $hour -lt 8 || $hour -ge 22 ]]; then
    exit 0
  fi

  exec > "$DIR/run.log" 2> "$DIR/run.error.log"

  seen_files=()

  for root_dir in "$WORKTREES_ROOT"/*/; do
    [[ -d "$root_dir" ]] || continue

    for wt_dir in "$root_dir"*/; do
      [[ -d "$wt_dir" ]] || continue
      # Git worktrees use a .git file (not dir); regular clones use a .git dir
      [[ -e "$wt_dir/.git" ]] || continue

      root_name=$(basename "$root_dir")
      wt_name=$(basename "${wt_dir%/}")
      process_worktree "$wt_dir"
      seen_files+=("${root_name}__${wt_name}.json")
    done
  done

  # Remove stale status files for worktrees that no longer exist on disk
  for f in "$WORKTREES_DIR"/*.json; do
    [[ -f "$f" ]] || continue
    fname=$(basename "$f")
    found=0
    for seen in "${seen_files[@]:-}"; do
      [[ "$seen" == "$fname" ]] && { found=1; break; }
    done
    if [[ $found -eq 0 ]]; then
      rm "$f"
      echo "  [removed stale] $fname"
    fi
  done

  count=${#seen_files[@]}
  echo "Saved $count worktrees → $WORKTREES_DIR"
fi
