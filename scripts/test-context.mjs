import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/context.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { buildTerminalContext, redactText, redactContext, redactValue } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const session = {
    id: 'fixture-session', title: 'Fixture SSH', kind: 'ssh', host: 'fixture.invalid', shell: 'bash', cwd: '/srv/app',
    lines: ['actual failure: exit 127', ...Array.from({ length: 29 }, (_, i) => `output ${i}`)],
    selectedText: 'selected diagnostic\npassword="fixture password with spaces"',
    lastCommand: { command: 'ls /srv/app', exitCode: 0, output: ['first.txt', 'last.txt'] },
    lastFailedCommand: { command: 'missing-command --token "fixture secret with spaces"', exitCode: 127, output: ['missing-command: not found'] },
}

const recent = buildTerminalContext(session, 'recent')
assert.equal(recent.available, true)
assert.ok(recent.text.includes('actual failure: exit 127'), 'the 30-line failure fixture is no longer silently reduced to 20 lines')
for (const value of ['Fixture SSH', 'fixture.invalid', 'bash', '/srv/app', '最近输出']) assert.ok(recent.text.includes(value))
const selected = buildTerminalContext(session, 'selected')
assert.ok(selected.text.includes('selected diagnostic'))
assert.equal(selected.text.includes('fixture password'), false)
assert.equal(selected.text.includes('actual failure'), false)
const failed = buildTerminalContext(session, 'last_failed')
assert.ok(failed.text.includes('退出码：127'))
assert.ok(failed.text.includes('missing-command: not found'))
assert.equal(failed.text.includes('fixture secret'), false)
const command = buildTerminalContext(session, 'last_command')
assert.ok(command.text.includes('退出码：0'))
assert.ok(command.text.includes('first.txt\nlast.txt'))
assert.equal(command.text.includes('missing-command'), false)

assert.equal(buildTerminalContext(null, 'recent').available, false)
assert.equal(buildTerminalContext({ ...session, selectedText: '' }, 'selected').available, false)
assert.equal(buildTerminalContext({ ...session, lastFailedCommand: undefined }, 'last_failed').available, false)
assert.equal(buildTerminalContext({ ...session, lastFailedCommand: session.lastCommand }, 'last_failed').available, false)
const unknownExit = buildTerminalContext({ ...session, lastCommand: { command: 'pending', output: 'pending output' } }, 'last_command')
assert.ok(unknownExit.text.includes('退出码：未捕获'))
assert.ok(unknownExit.warning.includes('未捕获'))

const key = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'SYNTHETICKEYBODY', '-----END OPENSSH PRIVATE KEY-----']
assert.equal(redactContext(key).includes('SYNTHETICKEYBODY'), false, 'redaction must span lines before applying the legacy window')
assert.equal(redactText('prefix\n-----BEGIN RSA PRIVATE KEY-----\nINCOMPLETEKEYBODY').includes('INCOMPLETEKEYBODY'), false)
const keyBeforeWindow = buildTerminalContext({ ...session, lines: [...key, 'safe final line'] }, 'recent', { recentLines: 2 })
assert.equal(keyBeforeWindow.text.includes('SYNTHETICKEYBODY'), false)
const serializedKey = JSON.stringify({ payload: key.join('\n') })
assert.equal(redactText(serializedKey).includes('SYNTHETICKEYBODY'), false)

const secretFixtures = [
    ['password=\'prefix\'"fixture-secret-tail"', 'fixture-secret-tail'],
    ['password=prefix\\ fixture-secret-tail', 'fixture-secret-tail'],
    ['token=fixture-value', 'fixture-value'],
    ['DATABASE_PASSWORD="fixture with spaces"', 'fixture with spaces'],
    ['{"api_key":"fixture value with spaces"}', 'fixture value with spaces'],
    ["secret='fixture value'", 'fixture value'],
    ['Authorization: Bearer fixture-bearer-token', 'fixture-bearer-token'],
    ['Authorization: Basic Zml4dHVyZTphYmNk', 'Zml4dHVyZTphYmNk'],
    ['curl --password "fixture with spaces"', 'fixture with spaces'],
    ['curl https://fixture-user:fixture-pass@fixture.invalid', 'fixture-pass'],
    ['sk-proj-fixture123456789', 'fixture123456789'],
    ['github_pat_fixture123456789', 'fixture123456789'],
]
for (const [text, secret] of secretFixtures) assert.equal(redactText(text).includes(secret), false, text)
assert.equal(redactText('normal error: file not found\nls -la /srv'), 'normal error: file not found\nls -la /srv')
assert.deepEqual(redactValue({ token: 'private-field', content: [{ text: 'password=private-inline\nuseful next line' }] }), { token: '***', content: [{ text: 'password=***\nuseful next line' }] })

const limited = buildTerminalContext({ ...session, lastCommand: { command: 'ls', exitCode: 0, output: 'abc'.repeat(50) } }, 'last_command', { maxCharacters: 12 })
assert.ok(limited.text.endsWith('abc'.repeat(4)))
assert.ok(limited.text.includes('前文已截断'))
assert.ok(limited.text.includes('命令：ls'))
assert.ok(limited.text.includes('工作目录：/srv/app'))
assert.ok(limited.warning.includes('长度限制'))
console.log('AI 上下文四种来源、主机/Shell/cwd、多行脱敏、空来源与显式截断回归通过')
