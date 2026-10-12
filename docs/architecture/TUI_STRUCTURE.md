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
- `app/` owns view selection, host I/O for Session changes, and composition of UI areas. Each mount holds one [ApplicationCoordinator](../../src/runtime/application-coordinator.ts) for Session identity, mode, task admission/cancellation, pending approval, and command operation identity; React state projects it for display.
- `components/` may use application contracts from `app/types.ts`, but does not own persistence or Agent lifecycle.
- `composer/`, `commands/`, and `rendering/` expose reusable input or presentation behavior and do not create application services.
- `composer/` owns submission occupancy for its mounted input. It claims input synchronously before calling the host; successful completion may clear only that mount's unchanged draft snapshot. Unmount invalidates late callbacks, while host task admission, cancellation, attachment cleanup, and verified settlement remain outside the composer. See the [submission regressions](../../tests/unit/tui/prompt-submission.test.tsx).
- `terminal/` contains filesystem operations; the corresponding interactive screen remains under `components/wizards/`.
- New files should enter the narrowest matching responsibility directory. Do not recreate a flat `components` catch-all.

The coordinator has no React, Ink, or TUI dependency. `app/app.tsx` still adapts storage, workspace changes, prompts, approvals, direct PTY commands, and rendering; existing runner/workflow modules own resource cleanup and verified settlement. Cancellation keeps model-task admission occupied until cleanup completes. Session/Agent replacement invalidates old task identity and approved plans; host failures retain the prior identity. Further extraction should follow state ownership with regression tests, as established by the [coordinator tests](../../tests/unit/runtime/application-coordinator.test.ts), rather than arbitrary line count.
