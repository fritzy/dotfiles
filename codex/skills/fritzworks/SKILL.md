---
name: fritzworks
description: Alias for fw; manage FritzWorks workstreams through its MCP server.
---

Use the `fw` MCP server's `fw_*` tools; schemas are authoritative.

When asked to write or update notes, keep them in the relevant session unless told otherwise. This is a storage rule, not a requirement to create or maintain notes during routine work.

Notes are Markdown resources. Use `fw_resource_add` with `content`; omit `value` for the configured session directory unless told otherwise. Manage with `fw_resource_{list,read,write,open,remove}`.

Read and write workstream notes only through the fw resource tools. If a tool fails, report the blocked note operation and continue independent work; do not fall back to filesystem access or scripts.

Use `fw_sync` to discover session Markdown and its current-branch PR on demand; never poll.
