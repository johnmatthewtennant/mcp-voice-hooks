# Claude

## Read the docs

Read the docs before responding to the user:

@roadmap.md
@README.md
@CONTRIBUTING.md

- <https://modelcontextprotocol.io/tutorials/building-mcp-with-llms>
- <https://code.claude.com/docs/en/hooks.md>
- <https://code.claude.com/docs/en/plugins-reference.md>

## Voice Mode Safety Rules

When working in voice mode with the user, follow these safety rules for tool usage:

### Tool Usage Decision Flow

1. **Check if operation is destructive**:
   - File deletions (Delete tool, rm commands)
   - Git destructive operations (git reset --hard, git push --force, git clean -f, git branch -D)
   - System modifications that cannot be easily undone
   - **If destructive**: ALWAYS ask for verbal approval with a clear warning about what will be destroyed and why. Wait for explicit verbal confirmation before proceeding.

2. **Check if operation is on the allowlist** (see `.claude/settings.local.json`):
   - **If on allowlist**: Proceed freely without asking
   - **If NOT on allowlist**: Ask for verbal approval before using the tool

### Verbal Approval Process

When asking for approval:
1. Use the `speak` tool to ask clearly: "Do you approve [specific action]? This will [explain consequences]."
2. Wait for the user's verbal response (delivered via voice hooks)
3. Check their response for approval words: "yes", "approve", "go ahead", "confirmed", "do it"
4. If approved verbally, proceed with the tool use (user will also approve in Claude Code UI if needed)
5. If denied ("no", "stop", "cancel", "abort"), do not proceed

### Examples of Destructive Operations Requiring Extra Caution

- `rm -rf` or any recursive file deletion
- `git reset --hard` - discards uncommitted changes
- `git push --force` - can overwrite remote history
- `git clean -f` - deletes untracked files
- `git branch -D` - force deletes branches
- Deleting files with Delete tool
- Modifying critical system files
- Dropping database tables

### Current Allowlist Reference

Safe operations currently on the allowlist (as of last check):
- npm commands: build, install, test
- git: checkout, add, commit
- curl (HTTP requests)
- System info: defaults read, lsof, ipconfig getifaddr
- chrome-devtools: navigate, snapshot, fill, press_key
- WebSearch, WebFetch (specific domains)

Any tool not on this list requires verbal approval before use.
