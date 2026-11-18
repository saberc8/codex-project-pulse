# Changelog

## 0.2.2 — Unreleased

- Show Start for pending project-only todos on macOS. The action opens a new Codex chat in the project with a prefilled todo-specific instruction.

## 0.2.1 — Unreleased

- Added a Start button for pending todos linked to a Codex chat on macOS. It copies a todo-specific instruction and opens the original chat. Sending the instruction lets the plugin mark that todo as in progress.

## 0.2.0 — 2026-11-17

- Added Claude Code sessions: transcripts in `CLAUDE_CONFIG_DIR`, `~/.claude` and magpie's per-account folders, read head and tail only and cached by size and mtime. Turn state comes from the last message (completed, interrupted, failed; running only while the file was written in the last 30 minutes). Clicking a session resumes it in Terminal with `claude --resume`.
- Added magpie: `magpie sessions --json`, refreshed in the background, adds the other agents it lists (Antigravity, OpenCode, Pi, Cursor…). Their resume commands are copied, never run.
- Sessions of every agent join Codex projects by folder; other folders are grouped by their git repository. Scratch runs in system temp folders are not projects. Each session shows its agent.
- Sources fail independently: a missing or unreadable agent is noted in settings without hiding the others. Only Codex has a read state, so other agents' sessions never make a project's unread count unknown.
- Claude Code plugin: `.claude-plugin/plugin.json` and marketplace; `src/project_pulse/stdio_server.py` starts the MCP server by path for hosts without `cwd` (Claude Code, magpie library).
- Fixed Codex data showing as unavailable while Codex was not running: a WAL database without `-wal`/`-shm` files is read as immutable.

## 0.1.11 — 2026-11-17

First public release, based on the local Project Pulse plugin.

- Added a GitHub-installable `project-pulse` marketplace and MIT license.
- Preserved the compact project dashboard, native-read-state inbox, linked todos and direct chat navigation.
- Fixed initial MCP server fallback icons to reflect current unread state.
- Exported light/dark entrypoint icons as 120×120 PNGs to try to avoid SVG template tinting. Native sidebar color and live refresh remain unverified; selected/outline-to-solid native switching is not implemented because no supported field has been found.
- Kept native UI resource addresses versioned to prevent cross-release HTML reuse.
- Added public installation guidance, anonymized QA notes and a CI workflow template.

Earlier versions were local development releases. Their private development history is not part of this public repository.
