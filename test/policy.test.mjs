import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ITEM_FALLBACK,
  POLICY_ITEMS,
  builtinThreshold,
  computeThreshold,
  defaultDocument,
  matchTier,
  normalizeDocument,
  resolvePolicy,
  resolveRow,
  validateDocument,
} from '../lib/policy.js'

const K = 1024
const W256 = 256 * K // 262144
const O128 = 128 * K // 131072

test('an empty document leaves every route on the built-in policy', () => {
  const document = defaultDocument()
  const row = resolveRow(document, { provider: 'kimi-coding', model: 'k3-256k' }, W256, O128)
  assert.equal(row.threshold, null)
  assert.equal(row.winner, null)
  assert.deepEqual(row.candidates, [])
  assert.equal(row.absoluteIgnored, false)
  assert.equal(row.builtin, 65536)
})

test('the built-in threshold reproduces the shipped formula', () => {
  // floor(min(W * 0.8, W - O - 65536))
  assert.equal(builtinThreshold(W256, O128), 65536)
  assert.equal(builtinThreshold(1_000_000, 256_000), 678_464)
  assert.equal(builtinThreshold(1_000_000, 65_536), 800_000)
  assert.equal(builtinThreshold(0, 0), undefined)
})

test('a tier matches a window inside ±5% of its value', () => {
  const tiers = [{ window: W256 }]
  assert.equal(matchTier(tiers, W256)?.window, W256)
  assert.equal(matchTier(tiers, 250_000)?.window, W256) // 4.6% off
  assert.equal(matchTier(tiers, Math.floor(W256 * 1.049))?.window, W256) // inside 5%
  assert.equal(matchTier(tiers, Math.ceil(W256 * 1.051)), undefined) // outside 5%
  assert.equal(matchTier(tiers, 230_000), undefined) // 12.3% off
  assert.equal(matchTier([], W256), undefined)
})

test('the closest tier wins when several bands overlap', () => {
  const tiers = [{ window: 262_144 }, { window: 250_000 }]
  assert.equal(matchTier(tiers, 252_000)?.window, 250_000)
  assert.equal(matchTier(tiers, 260_000)?.window, 262_144)
})

test('normalization materializes every item as an explicit on/off choice', () => {
  const document = normalizeDocument({ global: { ratio: { enabled: true, value: 0.8 } } })
  assert.deepEqual(Object.keys(document.global).sort(), [...POLICY_ITEMS].sort())
  assert.deepEqual(document.global.ratio, { enabled: true, value: 0.8 })
  assert.deepEqual(document.global.outputAware, { enabled: false, value: ITEM_FALLBACK.outputAware })
  assert.deepEqual(document.global.fixed, { enabled: false, value: ITEM_FALLBACK.fixed })
  assert.deepEqual(document.global.absolute, { enabled: false, value: ITEM_FALLBACK.absolute })
})

test('a higher layer replaces the layer below instead of inheriting from it', () => {
  // The tier states ratio only, so the global ratio is replaced by the tier's
  // own decision and every other item stays off at that tier.
  const document = normalizeDocument({
    global: { ratio: { enabled: true, value: 0.8 } },
    tiers: [{ window: W256, policy: { ratio: { enabled: true, value: 0.7 } } }],
  })
  const { items, layers } = resolvePolicy(document, { provider: 'kimi-coding', model: 'k3-256k' }, W256)
  assert.equal(items.ratio.value, 0.7)
  assert.equal(items.ratio.enabled, true)
  assert.equal(items.fixed.enabled, false)
  assert.deepEqual(layers, { global: true, tier: W256, model: false })
  assert.equal(resolveRow(document, { provider: 'kimi-coding', model: 'k3-256k' }, W256, O128).threshold, 183_500)
})

