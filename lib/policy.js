/**
 * dsh-compact-manager — policy vocabulary and pure resolution math.
 *
 * This module is dependency-free on purpose: the host plugin, the tests, and any
 * future tooling can import it without touching Cordis, zod, or the storage
 * backend.
 *
 * A policy document has three layers, applied from low to high precedence:
 *
 *   1. `global`  — every route
 *   2. `tiers`   — routes whose context window is within ±{@link TIER_TOLERANCE}
 *                  of the tier's `window` (256K is 262144, K = 1024)
 *   3. `models`  — one exact `provider`/`model` route
 *
 * Each layer is a COMPLETE choice over four items — every item is either on or
 * off, and a higher layer replaces the whole lower layer rather than partly
 * inheriting from it:
 *
 *   ratio       W × v        context share
 *   outputAware W − O − v    context minus the route's output reservation, minus v
 *   fixed       W − v        context minus a fixed value
 *   absolute    v            a hard-coded threshold; when it is below W it wins
 *                            outright over the other three, and when it is not it
 *                            is ignored (callers surface that as a warning)
 *
 * Without `absolute`, the threshold is the floored minimum over the *enabled*
 * items. With no item enabled the manager stays out of the way and the built-in
 * `@deepseek-ai/dsh-compaction-basic` threshold applies unchanged.
 */

/** The selectable items, in document and UI order. */
export const POLICY_ITEMS = ['ratio', 'outputAware', 'fixed', 'absolute']

/** Values a layer falls back to when it has never mentioned an item. */
export const ITEM_FALLBACK = { ratio: 0.8, outputAware: 32768, fixed: 32768, absolute: 131072 }

/** Presentation metadata for the items (used by the HTTP API and the sidebar). */
export const POLICY_ITEM_META = [
  { id: 'ratio', label: { zh: '上下文 × 比例', en: 'Context × ratio' }, formula: 'W × v', unit: { zh: '比例', en: 'ratio' } },
  { id: 'outputAware', label: { zh: '上下文 − 输出预留 − 固定值', en: 'Context − reserve − fixed' }, formula: 'W − O − v', unit: { zh: 'tokens', en: 'tokens' } },
  { id: 'fixed', label: { zh: '上下文 − 固定值', en: 'Context − fixed' }, formula: 'W − v', unit: { zh: 'tokens', en: 'tokens' } },
  { id: 'absolute', label: { zh: '固定阈值（直接指定）', en: 'Absolute threshold' }, formula: 'v（小于 W 时覆盖其它项）', unit: { zh: 'tokens', en: 'tokens' } },
]

/** A context window within ±5% of a tier value counts as that tier. */
export const TIER_TOLERANCE = 0.05

/** k = 1024, so 256K is 262144. Exported for the docs and the UI. */
export const K = 1024

/** A fresh document: every item off, so the plugin changes nothing. */
export function defaultDocument() {
  return normalizeDocument({})
}

/** Coerce any JSON-shaped input into a well-formed document. Never throws. */
export function normalizeDocument(input) {
  const source = isRecord(input) ? input : {}
  return {
    global: normalizeLayer(source.global),
    tiers: Array.isArray(source.tiers)
      ? source.tiers.map(normalizeTier).filter((tier) => tier !== undefined)
      : [],
    models: Array.isArray(source.models)
      ? source.models.map(normalizeModel).filter((entry) => entry !== undefined)
      : [],
  }
}

/**
 * Materialize one layer.
 *
 * Every layer is COMPLETE: all {@link POLICY_ITEMS} appear with an explicit
 * on/off state, so what a layer shows is exactly what it means. A layer that
 * never mentioned an item reads as "off" with the fallback value, and a higher
 * layer therefore always overrides a lower one rather than partly inheriting
 * from it. "Inherit" is not a state a user can pick.
 */
function normalizeLayer(input) {
  const source = isRecord(input) ? input : {}
  const layer = {}
  for (const item of POLICY_ITEMS) {
    const raw = source[item]
    const value = isRecord(raw) ? asFiniteNumber(raw.value) : undefined
    // An item whose value cannot be read stays off rather than enabling a
    // fallback the record never asked for.
    layer[item] = {
      enabled: value !== undefined && raw.enabled === true,
      value: value ?? ITEM_FALLBACK[item],
    }
  }
  return layer
}

function normalizeTier(input) {
  if (!isRecord(input)) return undefined
  const window = asPositiveInteger(input.window)
  if (window === undefined) return undefined
  return { window, policy: normalizeLayer(input.policy) }
}

function normalizeModel(input) {
  if (!isRecord(input)) return undefined
  const provider = asNonEmptyString(input.provider)
  const model = asNonEmptyString(input.model)
  if (provider === undefined || model === undefined) return undefined
  return { provider, model, policy: normalizeLayer(input.policy) }
}

