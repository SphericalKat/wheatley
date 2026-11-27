---
name: docs-sync
description: Update the documentation to match code changes. Use with no argument to check the current branch against `origin/main`, or with `sweep` to check recent commits on `main`.
---

# docs-sync

Update the documentation so that it matches the code. The code is the source of truth.

## Modes

### Branch diff (no argument)

1. Run `git diff origin/main...HEAD` to get the changes in scope.
2. Run `git log origin/main..HEAD` to read the commit messages.

### Sweep (`sweep`)

1. If the caller gives a commit range, use that range.
2. If no range is given, find the last sync commit with `git log --grep="^docs: daily sync$" -n 1 --format=%H`.
3. If a sync commit exists, use the range `<sync commit>..HEAD`.
4. If no sync commit exists, use the commits from `git log --since="36 hours ago"`.
5. Run `git log` and `git diff` on the range to get the changes in scope.

## Documentation scope

| Change in the code | Documentation to check |
| --- | --- |
| Public APIs, CLI flags, configuration, defaults, error messages, or behavior | `README.md`, `docs/`, `packages/docs/src/content/docs/`, and public docstrings |
| Workspace layout, tooling, or domain terms | `AGENTS.md` and `GLOSSARY.md` |

Public docstrings are the TSDoc comments on exported symbols.

Do not edit these files:

- `CHANGELOG.md`. `release-please` generates it from Conventional Commits.
- `docs/adr/`. The files are historical architecture records.
- `docs/v1-build-plan.md`. The file is a historical build plan.

## Procedure

1. Read each change in scope and the commit message that describes it.
2. If a change is an internal refactor that does not affect user behavior, workspace layout, tooling, or domain terms, ignore it.
3. Find the documentation sections that describe the changed code.
4. Read the code to confirm the current behavior before you edit a section.
5. Update only the sections that disagree with the code. Match the existing tone and structure.
6. Leave accurate sections unchanged.

## Rules

- Treat the code as the source of truth. Never edit code to match the documentation.
- In source files, edit only docstrings.
- If the code looks wrong, do not edit it. List it under `Possible bugs` in the summary.
- If you cannot confirm the behavior from the code, do not edit the section. List it under `Uncertain` in the summary.

## Summary

End with a short summary in this format:

```markdown
## Changed files

- `<path>`: <what changed and which commit caused it>

## Possible bugs

- `<path>:<line>`: <why the code looks wrong>

## Uncertain

- <item that you did not change, and the reason>
```

Write `None` under a heading that has no items.

If the caller gives a summary output path, write the summary to that file as well.
