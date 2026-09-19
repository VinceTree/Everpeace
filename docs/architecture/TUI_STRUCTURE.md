# TUI Source Structure

`src/tui` is organized by responsibility rather than keeping every component and helper in one flat directory. This is a source-layout boundary only: it does not change the inline terminal model, Session persistence, command semantics, or rendering behavior.

```text
src/tui/
├── index.tsx                  # public render/terminal entrypoint
├── app/                       # application state machine and dependency contracts
│   ├── app.tsx
│   ├── dependencies.ts
│   └── types.ts
├── commands/                  # slash-command catalog and parsing
├── composer/                  # editor state and prompt input UI
├── components/
│   ├── conversation/          # banner, transcript, and chat status
│   ├── feedback/              # tool approval and confirmation prompts
│   ├── navigation/            # model, permission, and session selection
│   ├── screens/               # shared full command-window surfaces
│   └── wizards/               # multi-step login, logout, Skill, and terminal setup
├── rendering/                 # width, history, Markdown, syntax, and diff presentation
└── terminal/                  # terminal configuration file operations
```

## Dependency direction

- `index.tsx` constructs dependencies and mounts `app/app.tsx`.
- `app/` owns view selection, Session lifecycle, running task state, and composition of all UI areas.
- `components/` may use application contracts from `app/types.ts`, but does not own persistence or Agent lifecycle.
- `composer/`, `commands/`, and `rendering/` expose reusable input or presentation behavior and do not create application services.
- `terminal/` contains filesystem operations; the corresponding interactive screen remains under `components/wizards/`.
- New files should enter the narrowest matching responsibility directory. Do not recreate a flat `components` catch-all.

The large application state machine remains in `app/app.tsx` so this reorganization stays behavior-preserving. Future extraction from that file should follow state ownership and include dedicated regression tests rather than splitting it by arbitrary line count.
