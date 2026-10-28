## Code comments
- Keep comments terse. Sentence fragments are fine.
- Comment only on non-obvious behavior, specific rationale, or hazards.
- Do not narrate self-evident code or add a comment to every block.
- Include examples only when needed to explain a hazard.
- Omit meta-commentary.

## Responses
- Be direct. Omit meta-commentary and self-evaluation.
- Avoid filler such as “this is important because” or “this is real.”
- Prefer short bullets or checklists when explanations are unnecessary.
- Write PR references as full URLs or clickable links, never a bare `#123` or `repo#123`.

## Workstream notes
- When working within a workstream, keep relevant plan and research
  Markdown documents current in that workstream’s notes.

## Temporary files
- Put scratch files, clones, worktrees, and logs under `$TMPDIR` (`mktemp -d`), never a literal `/tmp`. `/tmp` may be RAM-backed.
- Remove scratch you created when done; clones and worktrees are large.

## Builds
- Limit parallel compiles to `$(nproc) - 2` jobs (`go build -p`, `make -j`, `cargo -j`, `GOMAXPROCS`). Many sessions share one machine.
