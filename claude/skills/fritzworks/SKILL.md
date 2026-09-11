---
name: fritzworks
description: Alias for ws; manage FritzWorks workstreams through its MCP server.
---

Use the `ws` MCP server's `ws_*` tools; schemas are authoritative.

Notes are Markdown resources. Use `ws_resource_add` with `content`; omit `value` for the configured session directory unless told otherwise. Manage with `ws_resource_{list,read,write,open,remove}`.

Use `ws_sync` to discover session Markdown and its current-branch PR on demand; never poll.