/**
 * Report every structural problem in a candidate document.
 * @param input - JSON-shaped candidate received from an API caller.
 * @returns human-readable issues; empty means the document is acceptable.
 */
export function validateDocument(input) {
  const issues = []
  if (!isRecord(input)) return ['document must be an object']
  const unknown = Object.keys(input).filter((key) => !['global', 'tiers', 'models'].includes(key))
  if (unknown.length > 0) issues.push(`document has unknown keys: ${unknown.join(', ')}`)
  if (input.global !== undefined) validateLayer(input.global, 'global', issues)
  if (input.tiers !== undefined) {
    if (!Array.isArray(input.tiers)) issues.push('tiers must be an array')
    else {
      const seen = new Set()
      input.tiers.forEach((tier, index) => {
        if (!isRecord(tier)) return issues.push(`tiers[${index}] must be an object`)
        const window = asPositiveInteger(tier.window)
        if (window === undefined) issues.push(`tiers[${index}].window must be a positive integer`)
        else if (seen.has(window)) issues.push(`tiers[${index}].window duplicates ${window}`)
        else seen.add(window)
        if (tier.policy !== undefined) validateLayer(tier.policy, `tiers[${index}].policy`, issues)
      })
    }
  }
  if (input.models !== undefined) {
    if (!Array.isArray(input.models)) issues.push('models must be an array')
    else {
      const seen = new Set()
      input.models.forEach((entry, index) => {
        if (!isRecord(entry)) return issues.push(`models[${index}] must be an object`)
        const provider = asNonEmptyString(entry.provider)
        const model = asNonEmptyString(entry.model)
        if (provider === undefined) issues.push(`models[${index}].provider must be a non-empty string`)
        if (model === undefined) issues.push(`models[${index}].model must be a non-empty string`)
        if (provider !== undefined && model !== undefined) {
          const key = `${provider}\u0000${model}`
          if (seen.has(key)) issues.push(`models[${index}] duplicates ${provider}/${model}`)
          else seen.add(key)
        }
        if (entry.policy !== undefined) validateLayer(entry.policy, `models[${index}].policy`, issues)
      })
    }
  }
  return issues
}

function validateLayer(layer, label, issues) {
  if (!isRecord(layer)) return issues.push(`${label} must be an object`)
  for (const [key, raw] of Object.entries(layer)) {
    if (!POLICY_ITEMS.includes(key)) {
      issues.push(`${label}.${key} is not a known item (${POLICY_ITEMS.join(', ')})`)
      continue
    }
    if (!isRecord(raw)) {
      issues.push(`${label}.${key} must be an object`)
      continue
    }
    if (typeof raw.enabled !== 'boolean') issues.push(`${label}.${key}.enabled must be a boolean`)
    if (asFiniteNumber(raw.value) === undefined) issues.push(`${label}.${key}.value must be a finite number`)
    if (key === 'ratio' && enabledValue(raw) !== undefined && (enabledValue(raw) <= 0 || enabledValue(raw) >= 1)) {
      issues.push(`${label}.ratio.value must be greater than 0 and less than 1`)
    }
    if ((key === 'fixed' || key === 'outputAware') && enabledValue(raw) !== undefined && enabledValue(raw) < 0) {
      issues.push(`${label}.${key}.value must not be negative`)
    }
    if (key === 'absolute' && enabledValue(raw) !== undefined && enabledValue(raw) <= 0) {
      issues.push(`${label}.absolute.value must be a positive token count`)
    }
  }
}

function enabledValue(raw) {
  return raw.enabled === true ? asFiniteNumber(raw.value) : undefined
}

/**
 * Pick the tier that owns one context window: the closest declared tier inside
 * the ±{@link TIER_TOLERANCE} band, or undefined when none is close enough.
 * @param tiers - normalized tier list.
 * @param window - resolved context window of the routed model.
 * @returns the matching tier, or undefined.
 */
export function matchTier(tiers, window) {
  if (!Array.isArray(tiers) || !Number.isFinite(window)) return undefined
  let best
  let bestDistance = Number.POSITIVE_INFINITY
  for (const tier of tiers) {
    if (!isRecord(tier) || !Number.isInteger(tier.window) || tier.window <= 0) continue
    const distance = Math.abs(window - tier.window)
    if (distance > tier.window * TIER_TOLERANCE) continue
    if (distance < bestDistance) {
      best = tier
      bestDistance = distance
    }
  }
  return best
}

