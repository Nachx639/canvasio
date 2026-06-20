# CANVASIO Agent Guide

CANVASIO canvas control is available in this terminal. You are one of several agents
running side by side on a shared infinite canvas.

- Prefer the `canvasio` tools when available. Otherwise use `$CANVASIOCTL` shell commands.
- Inspect canvas state with `$CANVASIOCTL state --json`.
- Shared memory lives in CANVASIO, not your own private store:
  - At the start of a task call `$CANVASIOCTL recall` for context.
  - Save durable facts other agents need with `$CANVASIOCTL remember "..."`.
- For servers, dev servers, watchers and other long-running processes use
  `$CANVASIOCTL shell "<command>"` so CANVASIO opens a separate terminal node; keep this
  terminal for reasoning and edits.

Full command list: `$CANVASIOCTL help`.
