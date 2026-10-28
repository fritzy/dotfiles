---
name: stop-for-tonight
description: "Wind this session down so it can be picked up later: stop background subagents and workflows, loops and cron jobs, and background shells; save a resume note with your exact place; and, if you're an fw orchestrator, tell your children to do the same. The user asks you to resume when they're back. Use when the user says to stop for the night, or when a parent sends a stop-for-tonight message. Trigger terms: stop-for-tonight, stop for tonight, wrap up for the night, pause everything, shut down for the night, end of day shutdown."
---

# stop-for-tonight

Stop everything this session has running, save your place, go idle. No new work, commits, pushes, PR comments or merges. Leave the working tree as it is.

Tool names are Claude Code's (`TaskStop`, `CronList`, `ScheduleWakeup`, …). In Codex, use its equivalents: stop the subagents, scheduled jobs and background shells you started. The `fw_*` tools are the same in both.

## 1. Inventory (before stopping anything)

Collect what a resume needs; stopping loses it.

- **Subagents:** every background `Agent` you started that hasn't finished: agent id, description, what it was doing, any partial result.
- **Workflows:** every running `Workflow`: task id, run id (`wf_…`), script path.
- **Loops and cron:** `CronList`, plus any `/loop` you are running (including self-paced ones and `pr-iterate`): schedule, exact prompt or args, recurring or one-shot.
- **Background shells:** every `Bash` with `run_in_background` and every `Monitor` you started: task id, command, cwd, whether it is safe to rerun.
- **Children** (fw orchestrator): `fw_children`: id, branch, PR, last known state.
- **Git:** for each repo you touched: branch, `HEAD`, `git status --short`, unpushed commits.
- **Your place:** the task, the next step, open questions for the user, anything you were waiting on.

## 2. Stop

- Subagents and workflows: `TaskStop`.
- Loops: `CronDelete` each job; for a `/loop`, call `ScheduleWakeup` with `stop: true`. Don't start new ones.
- Shells and monitors: `TaskStop`. Only tasks you started, never other processes or other sessions' terminals.
- **Hazard:** don't kill an in-flight push, rebase, `terraform apply`, migration, deploy or release mid-run. Let it finish and note the outcome. If it will run long, leave it and report it.
- Daemon-wide fw scheduled tasks (`fw_scheduled_tasks_*`) are not yours; leave them and mention them in the report.

## 3. Save your place

Write `stop-for-tonight.md` in the session's notes directory (`fw_resource_list` reports `markdownDirectory`; associate it with `fw_resource_add`, kind `markdown`). Outside fw: `~/notes/work/<year>/plans/stop-for-tonight-<date>.md`. It must be enough to resume after `/clear` or compaction.

Sections: stopped at (`date -u`), task and next step, subagents, workflows, loops/cron (exact params to recreate), shells (command, cwd, safe to rerun?), children, git state, open questions, still running (anything you left on purpose).

If `plan.md` exists, set the affected status rows to `paused` and add a line pointing to this note. Don't rewrite the plan.

## 4. Children

Orchestrators only. `fw_send` each active child with `redirect: true`, self-contained so it works without the skill:

> The user is stopping for the night (skill: stop-for-tonight). (1) Stop your background subagents/workflows, loops/cron and background shells; let in-flight pushes and applies finish. (2) Save your place (task, next step, what you stopped and how to restart it) to `stop-for-tonight.md` in your notes dir. (3) Pass this to your own children. (4) Reply to parent: "stopped", the note path, and anything left running. No new work, commits or pushes. Wait for the user to ask you to resume.

Do this before stopping your own shells so you can still send. Check `fw_inbox` once for acks. Record who acked and who didn't in your note. Don't poll or wait in a loop. An ack that arrives after you've gone idle: add it to the note and do nothing else.

## 5. Report and idle

Short bullets: what you stopped, what you left running and why, note path, children acked or not. Then stop. No wake-ups, no follow-up work.

## Resume

When the user asks you to resume:

1. Read the newest unresumed `stop-for-tonight.md`.
2. Recheck anything time-sensitive before acting: `git status` against the note, CI and PR state, `fw_inbox`.
3. Recreate loops and cron: `CronCreate` with the saved params; for a `/loop`, invoke the `loop` skill with the saved args.
4. Restart shells and monitors that the note marks safe to rerun. Ask first for any that wasn't or that has side effects.
5. Subagents: try `SendMessage` to the saved agent id; if it can't continue, respawn with a brief of what it had done. Workflows: `Workflow` with `resumeFromRunId` after confirming the old run is stopped.
6. Orchestrators: `fw_send` each child "resume from your stop-for-tonight note". Respect your concurrency cap (queue the rest) and dependency order. Set `plan.md` rows back from `paused`.
7. Mark the note `resumed <date -u>`; keep it. Report briefly.
