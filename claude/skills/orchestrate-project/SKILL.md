---
name: orchestrate-project
description: "Orchestrate a Linear project through child fw sessions: read the project and its issues, write a plan, spawn one child session per PR, route follow-up issues, and keep dependent work moving as PRs merge. Use in an fw orchestrator session when given a Linear project name or URL, or an issue URL inside a project. Trigger terms: orchestrate project, orchestrate linear project, spawn PR sessions, project orchestrator."
---

# orchestrate-project

Input: a Linear project name, or a Linear URL to a project or to an issue inside one. Resolve it with the `linear` skill. An issue URL means its whole project. If a name matches several projects, list the candidates and ask.

You are in an `fw` session, designated as an orchestrator of other sessions. Your job is to plan work (through research subagents) and spawn child `fw` sessions for each PR. You message them with `fw_send` and you can view their transcripts. You keep things moving forward.

## Reacting

Children own their PRs: CI, reviews, conflicts, and merging (the gate is in `child-seed.md`). The daemon subscribes you to each child's PR so you stay aware, not so you act. For PR messages don't run `pr-iterate` rounds, investigate, reply, or edit the plan, except:

- merged: spawn or `fw_stack_rebase` the dependents it unblocks.
- closed without merging: `fw_attention` if dependents were waiting on it.
- a review-gated check (`doc-approval`, `codereviewer-needed`) waiting: ask for a review on Slack, once per PR (see Slack Review Requests).

The daemon's "<child> subscribed to <PR>; you are subscribed too" needs no action.

From children, act on:

- `ATTENTION REQUIRED`: unblock it if you reasonably can, else `fw_attention`.
- `DONE WITH WORK`: act on any concerns or follow-ups it lists.
- `DOCUMENT CHANGE NEEDED`: see Documents.
- a new follow-up or prerequisite issue: see Linear.

## Plan

Read through the project and sub-issues and write `plan.md` in the session's notes directory (`fw_resource_list` reports `markdownDirectory`); associate it with `fw_resource_add` (kind `markdown`). If `plan.md` already exists, resume from it instead of re-planning.

Spawn research subagents to answer questions you have, with confidence scores (0.0-1.0). The plan should contain a record of these decisions, and the dependency order between issues.

Some projects may be active with other users or virtual. In those cases, you will need to opportunistically select issues to claim that are ready to work as you go.

`plan.md` is the source of truth; it must survive compaction or restart. Keep it current on every decision: generally append it to the end of the plan (a `>>` append is enough), listing the challenge and the solution with a confidence score of 0.0-1.0. Log decisions, not events.

## Children

- Spawn with `fw_child_create`: `repo`, `ref` = the issue's Linear branch name, `links` = [issue URL], `seed`. The seed is `child-seed.md` (in this skill's directory) with its placeholders filled, plus at most a few lines specific to the issue. The template carries the protocol; don't restate it, or what the issue says, or what the child would infer.
- Model: `fw_child_create` has no model parameter, so children run the daemon's configured Claude model (`FRITZWORKS_CLAUDE_MODEL`). Fable is expected. Check `fw_config`, record the model in the plan, and say so before spawning if it isn't Fable.
- Spawn in waves by dependency order: only issues whose prerequisites are merged, or stacked on them with the fw stack tools (`fw_stack_set`, `fw_stack_link`, `fw_stack_rebase`). Merge prerequisites first; rebase dependents after.
- At most 6 children active at once; queue the rest in the plan.
- When the user informs you of something, like a PR conflict, or a change of direction, it is your job to relay that to the appropriate children (limited to relevant).

## Linear

- Children and their subagents create follow-up and prerequisite issues and relay each new key to you (`child-seed.md` has the procedure). You decide whether to spawn a child for it.
- Keep existing and new issues matching the plan: state, parent/blocked-by relations, project. Don't change assignee or priority.

## Research

Research subagents follow the Subagents section of `child-seed.md`: model choice, Markdown output in the notes directory, `fw_resource_add`.

## Documents

Children send `DOCUMENT CHANGE NEEDED` instead of putting markdown in a code PR. Collect them in the plan and batch them into one docs PR per repo, from a child of its own, rather than mixing docs and code in a PR. Docs PRs wait on human `doc-approval`, so ask on Slack (see Be proactive).

## Reporting to the user

Whenever you need the user attention, use the `fw_attention` method.

## Be proactive

When you have a question you'd normally ask the user, spawn a research subagent. When a PR needs a human doc-review (the PR shows ci for `doc-approval` running), inform the right group on slack (default #commit-to-libs, if gh shows `ai-cicd-team-write` as a requested reviewer, then #eng-ai-cicd). When an fw child stalls, find a way to unblock it by sending it a message with an idea of how to continue.

A stalled child is one that hasn't had activity for 15 minutes and isn't waiting on CI or reviews (`fw_pr_list` shows what its PR waits on). Check `fw_children` status; read `fw_child_transcript` and `fw_child_terminal` only for a child that looks stalled. Use one `loop` (self-paced) to check on all children.

Keep the loop prompt terse and minimal -- the agent will have enough context to check on the children.

End the loop when all children are done or blocked, or the user says they are done for the day.

## Slack Review Requests

Each PR should be a single line and can be batched in a single message.
":pr: <full pr link> <2 to 8 word description> <optional user @>"
