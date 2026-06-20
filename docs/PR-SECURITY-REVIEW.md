# 🛡️ Pull Request Security Review — MUST READ

> **Read this before evaluating, approving, or merging ANY pull request** — especially
> one from a fork, a first-time contributor, or an automated/AI agent. Open-source
> projects are now attacked *through their normal contribution workflow*, not around it.
> A single careless merge can hand an attacker your CI secrets, your npm publish rights,
> or code execution on every user's machine.

CanvasIO is a high-value target shape: an **Electron desktop app** (a malicious change
runs on end users' machines with `window.canvasio` IPC: fs, pty, git), distributed via
**signed GitHub releases + auto-update** (a poisoned release ships to everyone), built
from **npm** dependencies and **GitHub Actions**. Treat every external contribution as
untrusted until proven otherwise.

---

## Why this is urgent (recent real-world incidents)

- **`tj-actions/changed-files` (Mar 2025):** a cascading compromise — vulnerable workflow → leaked PAT → poisoned Action — affected **23,000+ repositories**.
- **Trivy / Aqua Security (2025–2026):** an automated bot exploited a misconfigured `pull_request_target` workflow to steal an **org-scoped PAT** used across 33+ workflows.
- **Grafana Labs (Apr 2025):** a malicious PR with a crafted **branch name** triggered a script-injection in a `pull_request_target` workflow → repo access + extortion.
- **TanStack (2026):** a "Pwn Request" + Actions **cache poisoning** across the fork↔base trust boundary + OIDC token theft → **84 malicious versions across 42 packages**. TanStack publicly weighed moving to **invitation-only PRs**.
- **npm dependency-confusion & postinstall campaigns (2025–2026):** dozens of malicious packages profiling dev environments via `postinstall` hooks; invisible-Unicode malware (Aikido found 151 malicious GitHub packages in a single week).

Maintainers also report a **DoS by volume** of AI-generated PRs/bug-reports — exhaustion is itself an attack vector that leads to careless approvals.

---

## The threat catalog

### 1. CI / GitHub Actions abuse (highest impact)
- **`pull_request_target` "Pwn Request":** runs in the **base** repo context **with secrets**, but can be tricked into executing **untrusted fork code** (if the workflow checks out & runs PR head). This is the #1 way fork PRs steal secrets.
- **Script injection** via attacker-controlled `github.event.*` fields (PR **title**, **body**, **branch name**, commit message) interpolated into `run:` blocks.
- **Poisoned pipeline / cache poisoning** across the fork→base trust boundary; **OIDC token** extraction from runner memory.
- **Mutable action tags** (`@v4`) silently repointed to malicious commits.

### 2. Dependency / supply-chain (via `package.json` / lockfile)
- **Malicious `postinstall`/`preinstall` scripts** that run on `npm install` with your permissions.
- **Typosquatting** (`axois` vs `axios`) and **dependency confusion** (public package shadowing an internal name).
- **Lockfile poisoning:** a `package-lock.json` edit that pins a dependency to a malicious version/registry, or adds a dep with an **install script**, without an obvious `package.json` change.
- **Compromised transitive dep** or sudden **maintainer/ownership change**.

### 3. Source-level obfuscation (defeats eyeballing)
- **Invisible Unicode** (Private-Use-Area / zero-width chars): malicious code that renders as **blank space** in every editor — normal review and most SAST are "nearly useless" against it.
- **Homoglyphs:** ASCII letters swapped for identical-looking Unicode in identifiers/strings.
- **Bidirectional (Trojan Source):** RTL/LTR control chars that make code read differently than it executes.
- **Minified/encoded blobs**, `eval`/`new Function`, base64, or "data" payloads decoded at runtime.

### 4. Electron / app-specific (CanvasIO)
- A change that **weakens `webPreferences`** (`contextIsolation`, `nodeIntegration`, `sandbox`, CSP), the **webview navigation guards**, or the **preload bridge** surface.
- A new **`innerHTML`/`dangerouslySetInnerHTML`** sink, or unsanitized data reaching one (DOM-XSS → RCE in the privileged renderer).
- Re-enabling the autonomous **Doctor** loop in packaged builds, or exposing `git push` / `applyUpdate` to the renderer.
- New **`fs`/`pty`/`exec`/`spawn`** paths, network calls, or anything that reads credentials (`~/.ssh`, `~/.aws`, `~/.claude.json`).

---

## ✅ Reviewer checklist (run for EVERY PR before merge)

**Trust & scope**
- [ ] Is the author known/trusted? First-time / fork / bot PRs get **extra** scrutiny.
- [ ] Does the PR's **scope** match its description? Reject "tiny fix" PRs that also touch CI, deps, build scripts, or security code.
- [ ] Don't approve under time/volume pressure. When in doubt, **don't merge**.

**CI / workflows (`.github/`)**
- [ ] No new/edited `pull_request_target` or `workflow_run` that **checks out or runs PR head code**.
- [ ] No `github.event.*` (title/body/branch/commit) interpolated into `run:`/shell. Use env vars + quoting.
- [ ] Third-party Actions **pinned to a full commit SHA**, not a tag. Minimal `permissions:` (default `contents: read`).
- [ ] No new secret usage; secrets never exposed to fork-triggered jobs.

**Dependencies (`package.json` / `package-lock.json`)**
- [ ] Every added/changed dep is justified, reputable, and at a real version. Check for **typosquats**.
- [ ] Diff the **lockfile**: flag any dep that is **new AND has an install script** (`hasInstallScript`), or a registry/URL change.
- [ ] No added `postinstall`/`preinstall`/`prepare` scripts (this repo's only allowed one is the documented `node-pty` chmod).
- [ ] Run `npm audit` (NOT `--omit=dev`); confirm Electron stays on a patched line.

**Source code**
- [ ] Scan the diff for **invisible/hidden Unicode, homoglyphs, bidi control chars** (use a hidden-character detector / `git diff` with a Unicode-aware viewer; GitHub flags some bidi).
- [ ] No `eval`/`new Function`, dynamic `require`, base64/obfuscated blobs, or runtime-decoded payloads.
- [ ] No new `innerHTML`/`dangerouslySetInnerHTML`; untrusted data is sanitized before any DOM/style sink.
- [ ] No weakening of Electron `webPreferences`, CSP, webview guards, or the preload surface.
- [ ] No new `exec`/`spawn`/`shell:true`, network calls, file reads of credential paths, or `git push`/release paths.
- [ ] No telemetry/exfiltration, no hardcoded URLs/IPs, no secrets.

**Gates**
- [ ] CI (typecheck + tests + build) is green — **and** you read what CI actually ran.
- [ ] For risky PRs, check out and review **locally in a sandbox/VM**; never run an untrusted PR's `postinstall` on your main machine.

---

## Repo guardrails (configure once)

- **Branch protection on `main`:** require PR + at least one review, require status checks, no direct pushes, no force-push. Only the owner merges.
- **`CODEOWNERS`** so security-sensitive paths (`.github/`, `src/main/`, `package.json`, `electron-builder.yml`) require owner review.
- **Pin all Actions to SHAs**; set repo-wide default workflow `permissions: read`.
- **Require approval to run workflows** for first-time / fork contributors (GitHub setting).
- Keep **releases owner-only + signed/notarized**; never let an unverified build reach the auto-update feed.
- Consider a **secret scanner** (e.g. gitleaks) and **Dependabot/Renovate** with review.
- If PR volume becomes an attack in itself, consider **invitation-only / triaged contributions** (as TanStack did).

---

## Sources

- [Hardening GitHub Actions: Lessons from Recent Attacks — Wiz](https://www.wiz.io/blog/github-actions-security-guide)
- [GitHub Security Lab — Preventing pwn requests](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)
- [Actions `pull_request_target` & environment branch-protection changes — GitHub Changelog](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/)
- [tj-actions/changed-files supply-chain attack — Unit 42 (Palo Alto)](https://unit42.paloaltonetworks.com/github-actions-supply-chain-attack/)
- [Trivy GitHub Actions supply-chain compromise — Snyk](https://snyk.io/articles/trivy-github-actions-supply-chain-compromise/)
- [TanStack weighs invitation-only PRs after supply-chain attack — The Register](https://www.theregister.com/security/2026/05/18/tanstack-weighs-invitation-only-pull-requests-after-supply-chain-attack/5241899)
- [TanStack npm supply-chain compromise postmortem](https://tanstack.com/blog/npm-supply-chain-compromise-postmortem)
- [Grafana Labs GitHub Actions breach — Rescana](https://www.rescana.com/post/grafana-labs-github-actions-breach-code-repositories-accessed-and-extortion-attempted-via-misconfigured-ci-cd-workflow)
- [pull_request_nightmare Part 2 — Orca Security](https://orca.security/resources/blog/pull-request-nightmare-part-2-exploits/)
- [Defending against npm supply-chain attacks — ArmorCode](https://www.armorcode.com/blog/defending-against-npm-supply-chain-attacks-a-practical-guide)
- [npm security best practices — lirantal](https://github.com/lirantal/npm-security-best-practices)
- [33 malicious npm packages abuse dependency confusion — Microsoft Security](https://www.microsoft.com/en-us/security/blog/2026/05/29/33-malicious-npm-packages-abuse-dependency-confusion-profile-developer-environments/)
- [Hidden invisible-Unicode malware in plain sight — technology.org](https://www.technology.org/2026/03/16/hackers-are-hiding-malicious-code-in-plain-sight-using-invisible-unicode-characters/)
- [Down the Rabbit Hole of Unicode Obfuscation — Veracode](https://www.veracode.com/blog/down-the-rabbit-hole-of-unicode-obfuscation/)
- [GitHub Actions security cheat sheet — GitGuardian](https://blog.gitguardian.com/github-actions-security-cheat-sheet/)
- [A retrospective survey of 2024/2025 OSS supply-chain compromises — Filippo Valsorda](https://words.filippo.io/compromise-survey/)