test('a tier can switch off an item the global layer enabled', () => {
  // The trap this guards: a global `outputAware` item crushes the threshold on a
  // route with a large output reservation.
  const document = normalizeDocument({
    global: { ratio: { enabled: true, value: 0.8 }, outputAware: { enabled: true, value: 32768 } },
    tiers: [{ window: W256, policy: { ratio: { enabled: true, value: 0.8 } } }],
  })
  const row = resolveRow(document, { provider: 'kimi-coding', model: 'k3-256k' }, W256, O128)
  assert.equal(row.threshold, 209_715)
  assert.equal(row.winner, 'ratio')
  assert.deepEqual(row.candidates.map((candidate) => candidate.item), ['ratio'])

  // Without the tier the dangerous item still dominates.
  const inherited = resolveRow({ ...document, tiers: [] }, { provider: 'kimi-coding', model: 'k3-256k' }, W256, O128)
  assert.equal(inherited.threshold, 98_304)
  assert.equal(inherited.winner, 'outputAware')
})

test('the threshold is the floored minimum of the enabled items', () => {
  const merged = {
    ratio: { enabled: true, value: 0.8 },
    fixed: { enabled: true, value: 32768 },
    outputAware: { enabled: false, value: 0 },
    absolute: { enabled: false, value: 0 },
  }
  const result = computeThreshold(merged, W256, O128)
  assert.equal(result.threshold, 209_715) // floor(262144 * 0.8)
  assert.equal(result.winner, 'ratio')
  assert.deepEqual(result.candidates, [
    { item: 'ratio', value: 209_715 },
    { item: 'fixed', value: 229_376 },
  ])

  const fixed = computeThreshold({ ratio: { enabled: true, value: 0.9 }, fixed: { enabled: true, value: 32768 } }, W256, O128)
  assert.equal(fixed.threshold, 229_376)
  assert.equal(fixed.winner, 'fixed')
})

test('the output-aware item subtracts the routed reservation', () => {
  const result = computeThreshold({ outputAware: { enabled: true, value: 32768 } }, W256, O128)
  assert.equal(result.threshold, 98_304) // 262144 - 131072 - 32768
  assert.equal(result.winner, 'outputAware')
})

test('an absolute threshold below the window overrides the other three', () => {
  const items = {
    ratio: { enabled: true, value: 0.8 },
    outputAware: { enabled: true, value: 32768 },
    fixed: { enabled: true, value: 32768 },
    absolute: { enabled: true, value: 150_000 },
  }
  const result = computeThreshold(items, W256, O128)
  // 150000 is larger than the smallest of the others (98304) yet still wins: the
  // absolute item is an override, not another candidate in the minimum.
  assert.equal(result.threshold, 150_000)
  assert.equal(result.winner, 'absolute')
  assert.deepEqual(result.candidates, [{ item: 'absolute', value: 150_000 }])
  assert.equal(result.absoluteIgnored, false)
})

test('an absolute threshold at or above the window is ignored and reported', () => {
  const ignored = computeThreshold({
    ratio: { enabled: true, value: 0.8 },
    absolute: { enabled: true, value: W256 },
  }, W256, O128)
  assert.equal(ignored.threshold, 209_715)
  assert.equal(ignored.winner, 'ratio')
  assert.equal(ignored.absoluteIgnored, true)

  // Nothing else enabled: the override is still reported as ignored rather than
  // silently deciding something.
  const alone = computeThreshold({ absolute: { enabled: true, value: W256 + 1 } }, W256, O128)
  assert.equal(alone.threshold, null)
  assert.equal(alone.absoluteIgnored, true)

  const row = resolveRow(normalizeDocument({
    global: { absolute: { enabled: true, value: 999_999 } },
  }), { provider: 'p', model: 'm' }, W256, O128)
  assert.equal(row.threshold, null)
  assert.equal(row.absoluteIgnored, true)
})

