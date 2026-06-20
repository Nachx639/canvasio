# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub Security Advisories](https://github.com/Nachx639/canvasio/security/advisories/new)
(or a private channel) rather than a public issue, so a fix can ship before disclosure.

## Security posture (summary)

- Electron hardening: `contextIsolation: true`, `nodeIntegration: false`, strict
  navigation/webview guards, CSP without `unsafe-eval`, sanitized Markdown links.
- The renderer↔main bridge (`window.canvasio.*`) is a pure `contextBridge`; `fs` access
  is realpath/symlink-safe with a credential denylist; `git`/process calls use argv
  arrays (no shell), with validated tokens.
- The autonomous "Doctor" repair loop and any `git push` path are **disabled in
  packaged builds** (developer-mode opt-in only).
- The voice brain treats the canvas/agent CONTEXT as **untrusted data, never
  instructions** (prompt-injection boundary); untrusted text is neutralized before it
  reaches the model.

See [docs/PR-SECURITY-REVIEW.md](docs/PR-SECURITY-REVIEW.md) — **required reading before
reviewing or merging any pull request**.

## Hardening backlog (known, non-blocking)

- **Human confirmation for high-impact voice writes (R2):** voice actions that write to a
  terminal (`send_to_agent`, `answer_blocked`, `relay`, `reconcile`, `agent_auto`) execute
  without an explicit confirm step. The prompt-injection vector is already closed (the
  brain is instructed that CONTEXT is data and untrusted text is neutralized), so this is
  defense-in-depth: a future "preview/confirm" gate (or an anti-echo guard that refuses to
  execute a write whose text echoes CONTEXT content) would further reduce risk for users
  who run untrusted agents. Tracked for a post-launch release.
- **Per-artifact checksums** for user-installed model/voice downloads (currently TLS-only).
- **Electron sandbox** (`sandbox: true`) once the preload is built as CommonJS.
