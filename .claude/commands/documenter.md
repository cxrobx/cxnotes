---
description: Update project documentation after a development session
---

Run the session documenter workflow for this project.

**Project name**: CXNotes

## Instructions

You are a documentation specialist. Analyse the current session's changes and update all project documentation following the compound documentation architecture.

### Workflow

1. **Detect changes** — Read recent git diff/log to understand what changed this session
2. **Gap detection** — Identify what was unclear, missing, or wrong in the docs
3. **Update documentation** following this priority:

| Priority | File | Update When |
|----------|------|-------------|
| 1 | `CHANGELOG.md` | Every session (dated entry) |
| 2 | `docs/learnings.md` (full write-up) + `CLAUDE.md` Recent Learnings (ONE line) | Every session |
| 3 | `docs/architecture.md` (full) + `.claude/rules/architecture.md` (digest entry) | Core patterns / invariants changed |
| 4 | `docs/gotchas.md` (full) + `.claude/rules/gotchas.md` (digest entry) | New gotcha discovered |
| 5 | `docs/` reference files | Setup/deployment changed |

**Always-loaded vs on-demand.** `CLAUDE.md` and `.claude/rules/*.md` load into every
session and share Claude Code's 150k-char budget with `~/CLAUDE.md` (~65k). Measurements,
incident stories and diagnostics go in `docs/`; the always-loaded entry keeps the rule,
the non-obvious reason, the "don't" and a code pointer. Invariant and gotcha numbers are
shared between digest and full file and are permanent.

### Quality Gates

- [ ] `node --test scripts/instruction-budget.test.js` passes (caps: CLAUDE.md 8k, rules/architecture.md 24k, rules/gotchas.md 18k; digest ↔ docs number parity)
- [ ] CHANGELOG.md has dated entry for this session
- [ ] Recent Learnings in CLAUDE.md got a one-line entry; the long form is in `docs/learnings.md`
- [ ] No duplicate content across files beyond digest ↔ full-reference pairs
- [ ] File paths mentioned actually exist

### Output

Provide a summary:
```
## Session Documentation Summary
**Date**: [YYYY-MM-DD]
**Focus**: [Brief description of session work]

### Files Updated
| File | Changes |
|------|---------|

### Gaps Found & Resolved
| Gap | Resolution | File |
|-----|------------|------|
```