test('an item that never enables is ignored, and impossible results are refused', () => {
  assert.equal(computeThreshold({ ratio: { enabled: false, value: 0.8 } }, W256, O128), undefined)
  assert.equal(computeThreshold({}, W256, O128), undefined)
  assert.equal(computeThreshold({ fixed: { enabled: true, value: 300_000 } }, W256, O128), undefined)
  assert.equal(computeThreshold({ ratio: { enabled: true, value: 0.8 } }, undefined, 0), undefined)
})

test('the recommended 256K preset resolves to the requested formula', () => {
  const document = normalizeDocument({
    global: { ratio: { enabled: true, value: 0.8 } },
    tiers: [{ window: W256, policy: { ratio: { enabled: true, value: 0.8 }, fixed: { enabled: true, value: 32768 } } }],
  })
  const row = resolveRow(document, { provider: 'kimi-coding', model: 'k3-256k' }, W256, O128)
  // floor(min(262144 × 0.8, 262144 − 32768)) = 209715, versus the built-in 65536
  assert.equal(row.threshold, 209_715)
  assert.equal(row.winner, 'ratio')
  assert.equal(row.builtin, 65_536)

  // A 1M route outside the tier keeps only the global ratio.
  const wide = resolveRow(document, { provider: 'deepseek-official', model: 'deepseek-flash' }, 1_000_000, 256_000)
  assert.equal(wide.threshold, 800_000)
  assert.equal(wide.layers.tier, null)
})

test('normalization keeps valid entries and drops junk', () => {
  const document = normalizeDocument({
    global: { ratio: { enabled: true, value: 0.8 }, bogus: { enabled: true, value: 1 }, fixed: { enabled: true, value: 'x' } },
    tiers: [{ window: W256, policy: {} }, { window: -1 }, 'nope'],
    models: [{ provider: 'p', model: 'm', policy: {} }, { provider: '', model: 'm' }],
  })
  assert.equal(document.global.ratio.enabled, true)
  assert.equal(document.global.fixed.enabled, false)
  assert.equal(document.global.fixed.value, ITEM_FALLBACK.fixed)
  assert.equal(document.global.bogus, undefined)
  assert.equal(document.tiers.length, 1)
  assert.equal(document.models.length, 1)
  assert.deepEqual(Object.keys(document.tiers[0].policy).sort(), [...POLICY_ITEMS].sort())
})

test('validation reports every structural problem it can see', () => {
  assert.deepEqual(validateDocument(null), ['document must be an object'])
  assert.deepEqual(validateDocument({}), [])

  const issues = validateDocument({
    global: {
      ratio: { enabled: true, value: 1.4 },
      absolute: { enabled: true, value: 0 },
      unknown: { enabled: true, value: 1 },
    },
    tiers: [{ window: W256 }, { window: W256 }, { window: 0 }],
    models: [
      { provider: 'p', model: 'm', policy: {} },
      { provider: 'p', model: 'm', policy: {} },
      { provider: 'p' },
    ],
    extra: true,
  })
  const joined = issues.join('\n')
  assert.match(joined, /unknown keys: extra/)
  assert.match(joined, /global\.unknown is not a known item/)
  assert.match(joined, /ratio\.value must be greater than 0 and less than 1/)
  assert.match(joined, /absolute\.value must be a positive token count/)
  assert.match(joined, /tiers\[1\]\.window duplicates/)
  assert.match(joined, /tiers\[2\]\.window must be a positive integer/)
  assert.match(joined, /models\[1\] duplicates p\/m/)
  assert.match(joined, /models\[2\]\.model must be a non-empty string/)
})

test('validation accepts a well-formed document', () => {
  assert.deepEqual(validateDocument({
    global: { ratio: { enabled: true, value: 0.8 }, absolute: { enabled: false, value: 131072 } },
    tiers: [{ window: W256, policy: { fixed: { enabled: true, value: 32768 } } }],
    models: [{ provider: 'kimi-coding', model: 'k3-256k', policy: { outputAware: { enabled: true, value: 4096 } } }],
  }), [])
})
