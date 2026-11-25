# Session Auto Title

Renames a Paseo session from what the conversation is actually about, after the agent goes idle. Titles are short Simplified Chinese by default. The plugin can also copy the new title to the session's workspace so the sidebar and mobile clients show it.

## How it works

When a turn completes, the plugin waits for the configured idle period. If another turn starts, the wait resets. Once the session is idle, the plugin reads the first user message and the most recent messages, asks a model for a short title, then renames the agent with `paseo agent update --name`.

Two generators are available. The default calls the local `pi` CLI in one-shot mode with tools and project files disabled. The other creates a hidden background agent inside the same workspace, uses the model configured in Paseo, and archives the agent immediately after it answers. If the Paseo generator cannot find a model, the plugin falls back to `pi`.

## Setup

The default generator needs an installed and authenticated `pi` CLI on the daemon machine. When `pi` or `paseo` is not on the daemon `PATH`, set `SESSION_AUTO_TITLE_PI_BIN` or `SESSION_AUTO_TITLE_PASEO_BIN` to an absolute path and restart the daemon.

The Paseo generator reads the metadata generation model from the daemon config. A model override in the plugin settings takes priority, for example `claude/auto/deepseek-v4.1-flash`.

## Settings and limits

The idle wait defaults to 30 seconds. The rename policy defaults to naming once, after the first meaningful conversation; the other option refreshes the title after every idle turn. The naming prompt is fully editable and supports `{MMDD}`. Workspace title sync is a display convenience: a workspace can hold more than one session, so the last session to finish sets the name shown for all of them.

Manual renames are respected. If the title changes outside the plugin, or the caller explicitly sets a title when creating the session, the plugin stops renaming that session permanently. The force action in settings unlocks every session and reschedules it.

The plugin only changes agent titles and, when enabled, workspace display titles. It does not touch conversation content, project names, ownership, ordering, pinning, or archive state. Greeting-only or information-poor conversations keep their existing title.

## Data and privacy

To generate a title, the plugin sends an excerpt of the conversation (the opening user message and the most recent messages, capped at about 3,000 characters) to the selected generator: the local `pi` CLI, or a hidden background agent in the same workspace. Either generator forwards the excerpt to whichever model provider it is configured to use. The plugin sends data nowhere else and does not upload project files. Per-session bookkeeping is stored locally under the Paseo home directory.
