---
name: orchestrate-project
description: "Orchestrate a Linear project through child fw sessions: read the project and its issues, write a plan, spawn one child session per PR, route follow-up issues, and report merge-ready PRs. Use in an fw orchestrator session when given a Linear project name or URL, or an issue URL inside a project. Trigger terms: orchestrate project, orchestrate linear project, spawn PR sessions, project orchestrator."
---

# orchestrate-project

Input: a Linear project name, or a Linear URL to a project or to an issue inside one. Resolve it with the `linear` skill. An issue URL means its whole project. If a name matches several projects, list the candidates and ask.

You are in an `fw` session, designated as an orchestrator of other sessions. Your job is to plan work (through research subagents) and spawn child `fw` sessions for each PR. You message them with `fw_send` and you can view their transcripts. You keep things moving forward.

## Plan

Read through the project and sub-issues and write `plan.md` in the session's notes directory (`fw_resource_list` reports `markdownDirectory`); associate it with `fw_resource_add` (kind `markdown`). If `plan.md` already exists, resume from it instead of re-planning.

Spawn research subagents to answer questions you have, with confidence scores (0.0-1.0). The plan should contain a record of these decisions, and the dependency order between issues.

Some projects may be active with other users. In those cases, you will need to opportunistically select issues to claim that are ready to work as you go.

`plan.md` is the source of truth; it must survive compaction or restart. Keep this status table current on every event:

| Issue | Child (fw id) | Branch | PR | State | Last event | Updated |
| --- | --- | --- | --- | --- | --- | --- |

## Children

- Spawn with `fw_child_create`: `repo`, `ref` = the issue's Linear branch name, `links` = [issue URL], `seed`. The seed is `child-seed.md` (in this skill's directory) with its placeholders filled, plus at most a few lines specific to the issue. The template carries the protocol; don't restate it, or what the issue says, or what the child would infer.
- Model: `fw_child_create` has no model parameter, so children run the daemon's configured Claude model (`FRITZWORKS_CLAUDE_MODEL`). Fable is expected. Check `fw_config`, record the model in the plan, and say so before spawning if it isn't Fable.
- Spawn in waves by dependency order: only issues whose prerequisites are merged, or stacked on them with the fw stack tools (`fw_stack_set`, `fw_stack_link`, `fw_stack_rebase`). Merge prerequisites first; rebase dependents after.
- At most 4 children active at once; queue the rest in the plan.
- Remind children to not spin out if taking significant amounts of time. To change their approach or ask you for help.

## Linear

- You, the children, and their subagents create follow-up and prerequisite issues in the current project, or in an existing project staged after it. Search for duplicates first; set parent and blocked-by relations.
- New issues reach you in a chain: a subagent reports each new issue key to the agent that spawned it (subagents can't `fw_send`), and that main agent `fw_send`s it to you. You decide whether to spawn a child for it.
- Keep existing and new issues matching the plan: state, parent/blocked-by relations, project. Don't change assignee or priority.

## PRs

- Children get an optional adversarial review from an Opus subagent before the first push, act on the findings they judge useful, push, then invoke `pr-iterate` until the PR is mergeable. A material change to the approach earns one more review cycle (two max). `pr-iterate` never merges; merging is a separate final step.
- Research subagents: Opus for most research, Fable for deep architectural research, Sonnet or Haiku for basic PR/Slack/Linear scanning. Each writes a Markdown document in the session notes directory and returns its path; the agent that spawned it associates the file with `fw_resource_add`.
- Merge-ready reports and the self-merge gate are defined in `child-seed.md`. Keep that file the single source.

## Reporting to the user

One line per event, in this session's output:

`MERGE READY | MERGED | ATTENTION REQUIRED <full pr or issue link> — <reason>`

If a PR is approved, but the ci process `doc-approval` hasn't finished, it is not really approved.

ATTENTION REQUIRED when an agent is blocked, waiting on doc reviews, asking you to merge because the gate isn't met, or facing a low (<0.5) confidence decision.

Done when every issue is merged, closed, or flagged ATTENTION REQUIRED. Then send the user a final summary: merged PRs, open items, follow-up issues created.

Whenever you need the user attention, or a PR becomes ready, use the `fw_attention` method.

## Be proactive

When you have a question you'd normally ask the user, spawn a research subagent. When you need a human doc-review (when the pr show ci for `doc-approval` running), inform the right group on slack (default #team-ixians, if gh shows `ai-cicd-team-write` as a requested reviewer, then #eng-ai-cicd). When an fw child stalls, find a way to unblock it if reasonable.

A stalled child is one that hasn't had activity for 15 minutes. Check `fw_children` status, `fw_child_transcript`, `fw_child_terminal` and messages sent. Use one `loop` (self-paced) to check on all children. React to `fw_send` message as they arrive.

Keep the loop prompt terse and minimal -- the agent will have enough context to check on the children.

End the loop when all children a done, merge ready, blocked, or the user says they are done for the day.

## Slack Review Requests

Each PR should be a single line and can be batched in a sigle message.
":pr: <full pr link> <2 to 8 word description> <optional user @>"

## Housekeeping

When a child closes, remove its clones and worktrees under `$TMPDIR`. All agents respect `$TMPDIR` and are mindful of token usage.
