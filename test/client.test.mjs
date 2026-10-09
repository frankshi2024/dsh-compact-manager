import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/** The platform seed table: the only bare specifiers a client bundle may require. */
const SEEDS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** Run the classic-script bundle under a fake module loader and capture its factory. */
async function loadBundle() {
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) {
        captured = registration
      },
    },
  }
  await import(`../lib/client.js?test=${Date.now()}`)
  assert.ok(captured, 'the bundle must call window.__ModuleLoader__.load')
  return captured
}

/** Minimal Cordis client context that records slot and locale registrations. */
function fakeContext() {
  const calls = { locale: [], inject: [], register: [], effects: [] }
  const ctx = {
    locale: {
      register: (ns, dictionaries) => {
        calls.locale.push({ ns, dictionaries })
        return () => {}
      },
      bind: (ns) => (key) => `${ns}:${key}`,
      current: () => 'zh',
    },
    slots: {
      inject: (name, factory) => {
        calls.inject.push(name)
        const disposer = factory()
        return disposer
      },
      register: (options, component) => {
        calls.register.push({ options, component })
        return () => {}
      },
    },
    effect: (factory) => {
      calls.effects.push(factory)
      // Cordis runs the effect body immediately and keeps the returned disposer.
      const disposer = factory()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
  return { ctx, calls }
}

test('the bundle registers under the exact package name', async () => {
  const registration = await loadBundle()
  assert.equal(registration.id, manifest.name)
  assert.equal(typeof registration.factory, 'function')
})

test('the factory only requires platform seed specifiers', async () => {
  const registration = await loadBundle()
  const required = []
  const module = registration.factory((specifier) => {
    required.push(specifier)
    assert.ok(SEEDS.has(specifier), `client bundle required a non-seed specifier: ${specifier}`)
    return {}
  })
  assert.deepEqual(required, ['react'])
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots', 'locale'])
})

test('apply registers the sidebar row and its matching main page', async () => {
  const registration = await loadBundle()
  const module = registration.factory(() => ({ createElement: () => null }))
  const { ctx, calls } = fakeContext()
  module.apply(ctx)

  assert.deepEqual(calls.inject.sort(), ['main', 'sidebar.panellist'])
  assert.equal(calls.locale.length, 1)
  assert.equal(calls.locale[0].ns, 'compactManager')
  assert.ok(calls.locale[0].dictionaries.zh.panel)
  assert.ok(calls.locale[0].dictionaries.en.panel)

  const panel = calls.register.find((entry) => entry.options.name === 'sidebar.panellist')
  const main = calls.register.find((entry) => entry.options.name === 'main')
  assert.ok(panel, 'sidebar.panellist must be registered')
  assert.ok(main, 'main must be registered')

  // ui-layout throws when a selected panel id has no main registration, so the
  // two ids must agree.
  assert.equal(panel.options.id, main.options.key)
  assert.equal(typeof panel.options.label, 'function')
  assert.equal(panel.options.label(), 'compactManager:panel')
  assert.equal(typeof panel.component, 'function')
  assert.equal(typeof main.component, 'function')
  assert.equal(main.options.locale, 'compactManager')
  assert.equal(typeof main.options.inject, 'function')
  assert.ok(calls.effects.length >= 1)
})

test('the manifest declares the bundle and client contract the host requires', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh?.client?.inject))
  assert.ok(manifest.exports['./client'])
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch must ship in files')
  assert.ok(manifest.files.includes('lib/client.js'))
  assert.ok(!Object.keys(manifest.dependencies ?? {}).some((name) => name.startsWith('@deepseek-ai/')),
    'dsh packages must be peers, never dependencies')
})
