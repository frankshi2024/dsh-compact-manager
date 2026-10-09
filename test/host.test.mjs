import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const LIB = new URL('../lib/', import.meta.url)

async function importsOf(file) {
  const source = await readFile(new URL(file, LIB), 'utf8')
  const specifiers = []
  const pattern = /(?:^|\n)\s*import\s+(?:[^'"]*?from\s*)?['"]([^'"]+)['"]/g
  let match
  while ((match = pattern.exec(source)) !== null) specifiers.push(match[1])
  return specifiers
}

test('every relative import inside lib/ resolves to a shipped file', async () => {
  for (const file of ['index.js', 'schema.js', 'policy.js']) {
    for (const specifier of await importsOf(file)) {
      if (!specifier.startsWith('.')) continue
      const target = resolve(dirname(fileURLToPath(new URL(file, LIB))), specifier)
      await assert.doesNotReject(access(target), `${file} imports ${specifier}, which does not exist`)
    }
  }
})

test('the host half only imports services the base profile mounts', async () => {
  const specifiers = await importsOf('index.js')
  assert.ok(specifiers.includes('./policy.js'))
  assert.ok(specifiers.includes('./schema.js'))
  for (const specifier of specifiers.filter((value) => value.startsWith('@deepseek-ai/'))) {
    assert.ok([
      '@deepseek-ai/dsh-storage-domain',
    ].includes(specifier), `unexpected host dependency ${specifier}`)
  }
})

test('the host half declares the services it uses', async () => {
  const source = await readFile(new URL('index.js', LIB), 'utf8')
  assert.match(source, /export const inject = \['storageDomain', 'connection', 'llm'\]/)
  assert.match(source, /export const name = 'compact-manager'/)
  // The shipped Web composition keeps compaction on the per-preset plane, so the
  // hook decorates the exported class prototype instead of injecting the service.
  assert.match(source, /import\('@deepseek-ai\/dsh-compaction-basic'\)/)
  assert.match(source, /prototype\.compactIfNeeded = patched/)
  assert.doesNotMatch(source, /ctx\.inject\(\['compaction'/)
})

test('the host half patches the prototype without breaking the overflow path', async () => {
  const source = await readFile(new URL('index.js', LIB), 'utf8')
  assert.match(source, /if \(trigger === 'pressure'\)/)
  assert.match(source, /return previous\.call\(this, agent, trigger, signal\)/)
  // A shared marker keeps reloaded module instances from stacking wrappers.
  assert.match(source, /Symbol\.for\('dsh\.compact-manager\.hook'\)/)
})
