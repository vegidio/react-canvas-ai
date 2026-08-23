# Playground

A Vite dev app for exercising `react-canvas-ai` against the workspace copy of the library
(`react-canvas-ai: workspace:*`), not a published release. It is private and excluded from
the changesets release.

## Running it

From the repository root:

```bash
pnpm install
pnpm --filter react-canvas-ai build   # the playground imports the built package
pnpm --filter playground dev          # http://localhost:3000
```

Re-run the library build after changing `packages/react-canvas-ai/src`.

## What it covers

- `src/App.tsx` — the full `<MaskEditor />` surface: mask colour, brush size, zoom and pan
  sliders, the imperative `canvasRef` API (undo, redo, clear, zoom, reset, pan), and an
  original / extracted-mask / overlay comparison strip.
- `src/MaskEditorProviderExample.tsx` — the headless `MaskEditorProvider` pattern, laying
  out the three canvas layers by hand and driving them from context.

## Toolchain

Linting and formatting come from the repository-root Biome config (`biome.json`) — there is
no ESLint or Prettier setup here. Run `pnpm check` from the root.
