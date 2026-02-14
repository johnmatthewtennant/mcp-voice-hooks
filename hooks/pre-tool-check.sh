#!/bin/bash
# Pre-tool hook for Claude Code that enforces:
# 1. Destructive operations always require verbal approval (even if on allowlist)
# 2. Operations not on allowlist require verbal approval
# 3. All decisions are logged to audit.log

# Audit log location
AUDIT_LOG="$HOME/.mcp-voice-hooks/audit.log"
mkdir -p "$(dirname "$AUDIT_LOG")"

# Read JSON input from stdin
INPUT=$(cat)

# Extract tool information
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')

# Log function
log_decision() {
  local decision="$1"
  local reason="$2"
  local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  echo "[$timestamp] TOOL=$TOOL_NAME DECISION=$decision REASON=\"$reason\" INPUT=$TOOL_INPUT" >> "$AUDIT_LOG"
}

# Check if operation is destructive
is_destructive() {
  local tool_name="$1"
  local tool_input="$2"

  # File deletion tools
  if [[ "$tool_name" == "Delete" ]]; then
    return 0
  fi

  # Bash commands - check for destructive patterns
  if [[ "$tool_name" == "Bash" ]]; then
    local command=$(echo "$tool_input" | jq -r '.command // empty')

    # Get first word of command to determine if it's a potentially destructive tool
    local first_word=$(echo "$command" | awk '{print $1}')

    # Skip destructive checks for known-safe commands
    case "$first_word" in
      gh|npm|curl|cat|echo|grep|sed|awk|jq|head|tail|ls|find|which|whereis)
        return 1  # Not destructive
        ;;
    esac

    # Only check for destructive patterns if command starts with potentially destructive tools
    # Check for destructive patterns
    if [[ "$command" =~ ^rm\ +-.*[rf] ]]; then
      return 0
    fi

    if [[ "$command" =~ ^git\ +reset\ +--hard ]]; then
      return 0
    fi

    if [[ "$command" =~ ^git\ +push.*(--force|-f) ]]; then
      return 0
    fi

    if [[ "$command" =~ ^git\ +clean\ +-.*f ]]; then
      return 0
    fi

    if [[ "$command" =~ ^git\ +branch\ +-D ]]; then
      return 0
    fi
  fi

  return 1
}

# Check if tool is on allowlist
is_on_allowlist() {
  local tool_name="$1"
  local tool_input="$2"

  # Read allowlist from .claude/settings.local.json
  local settings_file=".claude/settings.local.json"

  if [[ ! -f "$settings_file" ]]; then
    return 1
  fi

  local allowlist=$(jq -r '.permissions.allow[]? // empty' "$settings_file")

  # For Bash tool, check if the specific command pattern is allowed
  if [[ "$tool_name" == "Bash" ]]; then
    local command=$(echo "$tool_input" | jq -r '.command // empty')

    # Check each allowlist entry
    while IFS= read -r entry; do
      # Handle entries like "Bash(npm test:*)" or "Bash"
      if [[ "$entry" =~ ^Bash\((.+)\)$ ]]; then
        local pattern="${BASH_REMATCH[1]}"
        # Remove wildcard and check if command starts with pattern
        pattern="${pattern%:*}"
        if [[ "$command" == "$pattern"* ]]; then
          return 0
        fi
      elif [[ "$entry" == "Bash" ]]; then
        # All Bash commands allowed
        return 0
      fi
    done <<< "$allowlist"

    return 1
  fi

  # For other tools, check if tool name appears in allowlist
  while IFS= read -r entry; do
    if [[ "$entry" == "$tool_name" ]]; then
      return 0
    fi
  done <<< "$allowlist"

  return 1
}

# Main decision logic
make_decision() {
  # Check 1: Is operation destructive?
  if is_destructive "$TOOL_NAME" "$TOOL_INPUT"; then
    local command_preview=$(echo "$TOOL_INPUT" | jq -r '.command // .file_path // empty' | head -c 50)
    local reason="Destructive operation detected. This operation cannot be easily undone and requires verbal approval. Operation: $command_preview"

    log_decision "DENY" "$reason"

    # Return JSON decision
    jq -n \
      --arg reason "$reason" \
      '{
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: $reason
        }
      }'
    exit 0
  fi

  # Check 2: Is tool on allowlist?
  if is_on_allowlist "$TOOL_NAME" "$TOOL_INPUT"; then
    log_decision "ALLOW" "Tool on allowlist"

    jq -n '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow"
      }
    }'
    exit 0
  fi

  # Check 3: Not on allowlist - ask for approval
  local reason="Tool '$TOOL_NAME' is not on the allowlist. Verbal approval required before use."
  log_decision "ASK" "$reason"

  jq -n \
    --arg reason "$reason" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: $reason
      }
    }'
  exit 0
}

# Execute decision logic
make_decision
