/**
 * dsh-compact-manager — host half.
 *
 * Responsibilities:
 *   1. Own the persisted policy document (global → context-window tier → model).
 *   2. Serve the browser half over two exact `/api` Fetch routes.
 *   3. Override the mounted compaction engine's pressure trigger with the
 *      resolved policy, leaving the engine's region selection, retention, and
 *      summarization untouched.
 *
 * The plugin is inert until a policy item is enabled: with an empty document it
 * never returns `null` early and every route keeps the built-in
 * `@deepseek-ai/dsh-compaction-basic` threshold.
 */

import {
  K,
  POLICY_ITEM_META,
  TIER_TOLERANCE,
  defaultDocument,
  normalizeDocument,
  resolveRow,
  validateDocument,
} from './policy.js'
import { DOCUMENT_KEY, compactManagerDomain } from './schema.js'

export const name = 'compact-manager'

/** Storage, the browser carrier, and model metadata are all required. */
export const inject = ['storageDomain', 'connection', 'llm']

const STATE_ROUTE = '/api/compact-manager/state'
const POLICY_ROUTE = '/api/compact-manager/policy'

/** How long a resolved model table is reused before the adapters are asked again. */
const TABLE_TTL_MS = 60_000

/**
 * Ready-made documents the sidebar can apply in one click.
 *
 * Note the trap: an enabled `outputAware` item on a route whose output
 * reservation is large dominates the minimum (`W − O − v` shrinks fast as O
 * grows), which is why the recommended preset never enables it.
 */
const PRESETS = [
  {
    id: 'off',
    label: { zh: '不接管（官方内置策略）', en: 'Off (built-in policy)' },
    document: { global: {}, tiers: [], models: [] },
  },
  {
    id: 'tier256Ratio80Fixed32k',
    label: { zh: '256K 档：80% 或 上下文−32K（推荐）', en: '256K tier: 80% or context − 32K (recommended)' },
    document: {
      global: { ratio: { enabled: true, value: 0.8 } },
      tiers: [{ window: 256 * K, policy: { fixed: { enabled: true, value: 32768 } } }],
      models: [],
    },
  },
  {
    id: 'globalRatio80',
    label: { zh: '全局：仅 上下文 × 80%', en: 'Global: context × 0.8 only' },
    document: { global: { ratio: { enabled: true, value: 0.8 } }, tiers: [], models: [] },
  },
  {
    id: 'tier256Ratio80',
    label: { zh: '256K 档：仅 上下文 × 80%', en: '256K tier: context × 0.8 only' },
    document: { global: {}, tiers: [{ window: 256 * K, policy: { ratio: { enabled: true, value: 0.8 } } }], models: [] },
  },
  {
    id: 'globalRatio80Output32k',
    label: {
      zh: '全局：80% 或 上下文−输出预留−32K（O 大时会主导）',
      en: 'Global: 80% or context − reserve − 32K (reserve dominates when large)',
    },
    document: {
      global: {
        ratio: { enabled: true, value: 0.8 },
        outputAware: { enabled: true, value: 32768 },
      },
      tiers: [],
      models: [],
    },
  },
]