/**
 * Merge the three layers for one route and report which layers contributed.
 * @param document - normalized policy document.
 * @param route - `{ provider, model }` of the routed request.
 * @param window - resolved context window, used for tier matching.
 * @returns `{ items, layers }`, where `items` maps each mentioned item to its winning definition.
 */
export function resolvePolicy(document, route, window) {
  const global = document?.global ?? {}
  const tier = matchTier(document?.tiers, window)
  const model = (document?.models ?? []).find(
    (entry) => entry.provider === route?.provider && entry.model === route?.model,
  )
  const items = {}
  const origins = { global: false, tier: tier === undefined ? null : tier.window, model: model !== undefined }
  for (const layer of [global, tier?.policy, model?.policy]) {
    if (!isRecord(layer)) continue
    for (const item of POLICY_ITEMS) {
      if (layer[item] !== undefined) items[item] = layer[item]
    }
  }
  origins.global = Object.keys(global).length > 0
  return { items, layers: origins }
}

/**
 * Evaluate the enabled items and take the floored minimum.
 * @param items - merged item definitions.
 * @param window - context window W.
 * @param reserveTokens - O, the routed request's output reservation.
 * @returns `{ threshold, winner, candidates, absoluteIgnored }`, or undefined when nothing decides.
 *          `absoluteIgnored` reports an enabled absolute value at or above W.
 */
export function computeThreshold(items, window, reserveTokens) {
  if (!Number.isFinite(window) || window <= 0) return undefined
  const reserve = Number.isFinite(reserveTokens) && reserveTokens > 0 ? reserveTokens : 0

  // A hard-coded threshold below the window overrides the other three outright;
  // at or above the window it cannot ever trigger, so it is ignored and reported.
  let absoluteIgnored = false
  if (items?.absolute?.enabled === true) {
    const absolute = Math.floor(items.absolute.value)
    if (Number.isSafeInteger(absolute) && absolute > 0 && absolute < window) {
      return { threshold: absolute, winner: 'absolute', candidates: [{ item: 'absolute', value: absolute }], absoluteIgnored: false }
    }
    absoluteIgnored = true
  }

  const candidates = []
  if (items?.ratio?.enabled === true) candidates.push({ item: 'ratio', raw: window * items.ratio.value })
  if (items?.outputAware?.enabled === true) candidates.push({ item: 'outputAware', raw: window - reserve - items.outputAware.value })
  if (items?.fixed?.enabled === true) candidates.push({ item: 'fixed', raw: window - items.fixed.value })
  if (candidates.length === 0) {
    // Keep the ignored-override flag visible even when nothing else decides.
    return absoluteIgnored
      ? { threshold: null, winner: null, candidates: [], absoluteIgnored: true }
      : undefined
  }
  const min = candidates.reduce((left, right) => (right.raw < left.raw ? right : left))
  const threshold = Math.floor(min.raw)
  if (!Number.isSafeInteger(threshold) || threshold <= 0) return undefined
  return {
    threshold,
    winner: min.item,
    candidates: candidates.map((candidate) => ({ item: candidate.item, value: Math.floor(candidate.raw) })),
    absoluteIgnored,
  }
}

/**
 * The shipped `@deepseek-ai/dsh-compaction-basic` threshold, for side-by-side
 * display: `floor(min(W × 0.8, W − O − 65536))`.
 * @returns the built-in threshold, or undefined when the route cannot run it.
 */
export function builtinThreshold(window, reserveTokens) {
  if (!Number.isFinite(window) || window <= 0) return undefined
  const reserve = Number.isFinite(reserveTokens) && reserveTokens > 0 ? reserveTokens : 0
  const threshold = Math.floor(Math.min(window * 0.8, window - reserve - 65536))
  return Number.isSafeInteger(threshold) && threshold > 0 ? threshold : undefined
}

/**
 * Resolve one model row end to end: layers, merged items, threshold, and the
 * built-in comparison.
 * @param document - normalized policy document.
 * @param route - `{ provider, model }`.
 * @param window - context window, or undefined when the adapter declares none.
 * @param reserveTokens - output reservation O.
 */
export function resolveRow(document, route, window, reserveTokens) {
  const { items, layers } = resolvePolicy(document, route, window)
  const computed = Number.isFinite(window) ? computeThreshold(items, window, reserveTokens) : undefined
  return {
    ...route,
    contextWindow: Number.isFinite(window) ? window : null,
    reserveTokens: Number.isFinite(reserveTokens) ? reserveTokens : 0,
    layers,
    items,
    threshold: computed?.threshold ?? null,
    winner: computed?.winner ?? null,
    candidates: computed?.candidates ?? [],
    absoluteIgnored: computed?.absoluteIgnored === true,
    builtin: Number.isFinite(window) ? builtinThreshold(window, reserveTokens) ?? null : null,
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asPositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
