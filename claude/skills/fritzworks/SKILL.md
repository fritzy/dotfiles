---
name: fritzworks
description: Alias for fw; manage FritzWorks workstreams through its MCP server.
---

Use the `fw` MCP server's `fw_*` tools; schemas are authoritative.

When the user names a daemon ("on the workstation"), get its id from `fw_daemons` and pass it as `daemon` on every call for that work. Without `daemon`, calls go to the local daemon.

When asked to write or update notes, keep them in the relevant session unless told otherwise. This is a storage rule, not a requirement to create or maintain notes during routine work.

Notes are Markdown files. Read, create, and edit them directly with filesystem tools in the relevant session directory. `fw_resource_list` reports association paths and the configured `markdownDirectory`. After creating a file, associate its existing path with `fw_resource_add` (`kind` and `value`). Use `fw_resource_remove` to remove the association without deleting the file. MCP does not expose file-content reading, writing, creation, or opening. Remote paths belong to the selected daemon: edit on that host or through an explicitly shared mount, not the same-looking local path.

Orchestration tools act as the calling session (its terminal's `FRITZWORKS_ID`). `fw_children` lists the calling orchestrator's children; `fw_child_create` adds a repository child (`repo` + `ref`) or, with `scratchpad`, a scratchpad child, with Shell and AI panels and its agent started by default with `seed` as its first prompt (`start: false` leaves it paused). Its parent is the calling orchestrator unless `orchestrator` is set. Set it for an orchestrator just made with `fw_orchestrator_new` or one on a remote daemon; `fw_new` plus `fw_session_move` leaves children paused. `fw_child_start` starts a child's agent. Any session or location can message any other with `fw_send`: `to` is an id or a unique name (label, branch or peer name); an ambiguous name returns candidates. Messages are stored, then delivered: Claude agents get them immediately, between tool calls if busy or as a new turn if idle (`redirect: true`: a new turn after the current tool, not a hard stop); Codex and agents without a peer socket get them typed in once idle (never into orchestrators or locations). Undelivered messages wait in the recipient's inbox. Reply to an `[fw message …]` with `fw_send` to the id it names. Pass `daemon` to message a session on another daemon; a reply id from another daemon (`<instanceId>/<uuid>`) finds its daemon without one. In a child, `to: "parent"` is its orchestrator: send progress, questions, blockers and results there. `fw_inbox` reads messages to the calling session; `ack: true` marks them read.

Use `fw_sync` to discover session Markdown and its current-branch PR on demand; never poll.

Use `fw_broadcast` to send one message to every running session and location (never you or Scheduled Task sessions). It runs as a job, one recipient every `delay` seconds (default 0.75); `paused: true` also starts paused sessions' agents and messages them. Check results with `fw_job`.

Use `fw_attention` (CLI `fw attention [reason]`) when the user should look at your session but no prompt is blocking you: long work finished, or a decision is needed. Its sidebar icon reads like a waiting agent, `reason` as the tooltip, until the user focuses its AI panel. `fw_attention_clear` withdraws it.

Use `fw_review` (CLI `fw review <org/repo#N|url> [--scratch]`) to start a PR review session; its agent runs the configured `prReviewSkill` on the PR. On `review_exists`, open the returned workstream instead.

Use `fw_incoming` (CLI `fw incoming [<id>]`) to read the daemon's Incoming Work queries: with no `query` it lists them; with `query` it returns items, cached for 60s (`refresh: true` bypasses). A failed query returns `error` and no items. To start work from an item, pass the same `daemon` and:
- GitHub or Linear issue: `fw_new` with `repo` (the item's `repository`, else the query's), a `ref` you choose, and `links: [item.url]`; or `fw_scratch` with `links: [item.url]`.
- GitHub PR: `fw_review` with `pr: item.url` (the PR URL is linked automatically).

For orchestration, use `fw_child_transcript` for bounded visible conversation messages and `fw_child_terminal` for a detached viewport. `fw_child_input` inserts literal text without Enter by default; specify `submit: true` to submit. It requires panel ID, generation and request ID. Waiting-prompt replies additionally require `mode: "reply"` and a fresh terminal snapshot token. Never use it to approve a child's permission or trust prompt; those are the user's. Reuse the exact request ID on retries; never automatically replay unknown delivery. The calling orchestrator must have a current managed terminal credential.

Use `fw_scheduled_task_list/get/create/update/run/complete/cancel/runs/preview` to manage requested Scheduled Tasks on an explicit daemon; schemas define the individual tool names and fields. Store freeform prompts unchanged, including skill references. Task edits require the current revision. Run Now requires a stable request ID and also works for disabled tasks. `fw_scheduled_tasks_status/pause/resume` manage that daemon's persisted pause state; pause leaves already-dispatched work running. Tasks own their scratch workspace, notes and fixed-name AI panel. Submitted runs stay open across replies, manual input and daemon restarts until explicitly completed or cancelled. The dispatched prefix supplies the task name, schedule, trigger, zoned datetime and exact task/run IDs. When the requested work and approvals are finished, call `fw_scheduled_task_complete` with those IDs on the owning daemon; use `fw_scheduled_task_cancel` when abandoning the run. Cancellation closes the run record without stopping the AI or disabling the schedule. Never substitute a newer run ID when retrying either action.