export function apply(ctx) {
  const store = {
    /** Normalized policy document. */
    document: defaultDocument(),
    /** Monotonic write counter exposed to the browser for stale-write detection. */
    revision: 0,
    /** Cached model table and the time it was built. */
    rows: [],
    providers: [],
    rowsBuiltAt: 0,
    tableError: undefined,
  }

  // ---- persistence -------------------------------------------------------
  const opening = ctx.storageDomain.open(compactManagerDomain).then((domain) => {
    const stored = domain.table('documents').get(DOCUMENT_KEY)
    if (stored !== undefined) {
      store.document = normalizeDocument(stored.document)
      store.revision = stored.revision
    }
    return domain
  })
  opening.catch((error) => {
    ctx.logger.warn(`compact-manager: could not open the policy store (${describe(error)}); policies stay in memory for this session`)
  })
  ctx.effect(() => () => {
    void opening.then((domain) => domain.close()).catch(() => {})
  })

  async function persist(next) {
    store.document = next
    store.revision += 1
    store.rowsBuiltAt = 0
    try {
      const domain = await opening
      await domain.table('documents').put(DOCUMENT_KEY, { document: next, revision: store.revision })
    } catch (error) {
      ctx.logger.warn(`compact-manager: policy write was not persisted (${describe(error)})`)
    }
  }

  // ---- model metadata ----------------------------------------------------
  async function buildTable() {
    const rows = []
    const providers = []
    let providers_ = []
    try {
      providers_ = ctx.llm.listProviders()
    } catch (error) {
      store.tableError = describe(error)
    }
    for (const provider of providers_) {
      let models = []
      let failure
      try {
        models = await ctx.llm.listModels(provider.id)
      } catch (error) {
        failure = describe(error)
      }
      providers.push({
        provider: provider.id,
        name: provider.name ?? provider.id,
        modelCount: Array.isArray(models) ? models.length : 0,
        ...(failure === undefined ? {} : { error: failure }),
      })
      for (const model of Array.isArray(models) ? models : []) {
        const info = await resolveInfo(provider.id, model.id)
        rows.push({
          name: model.name ?? model.id,
          source: 'catalog',
          ...resolveRow(store.document, { provider: provider.id, model: model.id }, info?.context?.contextWindow, info?.defaultMaxTokens ?? 0),
        })
      }
    }
    // Routes that carry an override but are missing from every catalog stay visible.
    for (const entry of store.document.models) {
      if (rows.some((row) => row.provider === entry.provider && row.model === entry.model)) continue
      const info = await resolveInfo(entry.provider, entry.model)
      rows.push({
        name: entry.model,
        source: 'override',
        ...resolveRow(store.document, { provider: entry.provider, model: entry.model }, info?.context?.contextWindow, info?.defaultMaxTokens ?? 0),
      })
    }
    rows.sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
    store.rows = rows
    store.providers = providers
    store.rowsBuiltAt = Date.now()
    return rows
  }

  /** Resolve one route's capacity, tolerating adapters that cannot answer. */
  async function resolveInfo(provider, model) {
    try {
      return await ctx.llm.resolveModelInfo(provider, model)
    } catch {
      return undefined
    }
  }

  async function table(force) {
    if (force || store.rowsBuiltAt === 0 || Date.now() - store.rowsBuiltAt > TABLE_TTL_MS) {
      try {
        await buildTable()
      } catch (error) {
        store.tableError = describe(error)
      }
    }
    return store.rows
  }

  // ---- HTTP API ----------------------------------------------------------
  ctx.effect(() => ctx.connection.fetch.register({
    path: STATE_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      return json(await snapshot(url.searchParams.get('refresh') === '1'))
    },
  }), 'compact-manager: state route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: POLICY_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, error: { message: 'request body must be JSON' } }, 400)
      }
      const issues = validateDocument(body?.document)
      if (issues.length > 0) return json({ ok: false, error: { message: 'invalid policy document', issues } }, 400)
      await persist(normalizeDocument(body.document))
      ctx.logger.info(`compact-manager: policy updated (revision ${store.revision})`)
      return json({ ok: true, ...(await snapshot(true)) })
    },
  }), 'compact-manager: policy route')

  async function snapshot(force) {
    const rows = await table(force)
    return {
      ok: true,
      revision: store.revision,
      document: store.document,
      items: POLICY_ITEM_META,
      presets: PRESETS,
      tierTolerance: TIER_TOLERANCE,
      k: K,
      models: rows,
      providers: store.providers,
      ...(store.tableError === undefined ? {} : { tableError: store.tableError }),
    }
  }

  // ---- compaction hook ---------------------------------------------------
  // The shipped Web composition keeps compaction on the per-preset plane: the
  // profile row is disabled and every agent preset mounts its own instance
  // inside an isolated group, so a profile-plane plugin cannot inject
  // `ctx.compaction`. Decorating the exported class prototype reaches every
  // instance regardless of the scope that owns it.
  void installThresholdHook(ctx, store).catch((error) => {
    ctx.logger.warn(`compact-manager: threshold hook installation failed (${describe(error)}); overrides stay inactive`)
  })
}

/** Marker shared by reloaded module instances, so the hook installs once. */
const HOOK = Symbol.for('dsh.compact-manager.hook')

async function installThresholdHook(ctx, store) {
  let Engine
  try {
    ({ BasicCompactionEngine: Engine } = await import('@deepseek-ai/dsh-compaction-basic'))
  } catch (error) {
    ctx.logger.warn(`compact-manager: could not load the compaction backend (${describe(error)}); threshold overrides stay inactive`)
    return
  }
  const prototype = Engine?.prototype
  if (prototype === undefined || typeof prototype.compactIfNeeded !== 'function') {
    ctx.logger.warn('compact-manager: the compaction backend exposes no compactIfNeeded hook; threshold overrides stay inactive')
    return
  }
  if (prototype[HOOK] !== undefined) return

  const previous = prototype.compactIfNeeded
  const patched = async function compactIfNeeded(agent, trigger, signal) {
    // Context-overflow recovery keeps the built-in path untouched.
    if (trigger === 'pressure') {
      const row = await policyRowFor(this, agent, signal, store, ctx)
      if (row !== undefined && row.threshold !== null) {
        let pressure
        try {
          pressure = this.ctx.tokenMeter.measure(agent.session).totalTokens
        } catch (error) {
          ctx.logger.warn(`compact-manager: could not measure context pressure (${describe(error)}); using the built-in threshold`)
          return previous.call(this, agent, trigger, signal)
        }
        if (pressure < row.threshold) return null
        ctx.logger.info(`compact-manager: ${row.provider}/${row.model} pressure ${pressure} ≥ threshold ${row.threshold} (${row.winner}); compacting`)
      }
    }
    return previous.call(this, agent, trigger, signal)
  }

  prototype[HOOK] = { previous, patched }
  prototype.compactIfNeeded = patched
  ctx.effect(() => () => {
    if (prototype.compactIfNeeded !== patched) return
    prototype.compactIfNeeded = previous
    delete prototype[HOOK]
  }, 'compact-manager: threshold hook')
  ctx.logger.info(`compact-manager: threshold hook installed; items ${POLICY_ITEM_META.map((item) => item.id).join(' / ')}`)
}

/**
 * Resolve one engine call's policy row, or undefined when the route keeps the
 * built-in policy.
 * @param engine - compaction engine instance; its context owns llm and the meter.
 */
async function policyRowFor(engine, agent, signal, store, ctx) {
  try {
    const route = agent?.session?.requestHeader?.()?.config
    if (route === undefined || !route.provider || !route.model) return undefined
    const info = await engine.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
    const window = info?.context?.contextWindow
    if (!Number.isInteger(window) || window <= 0) return undefined
    const reserve = route.maxTokens ?? info?.defaultMaxTokens ?? 0
    return resolveRow(store.document, { provider: route.provider, model: route.model }, window, reserve)
  } catch (error) {
    ctx.logger.warn(`compact-manager: could not resolve the route policy (${describe(error)}); using the built-in threshold`)
    return undefined
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
