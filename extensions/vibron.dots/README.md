# vibron.dots

Named specialists with their own instructions, each with its own conversation on Vibron's embedded agent.

## What it does

A **Dot** is a specialist: a name, a role and the instructions it works under.
The panel lists the project's Dots on the left and the selected Dot's
conversation on the right. Each Dot talks on its own agent session, and the
session is resumed the next time that Dot is selected, so a planner, a reviewer
and a researcher keep separate histories inside the same project.

The idea comes from CopilotKit's OpenDots ("specialist Dots"), rebuilt on
Vibron's own pieces: `vibron.agent` for the conversation and `vibron.storage`
for the catalog, with no hosted service behind it.

## How it works

- Dots and the per-Dot transcript live in the extension's storage, under
  `<project>/.vibron/extensions/vibron.dots/storage.json`. Four Dots are seeded
  on first use (planner, coding, reviewer, researcher); edit or delete them.
- Vibron allows one live agent session per extension, so selecting another Dot
  disposes the current session and opens, or resumes, the other Dot's session.
  pi keeps the full history in its session file; the panel keeps a bounded
  transcript for display.
- The Dot's instructions are sent as the preface of its first turn on a
  session. There is no host API to pick a profile or a model per session yet,
  so every Dot runs on the agent's default model.

## Scopes

`storage`, `theme`, `ui` and `agent`. The `agent` scope asks for the user's
consent once per app session before the first conversation.

## Not yet

Saving a conversation as a Markdown page, scheduled work, and mapping a Dot to a
Vibron agent profile. The first two need the server-backed shape of an
extension; the third needs a host verb.

## Development

```bash
npm install
npm run build      # dist/ for sideloading
npm test
npm run typecheck
```

Sideload `extensions/vibron.dots` from Settings → Extensions → "Add local
folder…" after building, then enable it and open the Dots panel.
