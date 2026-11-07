# git-commit

A pi extension that commits **now** — mid-run, without waiting for the agent to settle — writing the message from the staged diff plus the session's own transcript.

Why not ask the agent: a fresh batch session has no relation to your working transcript, so the message is a diff-only guess, and waiting for the run to end is the pain being solved. This commits a snapshot at command time and tells the agent back what landed.

## Usage

```
/commit                        # stage everything, commit
/commit staged                 # commit only what you already staged
/commit amend                  # rewrite the last commit instead of adding one
/commit ~/other/repo           # commit a different repository
/commit staged amend ~/other/repo   # flags and dir, any order
```

At most one `staged`, one `amend`, and one directory. A directory with spaces must be quoted (`/commit "/tmp/my repo"`); `~` expands to your home. Anything else is a usage error.

## Amend

`/commit amend` runs `git commit --amend`. Two details follow from that:

- **The message describes the whole amended commit, not the folded-in delta.** After an amend the new commit holds the entire index, so the diff the model sees is the index against `HEAD^` — a root commit diffs against the empty tree hash git reports. Writing the message from the incremental change would under-describe the commit.
- **An empty index means message-only.** Nothing to stage plus `amend` rewrites just the message, leaving the tree alone.

Nothing here blocks rewriting published history. If the commit was pushed, that is yours to know — the extension warns about nothing and force-pushes nothing.

## Config

`<cwd>/.pi/git-commit.json` — read from the **session's project**, never from the repo being committed:

```json
{ "model": "inherit", "thinking": "low" }
```

| Key | Default | Meaning |
|---|---|---|
| `model` | `inherit` | `inherit` = the session's model; otherwise `provider/modelId`, or a bare model id if unambiguous |
| `thinking` | `low` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |

A missing file means defaults. An unknown model id or thinking level refuses rather than falling back silently — a message written by the wrong model is worse than no commit.

## Message format

`<cwd>/.pi/commit-message-format.md` — **the message shape itself**. Whatever this file says is interpolated verbatim into the system prompt under `Commit message format (follow it exactly):`. Edit it and the next commit message follows the new shape; no code change needed.

With no file, the extension falls back to the template it shipped with — the same three paragraphs, kept as `DEFAULT_MESSAGE_FORMAT`. Edit either; nothing enforces that they stay identical.

Honoured only when the project is trusted (`ctx.isProjectTrusted()`). Note pi's own semantics: a project with no trust-requiring resources (no `.pi/extensions`, no project `AGENTS.md`, …) counts as trusted, so the file applies out of the box; a project with executable project-local resources needs `/trust` or `-a` first. This workspace's file is `.pi/commit-message-format.md`.

## What the message is built from

- **The staged diff** — per-file clip at 4k chars, 24k total, and the `--stat` summary clipped at 60 lines. Cuts are marked inline so the model knows it is reading an excerpt.
- **The session transcript** — the last ~6k chars of user and assistant messages (1.2k per entry), tool calls reduced to one line each, plus the latest compaction summary. Tool results and thinking are excluded: logs and file dumps invite themselves into the body, and the diff already says what changed. The transcript is labelled intent-only.

Shape comes from the format file, falling back to the built-in template; the code only enforces that the message is non-empty, under 100 characters in the subject, and not an echo of the diff.

## Failure behaviour

| Situation | Result |
|---|---|
| Not a git repo / no such directory | warning, nothing staged |
| Nothing to commit (`staged` with an empty index included) | warning, no model call |
| Unknown model, no credentials, model error | error, tree left as it was |
| Generated message empty or subject over 100 chars | rejected, repo left staged — fix and rerun |
| `git commit` fails (hooks, identity) | git's own stderr, index left staged |

After a successful commit the extension sends a steering message into the session with the hash, subject and `--stat`, so the working agent knows the tree is clean and stops trying to commit the same changes.

## Limitations

- `git add -A` captures whatever is on disk at that moment. Firing `/commit` while the agent is mid-write can commit a half-written file — fire between tool calls. There is no private-index snapshot; that is the deliberate trade against pi-committer's approach.
- The assistant message currently streaming is absent from the transcript (entries are appended on message end), so the newest intent may be missing.
- No push, no multi-commit splitting, no conventional-commit type enforcement, no verbatim-message argument.

## Tests

Pure logic — argument parsing, clipping, sanitising, config parsing, prompt assembly — lives in `lib.ts` and is covered by `lib.test.ts`:

```bash
cd git-commit && bun test
```

46 assertions, no pi or network needed. Anything that shells out to git still needs a scratch repo.

## Install

```bash
pi install git:github.com/aolshevskiy/pi-git-commit
```

Loading depends on the `pi.extensions` entry in `package.json`: for a managed npm or git package, pi collects resources from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`) or from the paths declared under `pi`. A bare `index.ts` at the package root is **not** discovered — that fallback belongs to local directory sources only. `pi update --extensions` after pushing changes.

One-off, nothing installed:

```bash
pi -e git:github.com/aolshevskiy/pi-git-commit
```

## Status

Smoke-tested headlessly against eleven cases (clean tree, partial staging, empty index, usage error, non-repo dir, unknown model, 3000-line diff, target dir, quoted dir with a space, `~` expansion, instructions with and without trust).

Mid-run verified 2026-11-07: `/commit` fired from a live session while the agent was still writing files, committed the snapshot at command time, and its report arrived in the agent's context as a steering message.
