# Contributing to CanvasIO

Thanks for your interest! A few ground rules keep CanvasIO safe for everyone.

## 🛡️ Security comes first

CanvasIO is an Electron desktop app shipped via signed auto-updates, so a malicious
change can reach every user's machine. **Maintainers: before you evaluate, approve or
merge ANY pull request, read the [Pull Request Security Review guide](docs/PR-SECURITY-REVIEW.md)
— it is a MUST READ** (poisoned CI, malicious deps/lockfiles, invisible-Unicode
obfuscation, Electron-specific risks + a reviewer checklist).

## Before opening a PR

- Keep the change **focused**; describe *what* and *why*. Unrelated edits to CI,
  dependencies, build scripts, or security code will be rejected or split out.
- Run locally: `npm install`, `npm test`, `npx tsc -p tsconfig.web.json --noEmit`,
  `npx tsc -p tsconfig.node.json --noEmit`, and `npm run build` — all must pass.
- **Do not** add `postinstall`/`preinstall` scripts or new dependencies without a clear
  justification. Don't hand-edit `package-lock.json`.
- No new `eval`/obfuscated code, no `innerHTML` sinks, no weakening of Electron
  `webPreferences`/CSP/webview guards, no new credential/network/`exec` paths.

## Reporting a vulnerability

Please report security issues **privately** (e.g. GitHub Security Advisories) rather than
in a public issue, so a fix can ship before disclosure.
