---
name: fritzworks
description: Alias for fw; manage FritzWorks workstreams through its MCP server.
---

Use the `fw` MCP server's `fw_*` tools; schemas are authoritative.

When asked to write or update notes, keep them in the relevant session unless told otherwise. This is a storage rule, not a requirement to create or maintain notes during routine work.

Notes are Markdown files. Read, create, and edit them directly with filesystem tools in the relevant session directory. `fw_resource_list` reports association paths and the configured `markdownDirectory`. After creating a file, associate its existing path with `fw_resource_add` (`kind` and `value`). Use `fw_resource_remove` to remove the association without deleting the file. MCP does not expose file-content reading, writing, creation, or opening. Remote paths belong to the selected daemon: edit on that host or through an explicitly shared mount, not the same-looking local path.

Use `fw_sync` to discover session Markdown and its current-branch PR on demand; never poll.
