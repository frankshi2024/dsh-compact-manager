/**
 * dsh-compact-manager — browser half.
 *
 * Loaded by the shell as a CLASSIC script, so it cannot be an ES module: it must
 * self-register a CJS factory whose `id` equals `package.json.name`, and may only
 * `require` platform seed specifiers. Everything here therefore uses `react`
 * alone, plus `fetch` against the host's own `/api` route and the
 * `--dsw-alias-*` theme tokens for styling.
 *
 * The host owns the policy document and the model table; this half renders them
 * and posts edits back. Push events are not available to third-party packages, so
 * the page re-reads on mount, on an interval, and after every write.
 */

window.__ModuleLoader__.load({
  id: 'dsh-compact-manager',
  factory: (require) => {
    const React = require('react')

    const NS = 'compactManager'
    const PANEL_ID = 'compact-manager'
    const STATE_URL = '/api/compact-manager/state'
    const POLICY_URL = '/api/compact-manager/policy'
    const POLL_MS = 5000

    /** Item order shared with the host. Every layer states all four explicitly. */
    const ITEM_IDS = ['ratio', 'outputAware', 'fixed', 'absolute']
    const ITEM_KEY = {
      ratio: 'itemRatio',
      outputAware: 'itemOutputAware',
      fixed: 'itemFixed',
      absolute: 'itemAbsolute',
    }
    const ITEM_FALLBACK = { ratio: 0.8, outputAware: 32768, fixed: 32768, absolute: 131072 }

    const zh = {
      panel: '压缩策略',
      title: '压缩阈值管理',
      subtitle: '全局 → 上下文长度档位（±5%）→ 模型，后者完全覆盖前者；每项只有启用/停用，取已启用项的最小值并向下取整。',
      loading: '正在读取策略…',
      loadFailed: '读取失败',
      retry: '重试',
      refresh: '刷新',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      revert: '撤销改动',
      dirty: '有未保存的改动',
      clean: '与已保存的策略一致',
      model: '模型',
      noModels: '没有可用的模型目录；请先在「模型策略」里手动添加。',
      providers: '提供方',
      noModelList: '未列出模型',
      preview: '阈值预览',
      window: '上下文窗口 W',
      reserve: '输出预留 O',
      threshold: '压缩触发阈值',
      builtin: '官方内置阈值',
      winner: '决定项',
      candidates: '各启用项取值',
      layers: '生效层级',
      layerGlobal: '全局',
      layerTier: '档位',
      layerModel: '模型',
      yes: '已覆盖',
      no: '未覆盖',
      none: '无（不接管该模型，仍用官方内置策略）',
      presets: '预设',
      globalPolicy: '全局策略',
      tierPolicy: '上下文档位策略',
      modelPolicy: '模型策略',
      tierHint: '档位按上下文窗口匹配：窗口落在档位值的 ±5% 内即算同一档。新增档位会复制全局策略作为起点。',
      modelHint: '按 provider/model 精确覆盖，优先级最高。新增模型覆盖会复制该模型当前生效的策略作为起点。',
      addTier: '新增档位',
      addModel: '新增模型覆盖',
      remove: '删除',
      windowK: '档位窗口（K）',
      route: '模型',
      pickModel: '选择模型…',
      empty: '还没有条目。',
      on: '启用',
      off: '停用',
      inherit: '继承',
      outputHint: '决定项是「上下文 − 输出预留 − 固定值」：该路由的输出预留 O 很大，W − O − v 会把阈值压得很低。若不希望它主导，请把该项设为「停用」，或改用「上下文 × 比例」/「固定阈值」。',
      absoluteIgnored: '固定阈值 ≥ 上下文窗口 W，永远不会触发，已被忽略；请改小它或将其停用。',
      absoluteHint: '固定阈值小于 W 时直接覆盖另外三项。',
      presetApplied: '已应用预设（记得保存）',
      invalid: '策略被宿主拒绝',
      lang: 'zh',
      itemRatio: '上下文 × 比例',
      itemOutputAware: '上下文 − 输出预留 − 固定值',
      itemFixed: '上下文 − 固定值',
      itemAbsolute: '固定阈值（直接指定）',
    }

    const en = {
      panel: 'Compaction',
      title: 'Compaction threshold manager',
      subtitle: 'Global → context-window tier (±5%) → model, each layer replacing the one below; every item is on/off and the enabled items are floored to their minimum.',
      loading: 'Reading policy…',
      loadFailed: 'Could not read the policy',
      retry: 'Retry',
      refresh: 'Refresh',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      revert: 'Revert changes',
      dirty: 'Unsaved changes',
      clean: 'Matches the saved policy',
      model: 'Model',
      noModels: 'No model catalog is available; add one under Model policies.',
      providers: 'Providers',
      noModelList: 'lists no models',
      preview: 'Threshold preview',
      window: 'Context window W',
      reserve: 'Output reservation O',
      threshold: 'Compaction trigger',
      builtin: 'Built-in threshold',
      winner: 'Deciding item',
      candidates: 'Enabled item values',
      layers: 'Layers in effect',
      layerGlobal: 'Global',
      layerTier: 'Tier',
      layerModel: 'Model',
      yes: 'overridden',
      no: 'not set',
      none: 'None — this route keeps the built-in policy.',
      presets: 'Presets',
      globalPolicy: 'Global policy',
      tierPolicy: 'Context-window tiers',
      modelPolicy: 'Model policies',
      tierHint: 'A tier matches when the window is within ±5% of its value. A new tier starts from the global policy.',
      modelHint: 'Exact provider/model override; highest precedence. A new entry starts from that model\'s effective policy.',
      addTier: 'Add tier',
      addModel: 'Add model override',
      remove: 'Remove',
      windowK: 'Tier window (K)',
      route: 'Model',
      pickModel: 'Pick a model…',
      empty: 'No entries yet.',
      on: 'On',
      off: 'Off',
      inherit: 'Inherit',
      outputHint: 'The deciding item is Context − reserve − fixed: this route reserves a large output budget O, so W − O − v pushes the threshold down. Set it to Off, or use Context × ratio / the absolute threshold.',
      absoluteIgnored: 'The absolute threshold is at or above the context window W, so it can never trigger and has been ignored. Lower it or switch it off.',
      absoluteHint: 'An absolute threshold below W overrides the other three items.',
      presetApplied: 'Preset applied — remember to save',
      invalid: 'The host rejected the policy',
      lang: 'en',
      itemRatio: 'Context × ratio',
      itemOutputAware: 'Context − reserve − fixed',
      itemFixed: 'Context − fixed',
      itemAbsolute: 'Absolute threshold',
    }

    const styles = {
      page: { display: 'grid', gap: '14px', padding: '20px 22px 40px', color: 'var(--dsw-alias-label-primary, #e8e8e8)', fontSize: '13px', lineHeight: '1.6', overflowY: 'auto', height: '100%', boxSizing: 'border-box' },
      card: { background: 'var(--dsw-alias-bg-layer-1, #212223)', border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))', borderRadius: '10px', padding: '14px 16px', display: 'grid', gap: '10px' },
      header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' },
      h1: { fontSize: '17px', fontWeight: 600, margin: 0 },
      h2: { fontSize: '13px', fontWeight: 600, margin: 0 },
      muted: { color: 'var(--dsw-alias-label-secondary, #9aa0a6)', fontSize: '12px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' },
      select: { background: 'var(--dsw-alias-bg-layer-2, #2a2b2d)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))', borderRadius: '7px', padding: '5px 8px', fontSize: '12px', maxWidth: '360px' },
      input: { background: 'var(--dsw-alias-bg-layer-2, #2a2b2d)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))', borderRadius: '7px', padding: '5px 8px', fontSize: '12px', width: '104px' },
      button: { background: 'var(--dsw-alias-bg-layer-2, #2a2b2d)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))', borderRadius: '7px', padding: '5px 11px', fontSize: '12px', cursor: 'pointer' },
      primary: { background: 'var(--dsw-alias-brand-primary, #4d6bfe)', color: '#fff', border: '1px solid transparent', borderRadius: '7px', padding: '5px 13px', fontSize: '12px', cursor: 'pointer' },
      primaryDisabled: { background: 'var(--dsw-alias-bg-layer-2, #e9e9ea)', color: 'var(--dsw-alias-label-secondary, #6b7076)', border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))', borderRadius: '7px', padding: '5px 13px', fontSize: '12px', cursor: 'default' },
      big: { fontSize: '24px', fontWeight: 600, color: 'var(--dsw-alias-brand-primary, #7f9bff)' },
      stat: { display: 'grid', gap: '2px' },
      item: { display: 'grid', gridTemplateColumns: '88px 1fr 112px', alignItems: 'center', gap: '8px' },
      stateSelect: { background: 'var(--dsw-alias-bg-layer-2, #2a2b2d)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))', borderRadius: '7px', padding: '4px 6px', fontSize: '12px', width: '88px' },
      chip: { display: 'inline-block', padding: '1px 7px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))', fontSize: '11px' },
      error: { color: 'var(--dsw-alias-state-error-primary, #ff6b6b)', fontSize: '12px' },
      ok: { color: 'var(--dsw-alias-state-success-primary, #34c759)', fontSize: '12px' },
      warn: { color: 'var(--dsw-alias-state-warn-primary, #b7791f)', fontSize: '12px', marginTop: '6px' },
      link: { background: 'none', border: 'none', color: 'var(--dsw-alias-brand-primary, #7f9bff)', cursor: 'pointer', fontSize: '12px', padding: 0 },
      pre: { margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
    }

    function PanelIcon({ size }) {
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
      React.createElement('rect', { x: 2, y: 8, width: 3, height: 6, rx: 1, fill: 'currentColor', opacity: 0.55 }),
      React.createElement('rect', { x: 6.5, y: 5, width: 3, height: 9, rx: 1, fill: 'currentColor', opacity: 0.8 }),
      React.createElement('rect', { x: 11, y: 2, width: 3, height: 12, rx: 1, fill: 'currentColor' }))
    }

    /** Copy one layer, defaulting anything missing to a switched-off item. */
    function cloneLayer(layer) {
      const next = {}
      for (const id of ITEM_IDS) {
        const raw = layer?.[id]
        next[id] = raw === undefined
          ? { enabled: false, value: ITEM_FALLBACK[id] }
          : { enabled: raw.enabled === true, value: typeof raw.value === 'number' ? raw.value : ITEM_FALLBACK[id] }
      }
      return next
    }

    function cloneDocument(document) {
      return {
        global: cloneLayer(document?.global),
        tiers: (document?.tiers ?? []).map((tier) => ({ window: tier.window, policy: cloneLayer(tier.policy) })),
        models: (document?.models ?? []).map((entry) => ({ provider: entry.provider, model: entry.model, policy: cloneLayer(entry.policy) })),
      }
    }

    function formatNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
    }

    function formatWindow(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return `${formatNumber(value)} (${Math.round(value / 1024)}K)`
    }

    function itemMeta(items, id) {
      return (items ?? []).find((item) => item.id === id) ?? { id, label: { zh: id, en: id }, formula: id }
    }

    function itemLabel(meta, lang) {
      return (lang === 'zh' ? meta.label?.zh : meta.label?.en) ?? meta.id
    }

    /** One item in one layer: on or off, nothing else. */
    function ItemRow({ item, meta, layer, onChange, t }) {
      const current = layer[item] ?? { enabled: false, value: ITEM_FALLBACK[item] }
      return React.createElement('div', { style: styles.item },
        React.createElement('select', {
          style: styles.stateSelect,
          value: current.enabled === true ? 'on' : 'off',
          'aria-label': t(ITEM_KEY[item]),
          onChange: (event) => onChange({
            ...layer,
            [item]: { enabled: event.target.value === 'on', value: current.value },
          }),
        },
        React.createElement('option', { value: 'on' }, t('on')),
        React.createElement('option', { value: 'off' }, t('off'))),
        React.createElement('div', null,
          React.createElement('div', null, t(ITEM_KEY[item])),
          React.createElement('div', { style: styles.muted }, meta.formula)),
        React.createElement('input', {
          type: 'number',
          style: current.enabled === true ? styles.input : { ...styles.input, opacity: 0.5 },
          value: String(current.value),
          step: item === 'ratio' ? '0.05' : '1024',
          onChange: (event) => {
            const parsed = Number(event.target.value)
            onChange({
              ...layer,
              [item]: { enabled: current.enabled === true, value: Number.isFinite(parsed) ? parsed : 0 },
            })
          },
        }))
    }

    function LayerForm({ layer, items, onChange, t }) {
      return React.createElement('div', { style: { display: 'grid', gap: '7px' } },
        ITEM_IDS.map((item) => React.createElement(ItemRow, {
          key: item,
          item,
          meta: itemMeta(items, item),
          layer,
          onChange,
          t,
        })))
    }

    /** Dropdown over the known routes, keeping a route that is not in the catalog. */
    function RouteSelect({ value, onChange, models, t, style }) {
      const options = models.map((row) => ({
        value: `${row.provider}/${row.model}`,
        label: `${row.provider} · ${row.name || row.model}`,
      }))
      if (value !== undefined && value !== '' && !options.some((option) => option.value === value)) {
        options.unshift({ value, label: value })
      }
      return React.createElement('select', {
        style: { ...styles.select, ...style },
        value: value ?? '',
        onChange: (event) => {
          const raw = event.target.value
          const slash = raw.indexOf('/')
          if (slash <= 0) return onChange(undefined)
          onChange({ provider: raw.slice(0, slash), model: raw.slice(slash + 1) })
        },
      },
      React.createElement('option', { value: '' }, t('pickModel')),
      options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)))
    }

    function CompactManagerPage(props) {
      const { t, lang } = props
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      const [draft, setDraft] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [pendingRoute, setPendingRoute] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback((force) => {
        const url = force === true ? `${STATE_URL}?refresh=1` : STATE_URL
        return fetch(url, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            setState({ status: 'ready', data, error: null })
            setDraft((current) => current ?? cloneDocument(data.document))
            setSelected((current) => current ?? (data.models?.[0] ? `${data.models[0].provider}/${data.models[0].model}` : null))
            return data
          })
          .catch((error) => {
            setState({ status: 'error', data: null, error: error instanceof Error ? error.message : String(error) })
          })
      }, [])

      React.useEffect(() => {
        let live = true
        const tick = () => { if (live) void load(false) }
        void load(false)
        const timer = setInterval(tick, POLL_MS)
        const onFocus = () => { void load(true) }
        window.addEventListener('focus', onFocus)
        return () => {
          live = false
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [load])

      const data = state.data
      const items = data?.items ?? []
      const models = data?.models ?? []
      const dirty = draft !== null && data !== null && JSON.stringify(draft) !== JSON.stringify(cloneDocument(data.document))
      const selectedRow = models.find((row) => `${row.provider}/${row.model}` === selected) ?? null

      const save = () => {
        if (draft === null) return
        setBusy(true)
        setNotice(null)
        fetch(POLICY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ document: draft }),
        })
          .then(async (response) => ({ ok: response.ok, body: await response.json() }))
          .then(({ ok, body }) => {
            if (!ok || body.ok !== true) {
              setNotice({ kind: 'error', text: `${t('invalid')}: ${body?.error?.message ?? ''} ${(body?.error?.issues ?? []).join('; ')}` })
              return
            }
            setState({ status: 'ready', data: body, error: null })
            setDraft(cloneDocument(body.document))
            setNotice({ kind: 'ok', text: t('saved') })
          })
          .catch((error) => setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) }))
          .finally(() => setBusy(false))
      }

      if (state.status === 'loading') return React.createElement('div', { style: styles.page }, t('loading'))
      if (state.status === 'error') {
        return React.createElement('div', { style: styles.page },
          React.createElement('div', { style: styles.error }, `${t('loadFailed')}: ${state.error}`),
          React.createElement('button', { type: 'button', style: styles.primary, onClick: () => load(true) }, t('retry')))
      }

      const patchGlobal = (layer) => setDraft({ ...draft, global: layer })
      const patchTier = (index, layer) => setDraft({
        ...draft,
        tiers: draft.tiers.map((tier, position) => (position === index ? { ...tier, policy: layer } : tier)),
      })
      const patchTierWindow = (index, window) => setDraft({
        ...draft,
        tiers: draft.tiers.map((tier, position) => (position === index ? { ...tier, window } : tier)),
      })
      const patchModel = (index, layer) => setDraft({
        ...draft,
        models: draft.models.map((entry, position) => (position === index ? { ...entry, policy: layer } : entry)),
      })
      const patchModelRoute = (index, route) => setDraft({
        ...draft,
        models: draft.models.map((entry, position) => (position === index ? { ...entry, ...route } : entry)),
      })

      const layersLine = selectedRow === null ? null : [
        `${t('layerGlobal')}: ${t('yes')}`,
        `${t('layerTier')}: ${selectedRow.layers?.tier == null ? t('no') : formatWindow(selectedRow.layers.tier)}`,
        `${t('layerModel')}: ${selectedRow.layers?.model ? t('yes') : t('no')}`,
      ]

      const providersWithoutModels = (data?.providers ?? []).filter((provider) => provider.modelCount === 0)
      const absoluteIgnored = selectedRow?.absoluteIgnored === true
      const outputHint = selectedRow && selectedRow.winner === 'outputAware' && selectedRow.contextWindow !== null
        && selectedRow.reserveTokens > selectedRow.contextWindow * 0.25

      return React.createElement('div', { style: styles.page },
        React.createElement('div', { style: styles.header },
          React.createElement('div', null,
            React.createElement('h1', { style: styles.h1 }, t('title')),
            React.createElement('div', { style: styles.muted }, t('subtitle'))),
          React.createElement('div', { style: styles.row },
            React.createElement('button', { type: 'button', style: styles.button, onClick: () => load(true) }, t('refresh')),
            dirty
              ? React.createElement('button', { type: 'button', style: styles.button, onClick: () => setDraft(cloneDocument(data.document)) }, t('revert'))
              : null,
            React.createElement('button', {
              type: 'button',
              style: busy || !dirty ? styles.primaryDisabled : styles.primary,
              disabled: busy || !dirty,
              onClick: save,
            }, busy ? t('saving') : t('save')))),

        React.createElement('div', { style: styles.muted },
          dirty ? t('dirty') : t('clean'),
          ` · revision ${data.revision}`,
          notice === null ? null : ' · ',
          notice === null ? null : React.createElement('span', { style: notice.kind === 'error' ? styles.error : styles.ok }, notice.text)),

        React.createElement('div', { style: styles.card },
          React.createElement('div', { style: styles.row },
            React.createElement('span', { style: styles.h2 }, t('model')),
            models.length === 0
              ? React.createElement('span', { style: styles.muted }, t('noModels'))
              : React.createElement('select', {
                style: styles.select,
                value: selected ?? '',
                onChange: (event) => setSelected(event.target.value),
              }, models.map((row) => React.createElement('option', {
                key: `${row.provider}/${row.model}`,
                value: `${row.provider}/${row.model}`,
              }, `${row.provider} · ${row.name || row.model}${row.source === 'override' ? ' *' : ''}`)))),

          selectedRow === null ? null : React.createElement('div', { style: styles.grid2 },
            React.createElement('div', { style: styles.stat },
              React.createElement('div', { style: styles.muted }, t('window')),
              React.createElement('div', null, formatWindow(selectedRow.contextWindow))),
            React.createElement('div', { style: styles.stat },
              React.createElement('div', { style: styles.muted }, t('reserve')),
              React.createElement('div', null, formatNumber(selectedRow.reserveTokens))),
            React.createElement('div', { style: styles.stat },
              React.createElement('div', { style: styles.muted }, `${t('threshold')} · ${t('preview')}`),
              React.createElement('div', { style: styles.big }, selectedRow.threshold === null ? '—' : formatNumber(selectedRow.threshold))),
            React.createElement('div', { style: styles.stat },
              React.createElement('div', { style: styles.muted }, t('builtin')),
              React.createElement('div', null, selectedRow.builtin === null ? '—' : formatNumber(selectedRow.builtin)))),

          selectedRow === null ? null : React.createElement('div', null,
            React.createElement('div', { style: styles.muted }, t('candidates')),
            React.createElement('pre', { style: styles.pre }, selectedRow.candidates.length === 0
              ? t('none')
              : selectedRow.candidates.map((candidate) => `${t(ITEM_KEY[candidate.item])} = ${formatNumber(candidate.value)}`).join('\n')),
            selectedRow.winner === null ? null : React.createElement('div', null,
              `${t('winner')}: `,
              React.createElement('span', { style: styles.chip }, t(ITEM_KEY[selectedRow.winner]))),
            absoluteIgnored ? React.createElement('div', { style: styles.warn }, t('absoluteIgnored')) : null,
            outputHint ? React.createElement('div', { style: styles.warn }, t('outputHint')) : null,
            layersLine === null ? null : React.createElement('div', { style: { ...styles.muted, marginTop: '6px' } }, layersLine.join(' · '))),

          providersWithoutModels.length === 0 ? null : React.createElement('div', { style: styles.muted },
            `${t('providers')}: ${providersWithoutModels.map((provider) => `${provider.provider} ${t('noModelList')}`).join(', ')}`)),

        React.createElement('div', { style: styles.card },
          React.createElement('div', { style: styles.h2 }, t('presets')),
          React.createElement('div', { style: styles.row }, (data.presets ?? []).map((preset) =>
            React.createElement('button', {
              key: preset.id,
              type: 'button',
              style: styles.button,
              onClick: () => {
                setDraft(cloneDocument(preset.document))
                setNotice({ kind: 'ok', text: t('presetApplied') })
              },
            }, itemLabel({ label: preset.label, id: preset.id }, lang))))),

        React.createElement('div', { style: styles.card },
          React.createElement('div', { style: styles.h2 }, t('globalPolicy')),
          React.createElement(LayerForm, { layer: draft.global, items, onChange: patchGlobal, t })),

        React.createElement('div', { style: styles.card },
          React.createElement('div', { style: styles.h2 }, t('tierPolicy')),
          React.createElement('div', { style: styles.muted }, t('tierHint')),
          draft.tiers.length === 0 ? React.createElement('div', { style: styles.muted }, t('empty')) : null,
          draft.tiers.map((tier, index) => React.createElement('div', { key: `tier-${index}`, style: { display: 'grid', gap: '7px', paddingTop: '6px' } },
            React.createElement('div', { style: styles.row },
              React.createElement('span', { style: styles.muted }, t('windowK')),
              React.createElement('input', {
                type: 'number',
                style: styles.input,
                value: String(Math.round(tier.window / 1024)),
                step: '16',
                onChange: (event) => {
                  const parsed = Number(event.target.value)
                  patchTierWindow(index, Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1024) : 0)
                },
              }),
              React.createElement('span', { style: styles.muted }, formatWindow(tier.window)),
              React.createElement('button', {
                type: 'button',
                style: styles.link,
                onClick: () => setDraft({ ...draft, tiers: draft.tiers.filter((_, position) => position !== index) }),
              }, t('remove'))),
            React.createElement(LayerForm, { layer: tier.policy, items, onChange: (layer) => patchTier(index, layer), t }))),
          React.createElement('div', { style: styles.row },
            React.createElement('button', {
              type: 'button',
              style: styles.button,
              onClick: () => setDraft({
                ...draft,
                // A complete layer replaces the one below, so a new tier starts
                // from the global decision instead of switching everything off.
                tiers: draft.tiers.concat([{ window: 256 * 1024, policy: cloneLayer(draft.global) }]),
              }),
            }, t('addTier')))),

        React.createElement('div', { style: styles.card },
          React.createElement('div', { style: styles.h2 }, t('modelPolicy')),
          React.createElement('div', { style: styles.muted }, t('modelHint')),
          draft.models.length === 0 ? React.createElement('div', { style: styles.muted }, t('empty')) : null,
          draft.models.map((entry, index) => React.createElement('div', { key: `model-${index}`, style: { display: 'grid', gap: '7px', paddingTop: '6px' } },
            React.createElement('div', { style: styles.row },
              React.createElement('span', { style: styles.muted }, t('route')),
              React.createElement(RouteSelect, {
                value: entry.provider && entry.model ? `${entry.provider}/${entry.model}` : '',
                models,
                t,
                onChange: (route) => patchModelRoute(index, route ?? { provider: '', model: '' }),
              }),
              React.createElement('button', {
                type: 'button',
                style: styles.link,
                onClick: () => setDraft({ ...draft, models: draft.models.filter((_, position) => position !== index) }),
              }, t('remove'))),
            React.createElement(LayerForm, { layer: entry.policy, items, onChange: (layer) => patchModel(index, layer), t }))),
          React.createElement('div', { style: styles.row },
            React.createElement(RouteSelect, {
              value: pendingRoute ? `${pendingRoute.provider}/${pendingRoute.model}` : '',
              models,
              t,
              onChange: setPendingRoute,
            }),
            React.createElement('button', {
              type: 'button',
              style: styles.button,
              onClick: () => {
                if (pendingRoute === null || pendingRoute === undefined) return
                const exists = draft.models.some((entry) => entry.provider === pendingRoute.provider && entry.model === pendingRoute.model)
                if (exists) return
                // Start from what the route currently resolves to, so adding an
                // override does not silently switch its other items off.
                const seeded = selectedRow !== null && `${selectedRow.provider}/${selectedRow.model}` === `${pendingRoute.provider}/${pendingRoute.model}`
                  ? selectedRow.items
                  : draft.global
                setDraft({ ...draft, models: draft.models.concat([{ provider: pendingRoute.provider, model: pendingRoute.model, policy: cloneLayer(seeded) }]) })
                setPendingRoute(null)
              },
            }, t('addModel')))))
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'compact-manager: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        locale: NS,
        label: () => t('panel'),
      }, PanelIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ lang: t('lang') === 'zh' ? 'zh' : 'en' }),
      }, CompactManagerPage))
    }

    return { apply, inject }
  },
})
