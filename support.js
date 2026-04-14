(() => {
  'use strict';

  const STORAGE_KEY = 'splunkPsOpsStudio.projectState.v2026-04-13';
  const STORAGE_META_KEY = 'splunkPsOpsStudio.projectMeta.v2026-04-13';
  const WORKSPACE_STATE_KEY = 'splunkPsOpsStudio.workspaceState.v2026-04-14';
  const WORKSPACE_META_KEY = 'splunkPsOpsStudio.workspaceMeta.v2026-04-14';
  const WINDOW_NAME_PREFIX = 'splunkPsOpsStudio.state.v2026-04-13::';
  const CHANNEL_NAME = 'splunk-ps-ops-studio.v2026-04-13';
  const MESSAGE_STATE = 'splunk-ps-state';
  const MESSAGE_REQUEST = 'splunk-ps-state-request';
  const MESSAGE_VIEW_SYNC = 'splunk-ps-view-sync';
  const EMBEDDED_MODE = new URLSearchParams(window.location.search).get('embedded') === '1' || window.self !== window.top;

  const DEFAULTS = {
    meta: { deploymentName: '', customerName: '', customerShortName: '', environment: '', platform: '', topologyPattern: '', splunkVersion: '' },
    globals: {
      sshUser: 'splunkadm',
      sshPassword: '',
      splunkAdminUser: 'admin',
      splunkAdminPassword: '',
      runtimeUser: 'splunk',
      enterpriseHome: '/opt/splunk',
      forwarderHome: '/opt/splunkforwarder',
      receiverPort: '9997',
      hecPort: '8088',
      usePublicIpForSsh: true,
      usePrivateIpForSplunk: true,
      deploymentPollInterval: '60'
    },
    cluster: {
      indexerClustering: false,
      searchHeadClustering: false,
      multisite: false,
      indexerReplicationPort: '9887',
      searchHeadReplicationPort: '8181',
      kvstoreReplicationPort: '8191'
    },
    security: { tlsEnabled: false, hecEnabled: false },
    sites: [],
    components: [],
    dataSources: []
  };

  const ROLE_ORDER = ['load_balancer', 'cluster_manager', 'deployer', 'deployment_server', 'monitoring_console', 'license_manager', 'search_head', 'indexer', 'heavy_forwarder', 'hec_gateway', 'universal_forwarder', 'license_only_peer'];
  const ROLE_LABELS = {
    load_balancer: 'Load Balancer',
    cluster_manager: 'Cluster Manager',
    deployer: 'Deployer',
    deployment_server: 'Deployment Server',
    monitoring_console: 'Monitoring Console',
    license_manager: 'License Manager',
    search_head: 'Search Head',
    indexer: 'Indexer',
    heavy_forwarder: 'Heavy Forwarder',
    hec_gateway: 'HEC Gateway',
    universal_forwarder: 'Universal Forwarder',
    license_only_peer: 'License Peer'
  };

  let snapshot = null;
  let channel = null;
  let requestTimer = null;
  let requestAttempts = 0;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    if (EMBEDDED_MODE) document.body.classList.add('embedded-mode');
    bindCopyButtons();
    bindStateListeners();
    bindBroadcastChannel();
    snapshot = loadInitialSnapshot();
    if (snapshot) persistSnapshot();
    render();
    if (!snapshot) {
      requestLiveState();
      startRequestLoop();
    }
  }

  function bindStateListeners() {
    window.addEventListener('message', event => {
      const data = event && event.data;
      if (!data || data.type !== MESSAGE_STATE || !data.state) return;
      applyIncomingState(data.state, data.meta, data.savedAt, data.source || 'message');
    });
    window.addEventListener('storage', event => {
      if (!event || ![STORAGE_KEY, STORAGE_META_KEY, WORKSPACE_STATE_KEY, WORKSPACE_META_KEY].includes(event.key)) return;
      const stored = loadStoredSnapshot();
      if (!stored) return;
      applyIncomingState(stored.state, stored.meta, stored.meta && stored.meta.savedAt, stored.meta && stored.meta.source || 'browser storage');
    });
  }

  function bindBroadcastChannel() {
    if (!('BroadcastChannel' in window)) return;
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener('message', event => {
        const data = event && event.data;
        if (!data || data.type !== MESSAGE_STATE || !data.state) return;
        applyIncomingState(data.state, data.meta, data.savedAt, data.source || 'broadcast channel');
      });
    } catch (err) {
      channel = null;
    }
  }

  function base64EncodeUnicode(value) {
    try {
      return btoa(encodeURIComponent(String(value)).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
    } catch (err) {
      return '';
    }
  }

  function base64DecodeUnicode(value) {
    try {
      return decodeURIComponent(Array.from(atob(String(value))).map(ch => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
    } catch (err) {
      return '';
    }
  }

  function encodeWindowPayload(payload) {
    if (!payload || !payload.state) return '';
    const encoded = base64EncodeUnicode(JSON.stringify(payload));
    return encoded ? WINDOW_NAME_PREFIX + encoded : '';
  }

  function decodeWindowPayload(rawValue) {
    if (!rawValue || typeof rawValue !== 'string' || !rawValue.startsWith(WINDOW_NAME_PREFIX)) return null;
    try {
      return JSON.parse(base64DecodeUnicode(rawValue.slice(WINDOW_NAME_PREFIX.length)));
    } catch (err) {
      return null;
    }
  }

  function loadInitialSnapshot() {
    return loadStateFromWindowName() || loadStateFromWindowContext() || loadStoredSnapshot();
  }

  function loadStateFromWindowName() {
    const payload = decodeWindowPayload(window.name);
    if (!payload || !payload.state) return null;
    return {
      state: hydrate(payload.state),
      meta: normalizeMeta(payload.meta, payload.savedAt, payload.source || 'window.name handoff')
    };
  }

  function loadStateFromWindowContext() {
    const refs = [];
    try { if (window.parent && window.parent !== window) refs.push(window.parent); } catch (err) { }
    try { if (window.opener && !window.opener.closed) refs.push(window.opener); } catch (err) { }
    for (const ref of refs) {
      try {
        const state = ref.__splunkPsProjectState__ || ref.__SPLUNK_PS_PROJECT_STATE__ || null;
        if (state && typeof state === 'object') {
          const meta = ref.__splunkPsProjectMeta__ || ref.__SPLUNK_PS_PROJECT_META__ || {};
          return { state: hydrate(state), meta: normalizeMeta(meta, meta.savedAt, meta.source || 'window context') };
        }
      } catch (err) { }
    }
    return null;
  }

  function loadStoredSnapshot() {
    const stores = [];
    try { stores.push(sessionStorage); } catch (err) { }
    try { stores.push(localStorage); } catch (err) { }
    for (const store of stores) {
      try {
        if (!store) continue;
        const rawState = store.getItem(WORKSPACE_STATE_KEY) || store.getItem(STORAGE_KEY);
        if (!rawState) continue;
        const rawMeta = store.getItem(WORKSPACE_META_KEY) || store.getItem(STORAGE_META_KEY);
        const meta = rawMeta ? JSON.parse(rawMeta) : {};
        return { state: hydrate(JSON.parse(rawState)), meta: normalizeMeta(meta, meta.savedAt, meta.source || 'browser storage') };
      } catch (err) { }
    }
    return null;
  }

  function normalizeMeta(meta, savedAt, source) {
    const raw = meta && typeof meta === 'object' ? meta : {};
    return Object.assign({}, raw, {
      savedAt: savedAt || raw.savedAt || new Date().toISOString(),
      source: source || raw.source || 'support view'
    });
  }

  function hydrate(input) {
    const next = JSON.parse(JSON.stringify(DEFAULTS));
    const src = input || {};
    next.meta = Object.assign({}, DEFAULTS.meta, src.meta || {});
    next.globals = Object.assign({}, DEFAULTS.globals, src.globals || {});
    next.cluster = Object.assign({}, DEFAULTS.cluster, src.cluster || {});
    next.security = Object.assign({}, DEFAULTS.security, src.security || {});
    next.sites = Array.isArray(src.sites) ? src.sites : [];
    next.components = Array.isArray(src.components) ? src.components : [];
    next.dataSources = Array.isArray(src.dataSources) ? src.dataSources : [];
    return next;
  }

  function applyIncomingState(rawState, rawMeta, savedAt, source) {
    if (!rawState || typeof rawState !== 'object') return;
    snapshot = {
      state: hydrate(rawState),
      meta: normalizeMeta(rawMeta, savedAt, source)
    };
    persistSnapshot();
    stopRequestLoop();
    render();
  }

  function persistSnapshot() {
    if (!snapshot || !snapshot.state) return;
    const payload = {
      type: MESSAGE_STATE,
      state: snapshot.state,
      meta: snapshot.meta || {},
      savedAt: snapshot.meta && snapshot.meta.savedAt ? snapshot.meta.savedAt : new Date().toISOString(),
      source: snapshot.meta && snapshot.meta.source ? snapshot.meta.source : 'support view'
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot.state)); } catch (err) { }
    try { localStorage.setItem(STORAGE_META_KEY, JSON.stringify(snapshot.meta || {})); } catch (err) { }
    try { localStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify(snapshot.state)); } catch (err) { }
    try { localStorage.setItem(WORKSPACE_META_KEY, JSON.stringify(snapshot.meta || {})); } catch (err) { }
    try { sessionStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify(snapshot.state)); } catch (err) { }
    try { sessionStorage.setItem(WORKSPACE_META_KEY, JSON.stringify(snapshot.meta || {})); } catch (err) { }
    try { window.name = encodeWindowPayload(payload); } catch (err) { }
    try { window.__splunkPsProjectState__ = JSON.parse(JSON.stringify(snapshot.state)); } catch (err) { }
    try { window.__splunkPsProjectMeta__ = JSON.parse(JSON.stringify(snapshot.meta || {})); } catch (err) { }
    try { window.__SPLUNK_PS_PROJECT_STATE__ = window.__splunkPsProjectState__; } catch (err) { }
    try { window.__SPLUNK_PS_PROJECT_META__ = window.__splunkPsProjectMeta__; } catch (err) { }
  }

  function requestLiveState() {
    const request = { type: MESSAGE_REQUEST, page: pageName() };
    try { if (window.parent && window.parent !== window) window.parent.postMessage(request, '*'); } catch (err) { }
    try { if (window.opener && !window.opener.closed) window.opener.postMessage(request, '*'); } catch (err) { }
    try { if (channel) channel.postMessage(request); } catch (err) { }
  }

  function startRequestLoop() {
    stopRequestLoop();
    requestAttempts = 0;
    requestTimer = window.setInterval(() => {
      if (snapshot && snapshot.state) {
        stopRequestLoop();
        return;
      }
      requestAttempts += 1;
      const direct = loadStateFromWindowContext() || loadStateFromWindowName() || loadStoredSnapshot();
      if (direct) {
        applyIncomingState(direct.state, direct.meta, direct.meta && direct.meta.savedAt, direct.meta && direct.meta.source || 'recovered state');
        return;
      }
      requestLiveState();
      if (requestAttempts >= 10) stopRequestLoop();
    }, 400);
  }

  function stopRequestLoop() {
    if (!requestTimer) return;
    window.clearInterval(requestTimer);
    requestTimer = null;
  }

  function bindCopyButtons() {
    document.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.type = 'button';
      btn.textContent = 'Copy';
      btn.addEventListener('click', async () => {
        const text = pre.innerText.trim();
        try {
          await navigator.clipboard.writeText(text);
          const old = btn.textContent;
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = old; }, 1200);
        } catch (err) {
          btn.textContent = 'Copy failed';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
        }
      });
      pre.appendChild(btn);
    });
  }

  function pageName() {
    return (document.body && document.body.dataset && document.body.dataset.page) || 'guide';
  }

  function render() {
    const ctx = snapshot && snapshot.state ? buildContext(snapshot.state, snapshot.meta || {}) : null;
    renderStateStatus(ctx);
    renderSummary(ctx);
    renderLiveContext(ctx);
    applyPageSpecificEnhancements(ctx);
    bindCopyButtons();
    if (ctx) notifyHostViewSync(ctx);
  }

  function buildContext(state, meta) {
    const ctx = { state, meta, page: pageName() };
    ctx.components = Array.isArray(state.components) ? state.components.slice().sort(sortComponents) : [];
    ctx.dataSources = Array.isArray(state.dataSources) ? state.dataSources.slice() : [];
    ctx.sites = Array.isArray(state.sites) ? state.sites.slice() : [];
    ctx.byRole = role => ctx.components.filter(comp => comp.role === role);
    ctx.control = {
      loadBalancer: ctx.byRole('load_balancer')[0] || null,
      clusterManager: ctx.byRole('cluster_manager')[0] || null,
      deployer: ctx.byRole('deployer')[0] || null,
      deploymentServer: ctx.byRole('deployment_server')[0] || null,
      monitoringConsole: ctx.byRole('monitoring_console')[0] || null,
      licenseManager: ctx.byRole('license_manager')[0] || ctx.byRole('license_only_peer')[0] || null,
      searchHeads: ctx.byRole('search_head'),
      indexers: ctx.byRole('indexer'),
      heavyForwarders: uniqueById(ctx.byRole('heavy_forwarder').concat(ctx.byRole('hec_gateway'))),
      universalForwarders: ctx.byRole('universal_forwarder')
    };
    ctx.paths = {
      enterpriseHome: state.globals.enterpriseHome || '/opt/splunk',
      forwarderHome: state.globals.forwarderHome || '/opt/splunkforwarder',
      dsRepo: (state.globals.enterpriseHome || '/opt/splunk') + '/etc/deployment-apps',
      cmRepo: (state.globals.enterpriseHome || '/opt/splunk') + '/etc/manager-apps',
      shcRepo: (state.globals.enterpriseHome || '/opt/splunk') + '/etc/shcluster/apps',
      appRepo: (state.globals.enterpriseHome || '/opt/splunk') + '/etc/apps',
      systemLocal: (state.globals.enterpriseHome || '/opt/splunk') + '/etc/system/local'
    };
    ctx.roleCounts = ROLE_ORDER.map(role => ({ role, label: roleLabel(role), count: ctx.byRole(role).length })).filter(item => item.count > 0);
    ctx.naming = buildNamingContext(ctx);
    ctx.targets = buildTargetContext(ctx);
    ctx.readiness = buildReadinessFindings(ctx);
    return ctx;
  }

  function renderStateStatus(ctx) {
    const root = document.getElementById('stateStatus');
    if (!root) return;
    if (!ctx) {
      root.innerHTML = EMBEDDED_MODE
        ? '<div class="callout warn"><strong>Waiting for the live studio state.</strong> The original static page is still available below. As soon as the active project state arrives from the studio, the live environment cards will populate automatically.</div>'
        : '<div class="callout warn"><strong>Static page is available, but no live project state was detected yet.</strong> Import the environment in <code>index.html</code> under <strong>Import, export, and presets</strong>, then open this page from the studio to layer the exact active environment on top of the original guide.</div>';
      return;
    }
    const customer = esc(ctx.state.meta.customerShortName || ctx.state.meta.customerName || ctx.state.meta.deploymentName || 'customer');
    const env = esc(ctx.state.meta.environment || 'environment');
    const savedAt = esc(formatTime(ctx.meta.savedAt));
    const source = esc(ctx.meta.source || 'active project state');
    root.innerHTML = '<div class="callout good"><strong>Live project context active.</strong> Customer <code>' + customer + '</code> in <code>' + env + '</code> was loaded from <code>' + source + '</code> at <code>' + savedAt + '</code>. The static page remains visible below, and the live cards now reflect the exact imported environment from the studio.</div>';
  }

  function renderSummary(ctx) {
    const root = document.getElementById('summaryGrid');
    if (!root) return;
    if (!ctx) {
      root.innerHTML = '';
      return;
    }
    const metrics = [
      { value: esc(ctx.state.meta.customerShortName || ctx.state.meta.customerName || ctx.state.meta.deploymentName || 'n/a'), label: 'Customer / short name' },
      { value: String(ctx.components.length), label: 'Components in active inventory' },
      { value: String(ctx.dataSources.length), label: 'Data sources in active inventory' },
      { value: esc((ctx.state.meta.topologyPattern || 'topology') + ' · ' + (ctx.state.meta.splunkVersion || 'version')), label: 'Topology and Splunk version' }
    ];
    root.innerHTML = metrics.map(metric => '<div class="metric"><div class="value">' + metric.value + '</div><div class="label">' + esc(metric.label) + '</div></div>').join('');
  }

  function renderLiveContext(ctx) {
    const root = document.getElementById('liveContext');
    if (!root) return;
    if (!ctx) {
      root.innerHTML = '<div class="card"><div class="section-title"><div><h2>How live state works</h2><p class="muted">The imported environment already lives in <strong>index.html</strong>. These support pages stay useful even without live state, and they become environment-aware when the active project is handed over from the studio.</p></div></div><div class="grid-2"><div class="inline-note"><strong>Source of truth</strong><br />Import JSON, TXT, Components CSV, or Data Sources CSV in <code>index.html</code> under <strong>Import, export, and presets</strong>. That imported project is the environment this page tries to read.</div><div class="inline-note"><strong>Why the problem started after the dynamic update</strong><br />The static pages worked without state. The fully dynamic version depended on cross-page state handoff. This page now keeps the original static content and only layers live data on top when that handoff succeeds.</div></div></div>';
      return;
    }
    if (ctx.page === 'sop') {
      root.innerHTML = renderSopContext(ctx);
      return;
    }
    if (ctx.page === 'cli') {
      root.innerHTML = renderCliContext(ctx);
      return;
    }
    root.innerHTML = renderGuideContext(ctx);
  }

  function renderGuideContext(ctx) {
    const envRows = [
      ['Deployment name', ctx.state.meta.deploymentName || 'n/a'],
      ['Customer name', ctx.state.meta.customerName || 'n/a'],
      ['Customer short name', ctx.state.meta.customerShortName || 'n/a'],
      ['Environment', ctx.state.meta.environment || 'n/a'],
      ['Topology pattern', ctx.state.meta.topologyPattern || 'n/a'],
      ['Platform', ctx.state.meta.platform || 'n/a'],
      ['Splunk version', ctx.state.meta.splunkVersion || 'n/a'],
      ['SSH user', sshUser(ctx)],
      ['SSH password', sshPassword(ctx)],
      ['Splunk admin user', adminUser(ctx)],
      ['Splunk admin password', adminPassword(ctx)],
      ['Runtime user', runtimeUser(ctx)],
      ['SSH target preference', ctx.state.globals.usePublicIpForSsh ? 'Public IP first' : 'Private IP first'],
      ['Splunk target preference', ctx.state.globals.usePrivateIpForSplunk ? 'Private IP first' : 'Public IP first'],
      ['Receiver / HEC ports', (ctx.state.globals.receiverPort || '9997') + ' / ' + (ctx.state.globals.hecPort || '8088')],
      ['State source', ctx.meta.source || 'n/a'],
      ['Last sync', formatTime(ctx.meta.savedAt)]
    ];

    const controlRows = [
      ctx.control.loadBalancer,
      ctx.control.clusterManager,
      ctx.control.deployer,
      ctx.control.deploymentServer,
      ctx.control.monitoringConsole,
      ctx.control.licenseManager
    ].filter(Boolean).map(comp => [roleLabel(comp.role), comp.hostname || 'n/a', hostValue(comp, ctx, 'ssh'), hostValue(comp, ctx, 'splunk'), comp.site || 'n/a']);

    const componentRows = ctx.components.map(comp => [
      roleLabel(comp.role),
      comp.hostname || 'n/a',
      comp.publicIp || 'n/a',
      comp.privateIp || 'n/a',
      comp.site || 'n/a',
      comp.zone || 'n/a',
      comp.os || 'n/a',
      comp.targetGroup || 'n/a'
    ]);

    const dataRows = ctx.dataSources.map(ds => [
      ds.name || 'n/a',
      ds.category || 'n/a',
      ds.method || 'n/a',
      ds.collectionTier || 'n/a',
      ds.targetIndex || 'n/a',
      ds.sourcetype || 'n/a',
      ds.appName || 'n/a'
    ]);

    return '' +
      '<div class="card">' +
        '<div class="section-title"><div><h2>Live environment snapshot</h2><p class="muted">This section is generated from the active project imported in <strong>index.html</strong>. The original static guide remains below it.</p></div><div class="pills">' +
          pill('TLS ' + (ctx.state.security.tlsEnabled ? 'enabled' : 'disabled')) +
          pill('HEC ' + (ctx.state.security.hecEnabled ? 'enabled' : 'disabled')) +
          pill('Indexer clustering ' + (ctx.state.cluster.indexerClustering ? 'on' : 'off')) +
          pill('SHC ' + (ctx.state.cluster.searchHeadClustering ? 'on' : 'off')) +
        '</div></div>' +
        '<div class="grid-2">' +
          tableCard('Environment overview', ['Field', 'Value'], envRows) +
          tableCard('Control-plane hosts', ['Role', 'Hostname', 'SSH target', 'Splunk target', 'Site'], controlRows.length ? controlRows : [['No dedicated control-plane rows found', '-', '-', '-', '-']]) +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="section-title"><div><h2>Component inventory from the active environment</h2><p class="muted">These are the exact component rows currently active in the studio.</p></div></div>' +
        tableWrap(['Role', 'Hostname', 'Public IP', 'Private IP', 'Site', 'Zone', 'OS', 'Target group'], componentRows) +
      '</div>' +
      '<div class="card">' +
        '<div class="section-title"><div><h2>Data source inventory from the active environment</h2><p class="muted">These rows come from the active onboarding inventory and help explain what the support pages should reflect.</p></div></div>' +
        tableWrap(['Data source', 'Category', 'Method', 'Collection tier', 'Index', 'Sourcetype', 'App / TA'], dataRows.length ? dataRows : [['No active data-source rows found', '-', '-', '-', '-', '-', '-']]) +
      '</div>' +
      '<div class="card">' +
        '<div class="section-title"><div><h2>Placement and path summary</h2><p class="muted">Use these paths when you need to correlate the static guide with the current project layout.</p></div></div>' +
        '<div class="grid-2">' +
          tableCard('Bundle and app paths', ['Path purpose', 'Resolved path'], [
            ['Deployment server apps', ctx.paths.dsRepo],
            ['Cluster manager apps', ctx.paths.cmRepo],
            ['SHC deployer apps', ctx.paths.shcRepo],
            ['Local apps', ctx.paths.appRepo],
            ['System local', ctx.paths.systemLocal]
          ]) +
          '<div class="card" style="margin:0;"><h3>Real-time fetch note</h3><p class="muted">The support pages do not own the environment. They render the state imported in the studio. If the live cards do not match what you changed in the studio, reopen this page from the studio after the import or edit is applied.</p><ul class="list-tight"><li>Preferred import point: <code>index.html</code> → <strong>Import, export, and presets</strong></li><li>Preferred launch path: use the support-page buttons from the studio</li><li>Static fallback: the original guide remains readable even when live state is not detected</li></ul></div>' +
        '</div>' +
      '</div>';
  }

  function renderSopContext(ctx) {
    const steps = buildExecutionSteps(ctx);
    const stepRows = steps.map((step, idx) => [String(idx + 1), step.title, step.hosts, step.why]);
    const validationRows = buildValidationRows(ctx);
    const rollbackRows = buildRollbackRows(ctx);
    return '' +
      '<div class="card">' +
        '<div class="section-title"><div><h2>Live rollout context</h2><p class="muted">This overlay keeps the old SOP intact and adds the current customer environment, control-plane order, and validation focus from the active studio state.</p></div></div>' +
        '<div class="grid-2">' +
          tableCard('Current execution inputs', ['Field', 'Value'], [
            ['Customer', ctx.state.meta.customerShortName || ctx.state.meta.customerName || ctx.state.meta.deploymentName || 'n/a'],
            ['Environment', ctx.state.meta.environment || 'n/a'],
            ['SSH user', sshUser(ctx)],
            ['SSH password', sshPassword(ctx)],
            ['Splunk admin user', adminUser(ctx)],
            ['Splunk admin password', adminPassword(ctx)],
            ['Runtime user', runtimeUser(ctx)],
            ['Enterprise home', ctx.paths.enterpriseHome],
            ['Forwarder home', ctx.paths.forwarderHome],
            ['Receiver / HEC ports', (ctx.state.globals.receiverPort || '9997') + ' / ' + (ctx.state.globals.hecPort || '8088')],
            ['SSH target preference', ctx.state.globals.usePublicIpForSsh ? 'Public IP first' : 'Private IP first'],
            ['Splunk target preference', ctx.state.globals.usePrivateIpForSplunk ? 'Private IP first' : 'Public IP first'],
            ['Indexer clustering', ctx.state.cluster.indexerClustering ? 'Enabled' : 'Disabled'],
            ['Search head clustering', ctx.state.cluster.searchHeadClustering ? 'Enabled' : 'Disabled']
          ]) +
          tableCard('Current role counts', ['Role', 'Count'], ctx.roleCounts.map(item => [item.label, String(item.count)])) +
        '</div>' +
      '</div>' +
      renderReadinessCard(ctx, 'Generated topology readiness audit', 'This highlights obvious topology or sequencing gaps before you follow the static SOP below.') +
      '<div class="card">' +
        '<div class="section-title"><div><h2>Generated execution order</h2><p class="muted">Use this order when mapping the static SOP to the active customer environment.</p></div></div>' +
        tableWrap(['Step', 'Action', 'Primary hosts', 'Why this order matters'], stepRows) +
      '</div>' +
      '<div class="card">' +
        '<div class="section-title"><div><h2>Generated validation focus</h2><p class="muted">These checks are derived from the active roles and features in the current environment.</p></div></div>' +
        tableWrap(['Role / tier', 'Host', 'Validation focus', 'Suggested command or check'], validationRows) +
      '</div>' +
      '<div class="card">' +
        '<div class="section-title"><div><h2>Generated rollback focus</h2><p class="muted">These are the first places to back out or re-verify if the rollout deviates from plan.</p></div></div>' +
        tableWrap(['Scope', 'Primary hosts', 'Rollback thought process'], rollbackRows) +
      '</div>';
  }

  function renderCliContext(ctx) {
    const cards = buildCliCards(ctx);
    return '' +
      '<div class="card">' +
        '<div class="section-title"><div><h2>Live command context</h2><p class="muted">These command blocks are generated from the active imported environment. The static CLI reference stays below as the broader explanation layer.</p></div><div class="pills">' + pill('SSH user ' + sshUser(ctx)) + pill('Admin user ' + adminUser(ctx)) + pill('Enterprise home ' + ctx.paths.enterpriseHome) + pill('Forwarder home ' + ctx.paths.forwarderHome) + '</div></div>' +
        '<div class="grid-2">' +
          tableCard('Resolved credentials', ['Field', 'Value'], [
            ['SSH user', sshUser(ctx)],
            ['SSH password', sshPassword(ctx)],
            ['Splunk admin user', adminUser(ctx)],
            ['Splunk admin password', adminPassword(ctx)],
            ['Runtime user', runtimeUser(ctx)],
            ['Resolved -auth token', adminAuthDisplay(ctx)]
          ]) +
          tableCard('Resolved targeting and ports', ['Field', 'Value'], [
            ['SSH target source', ctx.state.globals.usePublicIpForSsh ? 'Public IP first' : 'Private IP first'],
            ['Splunk target source', ctx.state.globals.usePrivateIpForSplunk ? 'Private IP first' : 'Public IP first'],
            ['Receiver port', ctx.state.globals.receiverPort || '9997'],
            ['HEC port', ctx.state.globals.hecPort || '8088'],
            ['Deployment poll interval', ctx.state.globals.deploymentPollInterval || '60'],
            ['Management port assumption', '8089']
          ]) +
        '</div>' +
      '</div>' +
      renderReadinessCard(ctx, 'Generated project readiness audit', 'These checks catch missing roles, IP data, and sequencing dependencies before you copy commands from the live or static CLI sections.') +
      renderCliSequenceCard(ctx) +
      '<div class="card">' +
        '<div class="section-title"><div><h2>Generated command pack</h2><p class="muted">These command blocks now pull the live admin password and the current host-targeting rules from the imported environment.</p></div></div>' +
        '<div class="command-grid">' + cards.join('') + '</div>' +
      '</div>';
  }


  function applyPageSpecificEnhancements(ctx) {
    if (!ctx) return;
    if (ctx.page === 'cli') applyCliStaticResolution(ctx);
  }

  function applyCliStaticResolution(ctx) {
    const root = document.querySelector('.card.content');
    if (!root) return;
    const note = root.querySelector('.callout.warn');
    if (note) {
      note.innerHTML = '<strong>Static CLI cookbook with live token resolution:</strong> the executable blocks below now resolve Splunk homes, management targets, cluster manager URL, deployment server URL, first search-head URL, admin authentication, app names, example file names, config names, rollback files, contextual <code>&lt;target_home&gt;</code>, and contextual <code>&lt;target_fqdn&gt;</code> from the active imported environment. Keep editing the defaults when you intentionally want a different app, file, or troubleshooting target.';
    }
    root.querySelectorAll('pre code').forEach(block => {
      if (!block.dataset.originalText) block.dataset.originalText = block.textContent;
      const heading = cliHeadingForBlock(block);
      block.textContent = resolveCliStaticCommand(block.dataset.originalText, ctx, heading);
    });
    upsertCliResolutionPanel(root, ctx);
    upsertCliAuditPanel(root);
  }

  function upsertCliResolutionPanel(root, ctx) {
    let panel = document.getElementById('cliResolutionPanel');
    const html = '' +
      '<div class="card" style="margin:16px 0 0;">' +
        '<div class="section-title"><div><h3>Resolved static CLI tokens</h3><p class="muted">The cookbook below is now auto-mapped to the active environment and also receives contextual defaults for generic app, file, rollback, and troubleshooting tokens.</p></div><div class="pills">' + pill('Admin auth quoted') + pill('URLs mapped') + pill('Apps suggested') + pill('Troubleshooting targets mapped') + '</div></div>' +
        '<div class="grid-2">' +
          tableCard('Auto-resolved placeholders', ['Token', 'Resolved value', 'Source'], autoResolvedCliRows(ctx)) +
          tableCard('Contextual defaults you can still override', ['Token', 'Current default', 'Why this default was chosen'], manualCliRows(ctx)) +
        '</div>' +
      '</div>';
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'cliResolutionPanel';
      const firstHeading = root.querySelector('h2');
      if (firstHeading) root.insertBefore(panel, firstHeading);
      else root.prepend(panel);
    }
    panel.innerHTML = html;
  }

  function upsertCliAuditPanel(root) {
    let panel = document.getElementById('cliAuditPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'cliAuditPanel';
      const resolutionPanel = document.getElementById('cliResolutionPanel');
      if (resolutionPanel && resolutionPanel.nextSibling) root.insertBefore(panel, resolutionPanel.nextSibling);
      else root.prepend(panel);
    }
    const rows = cliAuditRows(root);
    if (!rows.length) {
      panel.innerHTML = '<div class="card" style="margin:16px 0 0;"><div class="callout good"><strong>Executable CLI block audit passed.</strong> No unresolved placeholder tokens remain inside the static command blocks after live resolution.</div></div>';
      return;
    }
    panel.innerHTML = '<div class="card" style="margin:16px 0 0;"><div class="section-title"><div><h3>Executable CLI block audit</h3><p class="muted">These unresolved placeholder tokens were still found after the live mapping pass and should be corrected before execution.</p></div></div>' + tableWrap(['Section', 'Remaining token(s)'], rows) + '</div>';
  }

  function cliAuditRows(root) {
    const rows = [];
    root.querySelectorAll('pre code').forEach(block => {
      const matches = Array.from(new Set((block.textContent.match(/<[^>\n]+>/g) || []).filter(Boolean)));
      if (!matches.length) return;
      rows.push([cliHeadingForBlock(block) || 'Command block', matches.join(', ')]);
    });
    return rows;
  }

  function cliHeadingForBlock(block) {
    const pre = block && block.closest ? block.closest('pre') : null;
    let node = pre ? pre.previousElementSibling : null;
    while (node) {
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'H3' || tag === 'H2') return node.textContent || '';
      node = node.previousElementSibling;
    }
    return '';
  }

  function resolveCliStaticCommand(originalText, ctx, heading) {
    let text = String(originalText || '');
    const authQuoted = shellQuote(adminAuthDisplay(ctx));
    const passwordQuoted = shellQuote(adminPassword(ctx));
    text = text.replace(/-auth\s+<admin>:<password>/g, '-auth ' + authQuoted);
    text = text.replace(/-u\s+<admin>:<password>/g, '-u ' + authQuoted);
    text = text.replace(/-remotePassword\s+<password>/g, '-remotePassword ' + passwordQuoted);
    const replacements = cliTokenReplacements(ctx, heading);
    Object.keys(replacements).forEach(token => {
      const value = replacements[token];
      if (!value || value === token) return;
      text = text.split(token).join(value);
    });
    return text;
  }

  function cliTokenReplacements(ctx, heading) {
    const resolved = cliCommandContext(ctx, heading);
    return {
      '<splunk_home>': ctx.paths.enterpriseHome,
      '<splunkforwarder_home>': ctx.paths.forwarderHome,
      '<cm_fqdn>': valueOrFallback(targetAddress(ctx.control.clusterManager, ctx), resolved.targetFqdn),
      '<deployment_server_fqdn>': valueOrFallback(targetAddress(ctx.control.deploymentServer, ctx), resolved.targetFqdn),
      '<sh1_fqdn>': valueOrFallback(targetAddress(ctx.control.searchHeads[0], ctx), resolved.targetFqdn),
      '<admin>': adminUser(ctx),
      '<password>': adminPassword(ctx),
      '<idxc_secret>': clusterDiscoverySecret(ctx),
      '<discovery_secret>': clusterDiscoverySecret(ctx),
      '<app>': resolved.app,
      '<file>': resolved.file,
      '<confname>': resolved.confname,
      '<conf_file>': resolved.confFile,
      '<site_overlay_app>': resolved.siteOverlayApp,
      '<target_home>': resolved.targetHome,
      '<target_fqdn>': resolved.targetFqdn
    };
  }

  function cliCommandContext(ctx, heading) {
    const h = String(heading || '').toLowerCase();
    const fallback = fallbackTargetComponent(ctx);
    const enterpriseClient = firstEnterpriseDeployClient(ctx);
    let targetComp = fallback;
    let targetHome = targetHomeForComponent(targetComp, ctx);
    let appKey = 'allForwarderOutputs';
    let file = 'outputs.conf';
    let confname = 'outputs';
    let confFile = 'outputs.conf';

    function setTarget(comp) {
      targetComp = comp || fallback;
      targetHome = targetHomeForComponent(targetComp, ctx);
    }

    if (h.includes('deployment server path') || h.includes('deployment server rollback')) {
      appKey = 'allForwarderOutputs';
      file = 'outputs.conf';
      confname = 'outputs';
      confFile = 'outputs.conf';
      setTarget(ctx.control.deploymentServer || fallback);
    } else if (h.includes('cluster manager path') || h.includes('peer registration example') || h.includes('peer-side validation') || h.includes('cluster manager rollback')) {
      appKey = 'clusterIndexerBase';
      file = 'server.conf';
      confname = 'server';
      confFile = 'server.conf';
      setTarget(ctx.control.clusterManager || ctx.control.indexers[0] || fallback);
    } else if (h.includes('shc deployer path') || h.includes('validate member state') || h.includes('push search-tier package from the deployer') || h.includes('shc deployer rollback')) {
      appKey = 'clusterSearchBase';
      file = 'server.conf';
      confname = 'server';
      confFile = 'server.conf';
      setTarget(ctx.control.searchHeads[0] || ctx.control.deployer || fallback);
    } else if (h.includes('set deploy-poll on an enterprise node')) {
      appKey = 'allDeploymentClient';
      file = 'deploymentclient.conf';
      confname = 'deploymentclient';
      confFile = 'deploymentclient.conf';
      setTarget(enterpriseClient || ctx.control.deploymentServer || fallback);
      targetHome = ctx.paths.enterpriseHome;
    } else if (h.includes('set deploy-poll on a universal forwarder')) {
      appKey = 'allDeploymentClient';
      file = 'deploymentclient.conf';
      confname = 'deploymentclient';
      confFile = 'deploymentclient.conf';
      setTarget(ctx.control.universalForwarders[0] || fallback);
      targetHome = ctx.control.universalForwarders[0] ? ctx.paths.forwarderHome : targetHome;
    } else if (h.includes('validate outputs, inputs, and deploymentclient settings')) {
      appKey = 'allForwarderOutputs';
      file = 'outputs.conf';
      confname = 'outputs';
      confFile = 'outputs.conf';
      setTarget(ctx.control.universalForwarders[0] || enterpriseClient || fallback);
    } else if (h.includes('forwarder indexer-discovery example')) {
      appKey = 'clusterForwarderOutputs';
      file = 'outputs.conf';
      confname = 'outputs';
      confFile = 'outputs.conf';
      setTarget(ctx.control.universalForwarders[0] || ctx.control.heavyForwarders[0] || enterpriseClient || fallback);
    } else if (h.includes('manager-local') || h.includes('multisite overlay')) {
      appKey = ctx.state.cluster.multisite ? 'multisiteManagerBase' : 'clusterManagerBase';
      file = 'server.conf';
      confname = 'server';
      confFile = 'server.conf';
      setTarget(ctx.control.clusterManager || fallback);
    } else if (h.includes('license-peer')) {
      appKey = 'fullLicenseServer';
      file = 'server.conf';
      confname = 'server';
      confFile = 'server.conf';
      setTarget(ctx.control.licenseManager || ctx.control.clusterManager || enterpriseClient || fallback);
    } else if (h.includes('peer-local site overlay')) {
      appKey = 'siteOverlay';
      file = 'server.conf';
      confname = 'server';
      confFile = 'server.conf';
      setTarget(ctx.control.indexers[0] || fallback);
    } else if (h.includes('local app path') || h.includes('local app rollback')) {
      appKey = 'clusterManagerBase';
      file = 'server.conf';
      confname = 'server';
      confFile = 'server.conf';
      setTarget(primaryEnterpriseComponent(ctx) || fallback);
    } else if (h.includes('generic health pack') || h.includes('log triage') || h.includes('network and listener checks') || h.includes('config precedence check')) {
      appKey = 'clusterManagerBase';
      file = 'server.conf';
      confname = 'server';
      confFile = 'server.conf';
      setTarget(firstNetworkTargetComponent(ctx) || fallback);
    }

    return {
      app: suggestedAppName(ctx, appKey),
      file,
      confname,
      confFile,
      siteOverlayApp: suggestedAppName(ctx, 'siteOverlay'),
      targetHome,
      targetFqdn: valueOrFallback(targetAddress(targetComp, ctx), 'localhost')
    };
  }

  function autoResolvedCliRows(ctx) {
    const generic = cliCommandContext(ctx, 'Network and listener checks');
    const ds = cliCommandContext(ctx, 'Deployment Server path');
    const shc = cliCommandContext(ctx, 'SHC deployer path');
    return [
      ['<splunk_home>', ctx.paths.enterpriseHome, 'Enterprise nodes'],
      ['<splunkforwarder_home>', ctx.paths.forwarderHome, 'Universal forwarders'],
      ['<cm_fqdn>', cliResolvedValue(targetAddress(ctx.control.clusterManager, ctx), generic.targetFqdn), ctx.control.clusterManager ? ctx.control.clusterManager.hostname + ' management target' : 'Fallback troubleshooting target'],
      ['<deployment_server_fqdn>', cliResolvedValue(targetAddress(ctx.control.deploymentServer, ctx), generic.targetFqdn), ctx.control.deploymentServer ? ctx.control.deploymentServer.hostname + ' management target' : 'Fallback troubleshooting target'],
      ['<sh1_fqdn>', cliResolvedValue(targetAddress(ctx.control.searchHeads[0], ctx), shc.targetFqdn), ctx.control.searchHeads.length ? ctx.control.searchHeads[0].hostname + ' management target' : 'Fallback troubleshooting target'],
      ['<admin>:<password>', adminAuthDisplay(ctx), 'Rendered as quoted auth in command blocks'],
      ['<idxc_secret>', cliResolvedValue(clusterDiscoverySecret(ctx), '<idxc_secret>'), 'Indexer cluster or discovery secret'],
      ['<discovery_secret>', cliResolvedValue(clusterDiscoverySecret(ctx), '<discovery_secret>'), 'Forwarder indexer-discovery secret'],
      ['<target_home>', generic.targetHome, 'Contextual troubleshooting home'],
      ['<target_fqdn>', generic.targetFqdn, 'Contextual troubleshooting target'],
      ['<app>', ds.app, 'Default example app in DS path and rollback blocks'],
      ['<site_overlay_app>', suggestedAppName(ctx, 'siteOverlay'), 'Per-site peer overlay app'],
      ['<file>', ds.file, 'Default example file in copy commands'],
      ['<confname>', generic.confname, 'Default btool family'],
      ['<conf_file>', ds.confFile, 'Default rollback file example']
    ];
  }

  function manualCliRows(ctx) {
    const ds = cliCommandContext(ctx, 'Deployment Server path');
    const cm = cliCommandContext(ctx, 'Cluster Manager path');
    const shc = cliCommandContext(ctx, 'SHC deployer path');
    const local = cliCommandContext(ctx, 'Local app path');
    return [
      ['Deployment-server app example', ds.app + ' / ' + ds.file, 'Most forwarder environments need outputs.conf or deploymentclient.conf staged under deployment-apps'],
      ['Cluster-manager app example', cm.app + ' / ' + cm.file, 'Clustered indexer examples default to the current cluster-indexer baseline app'],
      ['SHC app example', shc.app + ' / ' + shc.file, 'Search-tier bundle examples default to the current SHC baseline app'],
      ['Local app example', local.app + ' / ' + local.file, 'Local app examples default to an enterprise-node server.conf payload'],
      ['Troubleshooting target', cliCommandContext(ctx, 'Network and listener checks').targetFqdn, 'The generic health and network sections now choose a real management target instead of leaving <target_fqdn> blank'],
      ['Troubleshooting home', cliCommandContext(ctx, 'Validate outputs, inputs, and deploymentclient settings').targetHome, 'Validation blocks choose Enterprise or UF home based on the active tier being checked']
    ];
  }

  function buildNamingContext(ctx) {
    const raw = ctx.state && ctx.state.meta ? (ctx.state.meta.customerShortName || ctx.state.meta.customerName || ctx.state.meta.deploymentName || 'customer') : 'customer';
    const customer = appSlug(String(raw).toLowerCase()) || 'customer';
    const siteSource = (ctx.control.searchHeads[0] && ctx.control.searchHeads[0].site) || (ctx.control.indexers[0] && ctx.control.indexers[0].site) || (ctx.sites[0] && ctx.sites[0].name) || 'site1';
    const siteToken = appSlug(String(siteSource).toLowerCase()) || 'site1';
    return {
      customer,
      siteToken,
      apps: {
        taSplunk: 'TA-' + customer + '_splunk',
        allForwarderOutputs: customer + '_all_forwarder_outputs',
        allDeploymentClient: customer + '_all_deploymentclient',
        clusterForwarderOutputs: customer + '_cluster_forwarder_outputs',
        clusterIndexerBase: customer + '_cluster_indexer_base',
        clusterManagerBase: customer + '_cluster_manager_base',
        clusterSearchBase: customer + '_cluster_search_base',
        multisiteManagerBase: customer + '_multisite_manager_base',
        fullLicenseServer: customer + '_full_license_server',
        managerDeploymentClient: customer + '_manager_deploymentclient',
        dsOutputs: customer + '_ds_outputs',
        siteOverlay: customer + '_' + siteToken + '_indexer_base'
      }
    };
  }

  function buildTargetContext(ctx) {
    return {
      primaryManagement: primaryManagementComponent(ctx),
      primaryEnterprise: primaryEnterpriseComponent(ctx),
      primaryNetwork: firstNetworkTargetComponent(ctx),
      primaryUf: ctx.control.universalForwarders[0] || null,
      primaryIngest: ctx.control.heavyForwarders[0] || ctx.control.indexers[0] || null
    };
  }

  function buildReadinessFindings(ctx) {
    const rows = [];
    const deployClients = ctx.components.filter(comp => !!comp.deploymentClient);
    if (ctx.state.cluster.indexerClustering && !ctx.control.clusterManager) rows.push(['High', 'Indexer clustering', 'Indexer clustering is enabled in the environment, but no cluster manager host exists in the active component inventory.']);
    if (ctx.state.cluster.indexerClustering && !ctx.control.indexers.length) rows.push(['High', 'Indexer tier', 'Indexer clustering is enabled, but no indexer peers exist in the active component inventory.']);
    if (ctx.state.cluster.searchHeadClustering && !ctx.control.deployer) rows.push(['High', 'Search head clustering', 'Search head clustering is enabled, but no deployer host exists in the active component inventory.']);
    if (ctx.state.cluster.searchHeadClustering && ctx.control.searchHeads.length && ctx.control.searchHeads.length < 3) rows.push(['Medium', 'Search head cluster size', 'The active environment has fewer than three search heads, so SHC resilience and captain elections may not match the intended design.']);
    if (deployClients.length && !ctx.control.deploymentServer) rows.push(['Medium', 'Deployment server', 'One or more hosts are marked as deployment clients, but no deployment server host exists in the current inventory.']);
    if ((ctx.control.universalForwarders.length || ctx.control.heavyForwarders.length) && !(ctx.control.heavyForwarders.length || ctx.control.indexers.length)) rows.push(['High', 'Receiving tier', 'Forwarding components exist, but no heavy forwarder or indexer tier is available as a receiving target.']);
    if (ctx.state.cluster.multisite && !ctx.sites.length) rows.push(['High', 'Multisite topology', 'Multisite is enabled, but the sites list is empty.']);
    if (ctx.state.cluster.multisite && ctx.components.some(comp => ['cluster_manager', 'search_head', 'indexer'].includes(comp.role) && !comp.site)) rows.push(['Medium', 'Site assignment', 'Multisite is enabled, but one or more control-plane or cluster members are missing a site value.']);
    if (ctx.state.globals.usePublicIpForSsh && ctx.components.some(comp => !comp.publicIp)) rows.push(['Medium', 'SSH addressing', 'SSH is configured to prefer public IPs, but one or more components do not have a public IP value.']);
    if (ctx.state.globals.usePrivateIpForSplunk && ctx.components.some(comp => !comp.privateIp)) rows.push(['Medium', 'Splunk addressing', 'Splunk communication is configured to prefer private IPs, but one or more components do not have a private IP value.']);
    if (!ctx.control.searchHeads.length && ctx.dataSources.length) rows.push(['Low', 'Search tier', 'Data sources exist in the environment, but no search head tier exists for search-time knowledge, dashboards, or user validation.']);
    if (!rows.length) rows.push(['OK', 'Topology readiness', 'No obvious control-plane, addressing, or sequencing gaps were detected in the current imported environment.']);
    return rows;
  }

  function renderReadinessCard(ctx, title, subtitle) {
    return '<div class="card">' +
      '<div class="section-title"><div><h2>' + esc(title) + '</h2><p class="muted">' + esc(subtitle) + '</p></div></div>' +
      tableWrap(['Severity', 'Area', 'Observation'], ctx.readiness) +
      '</div>';
  }

  function renderCliSequenceCard(ctx) {
    return '<div class="card">' +
      '<div class="section-title"><div><h2>Generated command sequence</h2><p class="muted">Use this order before dropping into the static cookbook below. It closes the main sequencing gaps that usually appear after dynamic environment mapping.</p></div></div>' +
      tableWrap(['Phase', 'Action', 'Run on', 'Why first / next'], buildCliSequenceRows(ctx)) +
      '</div>';
  }

  function buildCliSequenceRows(ctx) {
    const rows = [];
    rows.push(['1', 'Confirm the imported topology, credentials, and target preference', 'index.html and the live command context above', 'This makes sure every later command resolves against the same active environment and not an older browser state.']);
    if (ctx.control.deploymentServer) rows.push(['2', 'Reload deployment-server content after any deployment-app changes', ctx.control.deploymentServer.hostname, 'Deployment clients should not phone home to stale deployment-apps content.']);
    if (ctx.control.clusterManager) rows.push(['3', 'Validate or apply the cluster-manager bundle before peer-side checks', ctx.control.clusterManager.hostname, 'Cluster-wide bundle status should be clean before indexers or search heads are validated.']);
    if (ctx.control.deployer && ctx.control.searchHeads.length) rows.push(['4', 'Validate SHC state and apply the deployer bundle', ctx.control.deployer.hostname + ' -> ' + hostList(ctx.control.searchHeads), 'Search-tier apps should be staged before final search validation and UI checks.']);
    const enterpriseClient = firstEnterpriseDeployClient(ctx);
    if (ctx.control.deploymentServer && enterpriseClient) rows.push(['5', 'Refresh deployment-client configuration on Enterprise nodes when needed', enterpriseClient.hostname, 'Enterprise-node deployment clients should point at the current deployment server before restart and validation.']);
    if (ctx.control.deploymentServer && ctx.control.universalForwarders.length) rows.push(['6', 'Refresh deployment-client configuration on the forwarder tier', hostList(ctx.control.universalForwarders), 'Forwarders often fail silently when deploy-poll or deploymentclient.conf is out of date.']);
    const receiver = ctx.control.heavyForwarders[0] || ctx.control.indexers[0];
    if (receiver) rows.push(['7', 'Confirm or enable the receiving/listener tier', receiver.hostname, 'Listener and forwarding ports should be validated before source teams begin sending data.']);
    rows.push(['8', 'Run post-change health, network, and config-precedence checks', (ctx.targets.primaryNetwork && ctx.targets.primaryNetwork.hostname) || 'primary management target', 'This catches remaining target_home and target_fqdn mistakes before handover.']);
    return rows;
  }

  function appSlug(value) {
    return String(value == null ? '' : value)
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_');
  }

  function firstDefined(items) {
    return (items || []).find(Boolean) || null;
  }

  function primaryManagementComponent(ctx) {
    return firstDefined([
      ctx.control.clusterManager,
      ctx.control.searchHeads[0],
      ctx.control.deploymentServer,
      ctx.control.deployer,
      ctx.control.monitoringConsole,
      ctx.control.licenseManager,
      ctx.control.indexers[0],
      ctx.control.heavyForwarders[0],
      ctx.control.universalForwarders[0],
      ctx.control.loadBalancer
    ]);
  }

  function primaryEnterpriseComponent(ctx) {
    return firstDefined([
      ctx.control.searchHeads[0],
      ctx.control.clusterManager,
      ctx.control.deploymentServer,
      ctx.control.deployer,
      ctx.control.indexers[0],
      ctx.control.heavyForwarders[0],
      ctx.control.monitoringConsole,
      ctx.control.licenseManager
    ]);
  }

  function firstNetworkTargetComponent(ctx) {
    return firstDefined([
      ctx.control.clusterManager,
      ctx.control.searchHeads[0],
      ctx.control.deploymentServer,
      ctx.control.indexers[0],
      ctx.control.heavyForwarders[0],
      ctx.control.universalForwarders[0],
      ctx.control.monitoringConsole,
      ctx.control.licenseManager,
      ctx.control.deployer
    ]);
  }

  function fallbackTargetComponent(ctx) {
    return firstDefined([firstNetworkTargetComponent(ctx), primaryEnterpriseComponent(ctx), ctx.control.universalForwarders[0], ctx.control.loadBalancer]);
  }

  function targetHomeForComponent(comp, ctx) {
    return comp && comp.role === 'universal_forwarder' ? ctx.paths.forwarderHome : ctx.paths.enterpriseHome;
  }

  function suggestedAppName(ctx, key) {
    const apps = ctx.naming && ctx.naming.apps ? ctx.naming.apps : {};
    return apps[key] || apps.allForwarderOutputs || 'customer_change_me';
  }

  function clusterDiscoverySecret(ctx) {
    return valueOrFallback(ctx.state.cluster.indexerDiscoverySecret || ctx.state.cluster.indexerClusterSecret, '');
  }

  function targetAddress(comp, ctx) {
    return comp ? splunkTarget(comp, ctx) : '';
  }

  function cliResolvedValue(value, fallback) {
    return valueOrFallback(value, fallback || 'n/a');
  }

  function buildExecutionSteps(ctx) {
    const steps = [];
    steps.push({ title: 'Confirm the imported environment and naming', hosts: 'index.html → Import, export, and presets', why: 'The support pages should reflect the same imported customer state before any operational work starts.' });
    if (ctx.control.deploymentServer) steps.push({ title: 'Validate deployment-server readiness', hosts: ctx.control.deploymentServer.hostname, why: 'Forwarder and optional enterprise client rollout usually depends on the deployment server being reachable and current.' });
    if (ctx.control.clusterManager) steps.push({ title: 'Validate cluster-manager control plane', hosts: ctx.control.clusterManager.hostname, why: 'Cluster status, peer bundle state, and cluster-wide config validation are anchored here.' });
    if (ctx.control.deployer && ctx.control.searchHeads.length) steps.push({ title: 'Stage or validate SHC deployer content', hosts: ctx.control.deployer.hostname + ' → ' + hostList(ctx.control.searchHeads), why: 'SHC changes should be coordinated before or together with search-tier validation.' });
    if (ctx.control.indexers.length) steps.push({ title: 'Validate indexer tier health and bundle effect', hosts: hostList(ctx.control.indexers), why: 'Indexer health, bundle status, and pipeline validation protect ingestion and search consistency.' });
    if (ctx.control.heavyForwarders.length) steps.push({ title: 'Validate heavy-forwarder and HEC/syslog collection tier', hosts: hostList(ctx.control.heavyForwarders), why: 'Collection-tier issues often surface before indexing and search symptoms are noticed.' });
    if (ctx.control.universalForwarders.length) steps.push({ title: 'Validate forwarder connectivity and deploy-poll behavior', hosts: hostList(ctx.control.universalForwarders), why: 'Edge collection fails silently if deploy-poll, network, or outputs paths are wrong.' });
    steps.push({ title: 'Run post-change validation and capture handover notes', hosts: ctx.control.monitoringConsole ? ctx.control.monitoringConsole.hostname : 'search tier / monitoring tier', why: 'The static SOP, validation pack, and troubleshooting notes should be updated against the exact environment that was changed.' });
    return steps;
  }

  function buildValidationRows(ctx) {
    const rows = [];
    if (ctx.control.clusterManager) rows.push(['Cluster Manager', ctx.control.clusterManager.hostname, 'Cluster health, peer status, bundle state', ctx.paths.enterpriseHome + '/bin/splunk show cluster-status --verbose -auth ' + adminAuth(ctx) + ' && ' + ctx.paths.enterpriseHome + '/bin/splunk show cluster-bundle-status -auth ' + adminAuth(ctx)]);
    if (ctx.control.deployer && ctx.control.searchHeads.length) rows.push(['Deployer / SHC', ctx.control.deployer.hostname, 'SHC bundle readiness and deployer sync', ctx.paths.enterpriseHome + '/bin/splunk show shcluster-status --verbose -auth ' + adminAuth(ctx) + ' && ' + ctx.paths.enterpriseHome + '/bin/splunk apply shcluster-bundle -target https://' + splunkTarget(ctx.control.searchHeads[0], ctx) + ':8089 -auth ' + adminAuth(ctx)]);
    ctx.control.searchHeads.forEach(comp => rows.push(['Search Head', comp.hostname, 'Search visibility, distributed search, UI and app placement', ctx.paths.enterpriseHome + '/bin/splunk show shcluster-status --verbose -auth ' + adminAuth(ctx) + ' && ' + ctx.paths.enterpriseHome + '/bin/splunk list search-server -auth ' + adminAuth(ctx)]));
    ctx.control.indexers.forEach(comp => rows.push(['Indexer', comp.hostname, 'Indexing, cluster membership, ports, queues', ctx.paths.enterpriseHome + '/bin/splunk status && ' + ctx.paths.enterpriseHome + '/bin/splunk btool server list --debug | head -n 20 && ' + ctx.paths.enterpriseHome + '/bin/splunk btool indexes list --debug | head -n 20']));
    ctx.control.heavyForwarders.forEach(comp => rows.push(['Heavy Forwarder / HEC', comp.hostname, 'Listener state, HEC health, parsing and forwarding', ctx.paths.enterpriseHome + '/bin/splunk display listen ' + (ctx.state.globals.receiverPort || '9997') + ' -auth ' + adminAuth(ctx) + ' && ' + ctx.paths.enterpriseHome + '/bin/splunk status']));
    ctx.control.universalForwarders.forEach(comp => rows.push(['Universal Forwarder', comp.hostname, 'Deploy-poll, outputs, app receipt', ctx.paths.forwarderHome + '/bin/splunk list deploy-poll -auth ' + adminAuth(ctx) + ' && ' + ctx.paths.forwarderHome + '/bin/splunk btool outputs list --debug | head -n 20']));
    return rows.length ? rows : [['Support page', 'n/a', 'No environment-specific validation rows were generated', 'Use the static SOP below']];
  }

  function buildRollbackRows(ctx) {
    const rows = [];
    if (ctx.control.deploymentServer) rows.push(['Deployment-server content', ctx.control.deploymentServer.hostname, 'Roll back the changed deployment-apps package, reload the deployment server, and confirm forwarders return to the last known good app set.']);
    if (ctx.control.clusterManager) rows.push(['Indexer-cluster content', ctx.control.clusterManager.hostname + (ctx.control.indexers.length ? ' → ' + hostList(ctx.control.indexers) : ''), 'Revert the changed manager-apps bundle or local config, push or reapply the last known good bundle, then recheck peer status before restarting peers.']);
    if (ctx.control.deployer && ctx.control.searchHeads.length) rows.push(['SHC deployer content', ctx.control.deployer.hostname + ' → ' + hostList(ctx.control.searchHeads), 'Restore the prior shcluster app package or deployer backup, reapply the previous SHC bundle, and verify captain and member health.']);
    if (ctx.control.heavyForwarders.length) rows.push(['Collection tier', hostList(ctx.control.heavyForwarders), 'Disable or revert changed inputs, HEC tokens, or parsing apps first, then validate forwarding resumes with the previous config state.']);
    return rows.length ? rows : [['General scope', 'n/a', 'Use the static SOP rollback section below together with the live component inventory once the environment is loaded.']];
  }

  function buildCliCards(ctx) {
    const cards = [];
    const sshUser = ctx.state.globals.sshUser || 'splunkadm';
    const enterpriseClient = firstEnterpriseDeployClient(ctx);
    if (ctx.control.clusterManager) {
      cards.push(cmdCard('SSH to Cluster Manager', ctx.control.clusterManager.hostname, 'Connect to the cluster manager that controls peer status and manager-app bundles.', 'ssh ' + sshUser + '@' + sshTarget(ctx.control.clusterManager, ctx)));
      cards.push(cmdCard('Cluster Manager Status', ctx.control.clusterManager.hostname, 'Check indexer-cluster health from the cluster manager.', ctx.paths.enterpriseHome + '/bin/splunk show cluster-status -auth ' + adminAuth(ctx)));
      if (ctx.state.cluster.indexerClustering) {
        cards.push(cmdCard('Peer Registration Example', ctx.control.indexers.length ? ctx.control.indexers[0].hostname : 'Indexer peer', 'Register an indexer peer against the active cluster manager using the resolved replication port and secret.', ctx.paths.enterpriseHome + '/bin/splunk edit cluster-config -mode peer -manager_uri https://' + splunkTarget(ctx.control.clusterManager, ctx) + ':8089 -replication_port ' + valueOrFallback(ctx.state.cluster.indexerReplicationPort, '9887') + ' -secret ' + shellQuote(clusterDiscoverySecret(ctx))));
        cards.push(cmdCard('Forwarder Indexer-Discovery Snippet', ctx.control.universalForwarders.length ? ctx.control.universalForwarders[0].hostname + ' outputs.conf' : 'outputs.conf', 'Resolved cluster-manager management URL and discovery secret for the forwarding tier.', '[tcpout]\ndefaultGroup = default-autolb-group\n\n[tcpout:default-autolb-group]\nindexerDiscovery = idxc1\nuseACK = true\n\n[indexer_discovery:idxc1]\nmanager_uri = https://' + splunkTarget(ctx.control.clusterManager, ctx) + ':8089\npass4SymmKey = ' + clusterDiscoverySecret(ctx)));
      }
    }
    if (ctx.control.deploymentServer) {
      cards.push(cmdCard('Deployment Server Reload', ctx.control.deploymentServer.hostname, 'Reload deployment-apps after app or TA changes for forwarders and optional enterprise clients.', ctx.paths.enterpriseHome + '/bin/splunk reload deploy-server -auth ' + adminAuth(ctx)));
      if (enterpriseClient) {
        cards.push(cmdCard('Set Deploy-Poll on Enterprise Client', enterpriseClient.hostname, 'Example enterprise-node deployment-client command pointed at the active deployment server.', ctx.paths.enterpriseHome + '/bin/splunk set deploy-poll ' + splunkTarget(ctx.control.deploymentServer, ctx) + ':8089 -auth ' + adminAuth(ctx) + '\n' + ctx.paths.enterpriseHome + '/bin/splunk restart'));
      }
    }
    if (ctx.control.deployer && ctx.control.searchHeads.length) {
      cards.push(cmdCard('Apply SHC Bundle', ctx.control.deployer.hostname, 'Push the latest deployer package to the search-head cluster.', ctx.paths.enterpriseHome + '/bin/splunk apply shcluster-bundle -target https://' + splunkTarget(ctx.control.searchHeads[0], ctx) + ':8089 -auth ' + adminAuth(ctx)));
      cards.push(cmdCard('SHC Deployer Path Example', ctx.control.deployer.hostname, 'Stage a search-tier app under the deployer and push it to the first search-head management target.', 'mkdir -p ' + ctx.paths.shcRepo + '/<app>/local\ncp <file> ' + ctx.paths.shcRepo + '/<app>/local/\n' + ctx.paths.enterpriseHome + '/bin/splunk show shcluster-status --verbose -auth ' + adminAuth(ctx) + '\n' + ctx.paths.enterpriseHome + '/bin/splunk apply shcluster-bundle -target https://' + splunkTarget(ctx.control.searchHeads[0], ctx) + ':8089 -auth ' + adminAuth(ctx)));
    }
    if (ctx.control.searchHeads.length) {
      cards.push(cmdCard('Search Head Status', ctx.control.searchHeads[0].hostname, 'Validate SHC or search-tier status from a search head.', ctx.paths.enterpriseHome + '/bin/splunk show shcluster-status -auth ' + adminAuth(ctx)));
    }
    if (ctx.control.indexers.length) {
      cards.push(cmdCard('Indexer Service Check', hostList(ctx.control.indexers), 'Validate Splunk service state on the indexing tier.', ctx.paths.enterpriseHome + '/bin/splunk status\n' + ctx.paths.enterpriseHome + '/bin/splunk btool server list --debug | head -n 20'));
    }
    if (ctx.control.universalForwarders.length && ctx.control.deploymentServer) {
      cards.push(cmdCard('Set Deploy-Poll on Universal Forwarder', ctx.control.universalForwarders[0].hostname, 'Example forwarder command that points to the active deployment server.', ctx.paths.forwarderHome + '/bin/splunk set deploy-poll ' + splunkTarget(ctx.control.deploymentServer, ctx) + ':8089 -auth ' + adminAuth(ctx) + '\n' + ctx.paths.forwarderHome + '/bin/splunk restart'));
    }
    if (ctx.control.heavyForwarders.length || ctx.control.indexers.length) {
      const listenerHost = ctx.control.heavyForwarders[0] || ctx.control.indexers[0];
      cards.push(cmdCard('Enable Forwarder Receiver', listenerHost.hostname, 'Enable or confirm the ' + valueOrFallback(ctx.state.globals.receiverPort, '9997') + ' receiver on the chosen ingest target.', ctx.paths.enterpriseHome + '/bin/splunk enable listen ' + (ctx.state.globals.receiverPort || '9997') + ' -auth ' + adminAuth(ctx)));
    }
    if (ctx.control.searchHeads.length && ctx.control.indexers.length && !ctx.state.cluster.indexerClustering) {
      cards.push(cmdCard('Add Search Peer Example', ctx.control.searchHeads[0].hostname, 'Example distributed-search pairing when indexers are not clustered.', ctx.paths.enterpriseHome + '/bin/splunk add search-server https://' + splunkTarget(ctx.control.indexers[0], ctx) + ':8089 -remoteUsername ' + adminUser(ctx) + ' -remotePassword ' + shellQuote(adminPassword(ctx)) + ' -auth ' + adminAuth(ctx)));
    }
    cards.push(cmdCard('Service Restart', 'Any enterprise node', 'Restart Splunk Enterprise after a controlled config change.', ctx.paths.enterpriseHome + '/bin/splunk restart'));
    cards.push(cmdCard('Service Restart (UF)', 'Any universal forwarder', 'Restart a universal forwarder after app or outputs changes.', ctx.paths.forwarderHome + '/bin/splunk restart'));
    cards.push(cmdCard('Enable Boot-Start', 'Any Splunk node', 'Ensure the Splunk service starts automatically with the expected runtime account.', ctx.paths.enterpriseHome + '/bin/splunk enable boot-start -user ' + runtimeUser(ctx)));
    return cards;
  }

  function notifyHostViewSync(ctx) {
    const detail = {
      type: MESSAGE_VIEW_SYNC,
      page: ctx.page,
      customer: ctx.state.meta.customerShortName || ctx.state.meta.customerName || ctx.state.meta.deploymentName || 'customer',
      components: ctx.components.length,
      dataSources: ctx.dataSources.length,
      savedAt: ctx.meta && ctx.meta.savedAt ? ctx.meta.savedAt : new Date().toISOString(),
      embedded: EMBEDDED_MODE
    };
    try { if (window.parent && window.parent !== window) window.parent.postMessage(detail, '*'); } catch (err) { }
    try { if (window.opener && !window.opener.closed) window.opener.postMessage(detail, '*'); } catch (err) { }
  }

  function sortComponents(a, b) {
    const roleDiff = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
    if (roleDiff !== 0) return roleDiff;
    return String(a.hostname || '').localeCompare(String(b.hostname || ''));
  }

  function uniqueById(items) {
    const seen = new Set();
    return items.filter(item => {
      const key = item && (item.id || item.hostname || JSON.stringify(item));
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function roleLabel(role) {
    return ROLE_LABELS[role] || role || 'Role';
  }

  function hostList(components) {
    return (components || []).map(comp => comp.hostname || 'host').join(', ');
  }

  function firstEnterpriseDeployClient(ctx) {
    const candidates = [].concat(ctx.control.searchHeads || [], ctx.control.heavyForwarders || [], ctx.control.indexers || [], ctx.control.monitoringConsole ? [ctx.control.monitoringConsole] : []);
    return candidates.find(comp => comp && comp.role !== 'universal_forwarder') || null;
  }

  function sshTarget(comp, ctx) {
    if (ctx.state.globals.usePublicIpForSsh && comp.publicIp) return comp.publicIp;
    return comp.privateIp || comp.publicIp || comp.hostname || 'host';
  }

  function splunkTarget(comp, ctx) {
    if (ctx.state.globals.usePrivateIpForSplunk && comp.privateIp) return comp.privateIp;
    return comp.publicIp || comp.privateIp || comp.hostname || 'host';
  }

  function hostValue(comp, ctx, mode) {
    return mode === 'ssh' ? sshTarget(comp, ctx) : splunkTarget(comp, ctx);
  }

  function valueOrFallback(value, fallback) {
    return value == null || value === '' ? fallback : String(value);
  }

  function shellQuote(value) {
    const normalized = valueOrFallback(value, '');
    return "'" + normalized.replace(/'/g, "'\''") + "'";
  }

  function sshUser(ctx) {
    return valueOrFallback(ctx.state.globals.sshUser, 'splunkadm');
  }

  function sshPassword(ctx) {
    return valueOrFallback(ctx.state.globals.sshPassword, '<ssh-password>');
  }

  function adminUser(ctx) {
    return valueOrFallback(ctx.state.globals.splunkAdminUser, 'admin');
  }

  function adminPassword(ctx) {
    return valueOrFallback(ctx.state.globals.splunkAdminPassword, '<password>');
  }

  function runtimeUser(ctx) {
    return valueOrFallback(ctx.state.globals.runtimeUser, 'splunk');
  }

  function adminAuthDisplay(ctx) {
    return adminUser(ctx) + ':' + adminPassword(ctx);
  }

  function adminAuth(ctx) {
    return shellQuote(adminAuthDisplay(ctx));
  }

  function formatTime(value) {
    const when = new Date(value || '');
    return Number.isNaN(when.getTime()) ? String(value || 'n/a') : when.toLocaleString();
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pill(text) {
    return '<span class="pill">' + esc(text) + '</span>';
  }

  function tableCard(title, headers, rows) {
    return '<div class="card" style="margin:0;">' +
      '<h3>' + esc(title) + '</h3>' +
      tableWrap(headers, rows) +
      '</div>';
  }

  function tableWrap(headers, rows) {
    return '<div class="table-wrap"><table class="data-table table-compact"><thead><tr>' + headers.map(head => '<th>' + esc(head) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(cell => '<td>' + esc(cell) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  }

  function cmdCard(title, runOn, why, command) {
    return '<div class="cmd-card"><h4>' + esc(title) + '</h4><div class="cmd-meta"><strong>Run on:</strong> ' + esc(runOn) + '<br /><strong>Why:</strong> ' + esc(why) + '</div><pre>' + esc(command) + '</pre></div>';
  }
})();
