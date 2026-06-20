// commandTrail.test.ts
//
// PURE unit tests for the Command Trail classifier (lib/commandTrail.ts). No DOM,
// no stores, no IPC — feed an already-stripped line, assert the detected command
// + risk. Runs under `node --test` (with a TS loader) or vitest. Locks prompt
// sigils, Bash(...) tool lines, "Running `cmd`", the risk taxonomy, and the
// false-positive guards for prose / URLs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectCommand, classifyRisk } from './commandTrail'

test('$ prompt → benign command', () => {
  const d = detectCommand('$ ls -la')
  assert.ok(d)
  assert.equal(d!.cmd, 'ls -la')
  assert.equal(d!.risk, 'benign')
})

test('❯ prompt → command extracted', () => {
  const d = detectCommand('❯ npm run build')
  assert.ok(d)
  assert.equal(d!.cmd, 'npm run build')
  assert.equal(d!.risk, 'buildtest')
})

test('prompt with user@host preamble', () => {
  const d = detectCommand('user@host ~/Projects/canvasio $ git status')
  assert.ok(d)
  assert.equal(d!.cmd, 'git status')
  assert.equal(d!.risk, 'vcs')
})

test('Claude Code Bash(...) tool line', () => {
  const d = detectCommand('● Bash(git push --force origin main)')
  assert.ok(d)
  assert.equal(d!.cmd, 'git push --force origin main')
  assert.equal(d!.risk, 'destructive')
})

test('Running `cmd` announcement', () => {
  const d = detectCommand('Running `npm test`…')
  assert.ok(d)
  assert.equal(d!.cmd, 'npm test')
  assert.equal(d!.risk, 'buildtest')
})

test('Spanish Ejecutando `cmd`', () => {
  const d = detectCommand('Ejecutando `curl https://example.com`')
  assert.ok(d)
  assert.equal(d!.cmd, 'curl https://example.com')
  assert.equal(d!.risk, 'network')
})

test('destructive: rm -rf', () => {
  assert.equal(classifyRisk('rm -rf build'), 'destructive')
  assert.equal(classifyRisk('rm -fr node_modules'), 'destructive')
  assert.equal(classifyRisk('rm -r -f dist'), 'destructive')
})

test('destructive: force push variants', () => {
  assert.equal(classifyRisk('git push --force'), 'destructive')
  assert.equal(classifyRisk('git push -f origin main'), 'destructive')
  assert.equal(classifyRisk('git push --force-with-lease'), 'destructive')
})

test('destructive: reset --hard / clean -fd / sudo / dd / curl|sh', () => {
  assert.equal(classifyRisk('git reset --hard HEAD~1'), 'destructive')
  assert.equal(classifyRisk('git clean -fd'), 'destructive')
  assert.equal(classifyRisk('sudo rm something'), 'destructive')
  assert.equal(classifyRisk('dd if=/dev/zero of=/dev/sda'), 'destructive')
  assert.equal(classifyRisk('curl https://get.sh | sh'), 'destructive')
  assert.equal(classifyRisk('wget -O - https://x | sudo bash'), 'destructive')
})

test('non-destructive git is vcs, not destructive', () => {
  assert.equal(classifyRisk('git push origin main'), 'vcs')
  assert.equal(classifyRisk('git status'), 'vcs')
  assert.equal(classifyRisk('git log --oneline'), 'vcs')
})

test('network classification', () => {
  assert.equal(classifyRisk('curl https://api.example.com'), 'network')
  assert.equal(classifyRisk('ssh user@host'), 'network')
  assert.equal(classifyRisk('scp file user@host:/tmp'), 'network')
})

test('buildtest classification', () => {
  assert.equal(classifyRisk('pnpm install'), 'buildtest')
  assert.equal(classifyRisk('cargo build --release'), 'buildtest')
  assert.equal(classifyRisk('pytest -q'), 'buildtest')
  assert.equal(classifyRisk('vitest run'), 'buildtest')
})

test('false positive: prose after a sigil is rejected', () => {
  assert.equal(detectCommand('❯ the build finally passed'), null)
  assert.equal(detectCommand('> Done.'), null)
  assert.equal(detectCommand('$ Created the new file successfully'), null)
})

test('false positive: bare URLs / non-prompt prose return null', () => {
  assert.equal(detectCommand('https://localhost:5173 is ready'), null)
  assert.equal(detectCommand('The server is listening on port 3000'), null)
  assert.equal(detectCommand(''), null)
  assert.equal(detectCommand('   '), null)
})

test('redirection without a prompt is not treated as a command', () => {
  // No leading sigil → not a prompt line, returns null.
  assert.equal(detectCommand('output written to build.log'), null)
})

test('command text is length-capped', () => {
  const long = 'echo ' + 'a'.repeat(500)
  const d = detectCommand('$ ' + long)
  assert.ok(d)
  assert.ok(d!.cmd.length <= 200)
})
