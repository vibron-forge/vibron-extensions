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
  session. A Dot can name a Vibron agent profile (Settings → Agents, listed by
  `vibron.agent.profiles()`): its session then opens on that profile's route,
  and the header shows the model. A profile that is not enabled falls back to
  the agent's default model, with a note in the transcript. The seeded Dots
  name `planner`, `coding`, `qa` and `research`.

## Scopes

`storage`, `theme`, `ui`, `agent`, `editor.write` (to open a saved page) and
`workspace.read` (the project root, to open it by path). The `agent` scope asks
for the user's consent once per app session before the first conversation.

## Pages and scheduled work (server-backed, 0.2.0)

The extension ships its own server (`dist/server.js`), spawned by Vibron per
workspace. It serves the panel and owns two things a webview cannot:

- **Pages.** "Save as page" on a Dot's answer opens a review card; nothing is
  written until the human confirms. The page lands in
  `<project>/.vibron/dots/pages/<slug>.md` with a small frontmatter (title,
  date, Dot, source) and opens in the editor. A title already used gets its
  own file; nothing is overwritten.
- **Scheduled work.** A task is a Dot, a prompt and a period. While the server
  is alive, a due, armed task opens the Dot's session (on its profile), sends
  the prompt with the instructions as preface, saves the answer as a page and
  records the run (`ok` or `failed`; a run the agent was busy for is deferred a
  minute, with no record). A run the server did not see end is marked
  `interrupted` on the next start, never completed. Tasks and runs live in the
  extension's storage, so they survive restarts and the panel shows them.
- **Arming.** The storage file lives in the project, and a repository could
  ship one. So a task read back from storage is *not armed*: it never runs a
  model turn until a human resumes it or runs it in the panel, in that
  server's life. A task created in the panel is armed by that creation;
  pausing disarms. The panel shows each task's prompt next to its state.
- **Confinement.** Pages are written only under `.vibron/dots/pages` of the
  real workspace root; a symbolic link anywhere on that path refuses the
  write. A turn that does not answer in 15 minutes is cancelled and the run
  fails; "Cancel running turn" in the panel does the same at once.

**Limits:** the manifest declares `server.keepAlive`, so on a Vibron that
honours it the server outlives the panel and the schedule keeps running for
the workspace's life in that app session (it still starts when the panel is
first opened); on an older Vibron the server stops 30 s after the last panel
closes, and the schedule runs while the panel is open. And
Vibron allows one live agent session per extension, so a run is `deferred`
while the panel holds a conversation: "Run now" releases the panel's session
first, and an idle conversation is released after two minutes (it resumes on
the next send).

## Not yet

Pages are plain Markdown files: no visual editor, no search beyond the file
tree. A Dot cannot delegate to another Dot.

## Development

```bash
npm install
npm run build      # dist/ for sideloading
npm test
npm run typecheck
```

Sideload `extensions/vibron.dots` from Settings → Extensions → "Add local
folder…" after building, then enable it and open the Dots panel.
