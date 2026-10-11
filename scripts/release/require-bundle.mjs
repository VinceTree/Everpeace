// Plain npm/pnpm pack must not distribute the unpatched registry dependency.
throw new Error("Use pnpm build, then pnpm pack:release --output <directory> to create a verified native bundle");
