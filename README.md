# Session Auto Title

A Paseo plugin that renames a session from what the conversation is actually
about, after the agent goes idle. Titles are short Simplified Chinese by
default. Optionally the new title is also copied to the session's workspace, so
the sidebar and mobile clients show it.

## Requirements

- Paseo 0.17.4 or newer, with plugins enabled.
- One title generator:
  - **pi (default)** — the `pi` CLI installed and authenticated on the machine
    running the Paseo daemon.
  - **Paseo** — a metadata generation model configured in Paseo. No `pi`
    installation is needed. If no model resolves, the plugin falls back to
    `pi`.

## Install

From GitHub:

```bash
paseo plugin add git:mrgolftech/paseo-session-auto-title
```

From a local checkout:

```bash
paseo plugin add /path/to/paseo-session-auto-title
```

Then open **Settings → Plugins → Session Auto Title** to configure it. If the
daemon does not pick up the plugin immediately, run `paseo plugin reload
session-auto-title` or restart the daemon.

## How it works

1. A turn completes and the session goes idle. The plugin waits for the
   configured idle period; a new turn cancels the wait and reschedules.
2. The plugin reads the first user message and the most recent messages of the
   conversation, capped at roughly 3,000 characters.
3. It asks the selected generator for a short title as strict JSON:
   `{"decided": true, "title": "..."}` or `{"decided": false}`.
4. It renames the agent through `paseo agent update <id> --name <title>`.
   There is no public SDK title setter, so the CLI is the supported path.
5. If workspace title sync is enabled, it also calls the workspace
   `setTitle` API.

The `pi` generator runs in one-shot mode with tools, extensions, MCP servers,
skills, prompt templates and project context files disabled, so it does not
read or modify the project. The Paseo generator creates a hidden background
agent in the same workspace, waits for its answer, and archives it.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Enabled | on | Master switch. |
| Idle seconds | 30 | How long the session must stay idle before naming. |
| Rename mode | first | `first` names once after the first meaningful conversation; `each` refreshes the title after every idle turn. |
| Sync workspace title | on | Copy the new title to the workspace display name. |
| Engine | pi | `pi` (local CLI) or `paseo` (background agent). |
| Model | empty | Optional provider/model override, for example `anthropic/claude-sonnet-5-5`. Only used by the Paseo engine. |
| Date prefix | off | Prefix the title with `MMDD`. The prompt can also use the `{MMDD}` placeholder. |
| Prompt | built-in | The full title prompt. Must keep the single-line JSON output contract. |

Manual renames are respected. If the title changes outside the plugin, or the
caller explicitly sets a title when creating the session, the plugin stops
renaming that session permanently. **Rescan existing sessions** in the settings
screen unlocks every session and schedules it again.

## Data and privacy

To generate a title, the plugin sends a conversation excerpt (the opening user
message and recent messages, capped at about 3,000 characters) to the selected
generator. With `pi`, that is the local `pi` CLI; with `paseo`, it is a
background agent in the same workspace. Either generator forwards the excerpt
to whichever model provider it is configured to use. The plugin itself sends
data nowhere else, and it does not upload project files.

Per-session bookkeeping — the last title the plugin wrote, whether the session
is done or locked — is stored locally at
`~/.paseo/plugin-data/session-auto-title/state.json`.

The plugin only changes agent titles and, when enabled, workspace display
titles. It does not touch conversation content, project names, ownership,
ordering, pinning, or archive state.

## Troubleshooting

Show plugin logs:

```bash
paseo plugin logs session-auto-title
```

If `pi` or `paseo` is not on the daemon's `PATH`, set one of these environment
variables on the daemon and restart it:

- `SESSION_AUTO_TITLE_PI_BIN` — absolute path to the `pi` executable.
- `SESSION_AUTO_TITLE_PASEO_BIN` — absolute path to the `paseo` executable.
- `SESSION_AUTO_TITLE_NODE_BIN` — absolute path to `node`, used when the plugin
  launches `pi`'s JavaScript entry directly.
- `SESSION_AUTO_TITLE_PI_ENTRY` — absolute path to
  `@earendil-works/pi-coding-agent/dist/bundle/cli.js`.

On Windows, launching `pi`'s JavaScript entry with `node` avoids `cmd.exe`
mangling multi-line prompts. The plugin resolves that entry automatically when
it is installed in the usual npm locations.

## Development

```bash
npm install
npm run typecheck
```

The plugin source is plain TypeScript/TSX and is loaded by Paseo at runtime; no
build step is required.

## License

MIT. See [LICENSE](LICENSE).
