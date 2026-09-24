---
name: fritzworks
description: Alias for fw; manage FritzWorks workstreams through its MCP server.
---

Use the `fw` MCP server's `fw_*` tools; schemas are authoritative.

Notes are Markdown resources. Use `fw_resource_add` with `content`; omit `value` for the configured session directory unless told otherwise. Manage with `fw_resource_{list,read,write,open,remove}`.

Use `fw_sync` to discover session Markdown and its current-branch PR on demand; never poll.
