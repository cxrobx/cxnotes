# CXNotes Documentation

## Quick Links

| Document | Description |
|----------|-------------|
| [CLAUDE.md](../CLAUDE.md) | Overview, status, commands |
| [CHANGELOG.md](../CHANGELOG.md) | Version history |

### Rule Files (always loaded — keep short)

| Document | Scope |
|----------|-------|
| [architecture.md](../.claude/rules/architecture.md) | Invariants digest, module map, key flows |
| [gotchas.md](../.claude/rules/gotchas.md) | Known-issue digest |

Every session pays for these, and they share Claude Code's 150k-char instruction
budget with the user's `~/CLAUDE.md`. Caps and digest ↔ reference parity are
checked by `scripts/instruction-budget.test.js` (part of `npm test`).

### Reference Docs (read on demand)

| Document | Description |
|----------|-------------|
| [architecture.md](./architecture.md) | Full text of every invariant — reasoning, measurements, history |
| [gotchas.md](./gotchas.md) | Full text of every gotcha — diagnostics, evidence |
| [learnings.md](./learnings.md) | Full session learnings behind CLAUDE.md's one-liners |
| [setup.md](./setup.md) | Environment & dependency setup |

## Contributing

Run `/documenter` after development sessions to keep documentation current.
