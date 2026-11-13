<script lang="ts">
  // Admin area: overview, users (counts only), connectors in three groups, catalogue refresh.
  import { onMount } from 'svelte';
  import CookidooAccount from '../components/CookidooAccount.svelte';
  import Icon from '../components/Icon.svelte';
  import UserManager from '../components/UserManager.svelte';
  import ConnectorCard from '../components/ConnectorCard.svelte';
  import CountryPicker from '../components/CountryPicker.svelte';
  import TagEditor from '../components/TagEditor.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, fmtDate, lang, t } from '../lib/i18n';
  import { navigate } from '../lib/router.svelte';
  import { auth, loadMe, toast, ui } from '../lib/store.svelte';
  import type { AdminOverview, AdminUser, Connector, ConnectorKey, RefreshState, TechItem } from '../lib/types';

  // the connectors in four groups (by what they are for; the server's own `kind` is the fallback for a connector this list does not know)
  const GROUPS: { id: string; title: () => string; keys: ConnectorKey[] }[] = [
    { id: 'food', title: () => t('admGroupFood'), keys: ['openfoodfacts_lookup', 'openfoodfacts_catalog', 'bls', 'label_reader', 'vision'] },
    { id: 'recipes', title: () => t('admGroupRecipes'), keys: ['cookidoo', 'web_recipes'] },
    { id: 'import', title: () => t('admGroupImport'), keys: ['yazio_import', 'yazio_login', 'demo_data', 'demo_account'] },
    { id: 'interface', title: () => t('admGroupInterface'), keys: ['access_tokens', 'webhooks'] },
  ];
  const SWITCHES: ConnectorKey[] = ['openfoodfacts_lookup', 'access_tokens', 'webhooks', 'cookidoo', 'web_recipes', 'yazio_login', 'demo_account', 'vision'];
  // the environment variable behind each setting (see features.py), named in the technical notes when it fixes the setting
  const ENV_OF: Record<string, string> = {
    'openfoodfacts_lookup.enabled': 'MAHLWERK_OFF_LOOKUP', 'openfoodfacts_catalog.config.countries': 'MAHLWERK_OFF_COUNTRIES',
    'cookidoo.enabled': 'MAHLWERK_COOKIDOO', 'cookidoo.config.personal': 'MAHLWERK_COOKIDOO_PERSONAL', 'cookidoo.config.images': 'MAHLWERK_COOKIDOO_IMAGES',
    'web_recipes.enabled': 'MAHLWERK_WEB_RECIPES', 'web_recipes.config.images': 'MAHLWERK_WEB_RECIPES_IMAGES', 'yazio_login.enabled': 'MAHLWERK_YAZIO_LOGIN',
    'access_tokens.enabled': 'MAHLWERK_TOKENS', 'webhooks.enabled': 'MAHLWERK_WEBHOOKS', 'webhooks.config.hosts': 'MAHLWERK_WEBHOOK_HOSTS', 'demo_data.enabled': 'MAHLWERK_DEMO_DATA', 'demo_account.enabled': 'MAHLWERK_DEMO_ACCOUNT', 'vision.enabled': 'MAHLWERK_VISION',
  };
  const UNOFFICIAL: ConnectorKey[] = ['cookidoo', 'yazio_login'];
  const WITH_SETTINGS: ConnectorKey[] = ['openfoodfacts_catalog', 'cookidoo', 'web_recipes', 'yazio_import', 'yazio_login', 'webhooks', 'demo_account', 'vision'];

  let overview = $state<AdminOverview | null>(null);
  let users = $state<AdminUser[]>([]);
  let connectors = $state<Connector[]>([]);
  let refresh = $state<RefreshState | null>(null);
  let loaded = $state(false);
  let failed = $state('');
  let busy = $state('');
  let error = $state('');
  let poll = 0;

  const reason = (err: unknown) => (err instanceof ApiError ? (typeof err.detail === 'string' ? err.detail : err.status || err.message) : 'error');
  const isAdmin = $derived(ui.me?.is_admin === true);

  async function load() {
    failed = '';
    try {
      [overview, users, connectors, refresh] = await Promise.all([api.adminOverview(), api.adminUsers(), api.adminConnectors(), api.refreshState()]);
      loaded = true;
      watch();
    } catch (err) {
      failed = t('loadFailed', { reason: reason(err) });
    }
  }

  async function reloadUsers() {
    try { [users, overview] = await Promise.all([api.adminUsers(), api.adminOverview()]); } catch { /* the next load shows the error */ }
  }

  /** While a refresh runs, look at its state every two seconds; when it ends, reload the numbers once. */
  function watch() {
    clearInterval(poll);
    if (refresh?.state !== 'running') return;
    poll = window.setInterval(async () => {
      try {
        refresh = await api.refreshState();
        if (refresh.state !== 'running') {
          clearInterval(poll);
          [overview, connectors] = await Promise.all([api.adminOverview(), api.adminConnectors()]);
          void loadMe();
        }
      } catch { /* try again at the next tick */ }
    }, 2000);
  }

  onMount(() => {
    void (async () => {
      if (!ui.me) await loadMe();
      if (ui.me?.is_admin) await load(); else loaded = true;
    })();
    return () => clearInterval(poll);
  });

  async function patch(c: Connector, body: { enabled?: boolean; config?: Record<string, unknown> }) {
    busy = c.key;
    error = '';
    try {
      const next = await api.patchConnector(c.key, body);
      connectors = connectors.map((x) => (x.key === next.key ? next : x));
      if (body.enabled != null) void loadMe(); // the profile shows or hides the cards of switched-off features
      if (c.key === 'demo_account') void reloadUsers(); // the account appears in (stays in) the list
    } catch (err) {
      error = t('saveFailed', { reason: reason(err) });
    } finally {
      busy = '';
    }
  }

  /** The demo account's own actions: start the sample data over, or remove the account (asks first). */
  let demoConfirm = $state(false);
  async function demoAction(kind: 'reset' | 'delete') {
    if (kind === 'delete' && !demoConfirm) { demoConfirm = true; return; }
    busy = 'demo_account';
    error = '';
    try {
      const next = kind === 'reset' ? await api.resetDemoAccount() : await api.deleteDemoAccount();
      connectors = connectors.map((x) => (x.key === next.key ? next : x));
      demoConfirm = false;
      toast(kind === 'reset' ? t('admDemoResetDone') : t('admDemoDeleteDone'));
      void reloadUsers();
      void loadMe();
    } catch (err) {
      error = t('saveFailed', { reason: reason(err) });
    } finally {
      busy = '';
    }
  }

  async function reloadConnectors() {
    try { connectors = await api.adminConnectors(); } catch { /* the next load shows the error */ }
  }

  async function startRefresh() {
    busy = 'refresh';
    error = '';
    try {
      refresh = await api.startRefresh();
      toast(t('admRefreshStarted'));
      watch();
    } catch (err) {
      error = err instanceof ApiError && err.status === 409 ? t('admRefreshBusy') : t('saveFailed', { reason: reason(err) });
      try { refresh = await api.refreshState(); watch(); } catch { /* keep what we know */ }
    } finally {
      busy = '';
    }
  }

  const size = (bytes: number) => (bytes >= 1048576 ? `${fmt(bytes / 1048576, 1)} MB` : `${fmt(Math.max(1, Math.round(bytes / 1024)))} KB`);
  const stand = (unix: number | null) => (unix ? t('admStand', { date: fmtDate(unix) }) : t('admNoFile'));
  const clock = (unix: number) => new Date(unix * 1000).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const day = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(lang, { day: '2-digit', month: '2-digit', year: '2-digit' }) : '–');
  const locked = (c: Connector, what: string) => c.locked.includes(what);
  type K = Parameters<typeof t>[0];
  const count = (n: number, one: K, many: K) => (n === 1 ? t(one) : t(many, { n: fmt(n) }));
  const fact = (c: Connector): string => {
    if (c.key === 'demo_account') return c.info.exists ? t('admDemoFact', { n: fmt(Number(c.info.entries ?? 0)), date: day(String(c.info.last_day ?? '') || null) }) : '';
    const i = c.info as Record<string, number | null>;
    switch (c.key) {
      case 'openfoodfacts_catalog':
      case 'bls': return i.products ? `${t('admProducts', { n: fmt(i.products as number) })} · ${stand(i.updated_at)}` : t('admNoFile');
      case 'yazio_import': return count(i.batches as number, 'admBatch1', 'admBatches');
      case 'access_tokens': return count(i.active as number, 'admKey1', 'admActiveKeys');
      case 'webhooks': return count(i.hooks as number, 'admHook1', 'admHooksN');
      case 'vision': return c.info.model ? t('admVisionModel', { model: String(c.info.model) }) : '';
      default: return '';
    }
  };
  /** One look for every state: lime = works, grey = off, outlined = something to do, filled = failed. */
  const tone = (c: Connector): 'on' | 'off' | 'todo' | 'bad' =>
    c.status === 'ok' || c.status === 'running' || c.status === 'ready' || c.status === 'upload' ? 'on'
      : c.status === 'error' ? 'bad' : c.status === 'off' ? 'off' : 'todo';
  const account = (c: Connector) => (c.info.account ?? null) as { source?: string; key?: string | null } | null;
  /** Settings that the environment fixes: the variable names, for the technical notes. */
  const fixedBy = (c: Connector): string[] => [...new Set(c.locked.map((what) => ENV_OF[`${c.key}.${what}`]).filter(Boolean))];
  const switchLocked = (c: Connector) => c.key === 'demo_data' || locked(c, 'enabled');
  const hasSwitch = (c: Connector) => (c.configurable && SWITCHES.includes(c.key)) || c.key === 'demo_data';
  const tech = (c: Connector): TechItem[] => {
    const out: TechItem[] = [];
    if (c.key === 'cookidoo') {
      if (c.status === 'not_installed') out.push({ text: t('admTechInstall'), cmd: 'pip install "mahlwerk[cookidoo]"' });
      if (account(c)?.source === 'env') out.push({ text: t('admTechCookidooEnv'), cmd: 'MAHLWERK_COOKIDOO_EMAIL, MAHLWERK_COOKIDOO_PASSWORD, MAHLWERK_COOKIDOO_COUNTRY, MAHLWERK_COOKIDOO_LANGUAGE' });
      const key = account(c)?.key;
      if (key) out.push({ text: t('ckaKey', { where: t(`ckaKey_${key}` as K) }) });
    }
    if (c.key === 'openfoodfacts_catalog') out.push({ text: t('admTechCatalog'), cmd: 'python -m mahlwerk.catalog import-off --country en:germany' });
    if (c.key === 'bls') out.push({ text: t('admTechBls'), cmd: 'python -m mahlwerk.catalog import-bls FILE' });
    if (c.key === 'yazio_import') out.push({ text: t('admTechYazio'), cmd: 'python -m mahlwerk.yazio' });
    if (c.key === 'demo_data') out.push({ text: t('admTechDemo'), cmd: 'MAHLWERK_DEMO_DATA=1' });
    if (c.key === 'demo_account') out.push({ text: t('admTechDemoAcct'), cmd: 'MAHLWERK_DEMO_ACCOUNT=1' });
    if (c.key === 'vision') {
      out.push({ text: t('admTechVision') });
      out.push({ cmd: 'MAHLWERK_VISION_URL=http://127.0.0.1:11434/v1' }, { cmd: 'MAHLWERK_VISION_MODEL=...' }, { cmd: 'MAHLWERK_VISION_KEY=... (optional)' });
    }
    if (c.key === 'web_recipes' && !c.enabled) out.push({ text: t('admTechBlocked'), cmd: 'MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS' });
    for (const name of fixedBy(c)) out.push({ text: t('admLockedBy', { name }) });
    return out;
  };
  const expandable = (c: Connector) => WITH_SETTINGS.includes(c.key) || tech(c).length > 0;
  // a card with an error or a missing setup opens by itself; the operator's own choice wins
  let opened = $state<Record<string, boolean>>({});
  const isOpen = (c: Connector) => opened[c.key] ?? (c.status === 'error' || c.status === 'not_configured');
  const flip = (c: Connector) => { opened = { ...opened, [c.key]: !isOpen(c) }; };
  const groupOf = (g: (typeof GROUPS)[number]) => connectors.filter((c) => g.keys.includes(c.key));
  const unknown = $derived(connectors.filter((c) => !GROUPS.some((g) => g.keys.includes(c.key))));
</script>

{#snippet card(c: Connector)}
  <ConnectorCard id={`c-${c.key}`} title={t(`cn_${c.key}`)} desc={t(`cnD_${c.key}`)} status={t(`adm_st_${c.status}`)} tone={tone(c)} unofficial={UNOFFICIAL.includes(c.key)}
    sw={hasSwitch(c) ? { checked: c.enabled, disabled: busy === c.key || switchLocked(c), onchange: () => patch(c, { enabled: !c.enabled }) } : undefined}
    lockedBy={switchLocked(c) ? (ENV_OF[`${c.key}.enabled`] ?? '') : ''} fact={fact(c)} expandable={expandable(c)} open={isOpen(c)} ontoggle={() => flip(c)}
    tech={tech(c)} techOpen={c.status === 'not_installed'}>
    {#if c.key === 'openfoodfacts_catalog'}
      <div class="sub">
        <CountryPicker items={c.config.countries ?? []} hint={locked(c, 'config.countries') ? t('admLocked') : t('admCountriesHint')}
          disabled={busy === c.key || locked(c, 'config.countries')} onchange={(next) => patch(c, { config: { countries: next } })} />
      </div>
      <div class="sub">
        <h5 class="micro quiet">{t('admRefreshTitle')}</h5>
        <div class="refresh">
          <button class="btn primary" type="button" onclick={startRefresh} disabled={busy === 'refresh' || refresh?.state === 'running'}>
            {refresh?.state === 'running' ? t('admRefreshing') : t('admRefresh')}
          </button>
          <div class="rstate" aria-live="polite">
            {#if refresh?.state === 'running'}
              <div class="bar" role="progressbar" aria-label={t('admRefreshing')}><i></i></div>
              <p class="note">{t('admRefreshRunning', { time: clock(refresh.started_at ?? 0) })}{refresh.progress ? ` · ${refresh.progress}` : ''}</p>
            {:else if refresh?.state === 'done' && refresh.result}
              <p class="note ok">{t('admRefreshDone', { n: fmt(refresh.result.products), s: fmt(refresh.result.seconds, 1) })}</p>
            {:else if refresh?.state === 'error'}
              <p class="note warn" role="alert">{t('admRefreshFailed', { reason: refresh.error ?? '' })}</p>
            {/if}
          </div>
        </div>
        <p class="note">{t('admRefreshHint')}</p>
      </div>
    {/if}

    {#if c.key === 'cookidoo'}
      <p class="note warnbox">{t('admCookidooWarn')}</p>
      <div class="sub" role="group" aria-labelledby="ck-shared">
        <h5 id="ck-shared" class="micro quiet">{t('ckaTitleShared')}</h5>
        <p class="note">{t('ckaTextShared')}</p>
        <CookidooAccount scope="shared" id="adm-ck" hideKey onchange={reloadConnectors} />
      </div>
      <div class="sub">
        <h5 class="micro quiet">{t('admCookidooPersonal')}</h5>
        <Toggle checked={c.config.personal !== false} label={t('admCookidooPersonal')} sub={c.config.personal !== false ? t('admOn') : t('admOff')}
          disabled={busy === c.key || locked(c, 'config.personal')} onchange={() => patch(c, { config: { personal: c.config.personal === false } })} />
        <p class="note">{locked(c, 'config.personal') ? t('admLocked') : t('admCookidooPersonalHint')}</p>
      </div>
      <div class="sub">
        <h5 class="micro quiet">{t('admImagesTitle')}</h5>
        <Toggle checked={c.config.images === true} label={t('admImages')} sub={c.config.images === true ? t('admOn') : t('admOff')}
          disabled={busy === c.key || locked(c, 'config.images')} onchange={() => patch(c, { config: { images: c.config.images !== true } })} />
        <p class="note">{locked(c, 'config.images') ? t('admLocked') : t('admImagesCookidooHint')}</p>
      </div>
      {#if c.info.error}<p class="note warn" role="alert">{t('admCookidooError', { reason: String(c.info.error) })}</p>{/if}
    {/if}

    {#if c.key === 'web_recipes'}
      <p class="note">{t('admWebNote')}</p>
      <div class="sub">
        <h5 class="micro quiet">{t('admImagesTitle')}</h5>
        <Toggle checked={c.config.images === true} label={t('admImages')} sub={c.config.images === true ? t('admOn') : t('admOff')}
          disabled={busy === c.key || locked(c, 'config.images')} onchange={() => patch(c, { config: { images: c.config.images !== true } })} />
        <p class="note">{locked(c, 'config.images') ? t('admLocked') : t('admImagesWebHint')}</p>
      </div>
    {/if}

    {#if c.key === 'yazio_import'}
      <p class="note">{t('admYazioBatchNote')}</p>
    {/if}

    {#if c.key === 'demo_account'}
      <p class="note">{t('admDemoNote')}</p>
      {#if c.info.name_taken}<p class="note warnbox" role="alert">{t('admDemoNameTaken')}</p>{/if}
      {#if c.info.exists}
        <div class="sub" role="group" aria-label={t('admDemoActions')}>
          <div class="acts">
            <button class="btn" type="button" disabled={busy === c.key || !c.enabled} onclick={() => demoAction('reset')}>{t('admDemoReset')}</button>
            <button class="btn danger" type="button" disabled={busy === c.key} onclick={() => demoAction('delete')}>{demoConfirm ? t('admDemoDeleteConfirm') : t('admDemoDelete')}</button>
            {#if demoConfirm}<button class="btn quiet-btn" type="button" onclick={() => (demoConfirm = false)}>{t('cancel')}</button>{/if}
          </div>
          <p class="note">{t('admDemoResetHint')}</p>
        </div>
      {/if}
    {/if}

    {#if c.key === 'yazio_login'}
      <p class="note warnbox">{t('admYazioWarn')}</p>
      {#if c.status === 'not_configured'}
        <div class="setup" role="note" aria-labelledby="yz-setup">
          <h5 id="yz-setup" class="micro">{t('admYazioSetup')}</h5>
          <p class="note">{t('admYazioKeys')}</p>
          <span class="envs">
            {#each ['MAHLWERK_YAZIO_CLIENT_ID', 'MAHLWERK_YAZIO_CLIENT_SECRET'] as name (name)}<code>{name}</code>{/each}
          </span>
        </div>
      {/if}
    {/if}

    {#if c.key === 'vision'}
      <p class="note warnbox">{t('admVisionWarn')}</p>
      {#if c.status === 'not_configured'}
        <div class="setup" role="note" aria-labelledby="vs-setup">
          <h5 id="vs-setup" class="micro">{t('admYazioSetup')}</h5>
          <p class="note">{t('admVisionKeys')}</p>
          <span class="envs">
            {#each ['MAHLWERK_VISION_URL', 'MAHLWERK_VISION_MODEL', 'MAHLWERK_VISION_KEY'] as name (name)}<code>{name}</code>{/each}
          </span>
        </div>
      {/if}
      {#if c.info.per_hour}<p class="note">{t('admVisionLimit', { n: Number(c.info.per_hour) })}</p>{/if}
    {/if}

    {#if c.key === 'webhooks'}
      <TagEditor label={t('admHosts')} hint={locked(c, 'config.hosts') ? t('admLocked') : t('admHostsHint')} items={c.config.hosts ?? []}
        disabled={busy === c.key || locked(c, 'config.hosts')} placeholder="hooks.example.org" onchange={(next) => patch(c, { config: { hosts: next } })} />
    {/if}
  </ConnectorCard>
{/snippet}

<div class="page wide admin">
  <div class="page-head">
    <h1>{t('admTitle')}</h1>
    <button class="round" onclick={() => navigate('profile')} aria-label={t('back')}><Icon name="close" size={22} /></button>
  </div>

  {#if !loaded}
    <p class="note" role="status">{t('admLoading')}</p>
  {:else if !isAdmin}
    <div class="error-box"><p>{t('admNoAccess')}</p><button class="btn" onclick={() => navigate('profile')}>{t('back')}</button></div>
  {:else if failed}
    <div class="error-box" role="alert"><p>{failed}</p><button class="btn" onclick={load}>{t('retry')}</button></div>
  {:else if overview}
    <section class="hero on-dark" aria-labelledby="adm-over">
      <h2 id="adm-over" class="micro lab">{t('admOverview')} · Mahlwerk {overview.version}</h2>
      <dl class="big">
        <div><dt>{t('admStatUsers')}</dt><dd class="display">{fmt(overview.users)}</dd></div>
        <div><dt>{t('admStatEntries')}</dt><dd class="display">{fmt(overview.entries)}</dd></div>
        <div><dt>{t('admStatFoods')}</dt><dd class="display">{fmt(overview.foods)}</dd></div>
      </dl>
    </section>
    <dl class="tiles">
      <div class="tile"><dt>{t('admAuth')}</dt><dd class="mono">{overview.auth_mode === 'proxy' ? t('admAuthProxy') : overview.auth_mode === 'local' ? t('admAuthLocal') : overview.auth_mode === 'oidc' ? t('admAuthOidc') : t('admAuthSingle')}</dd></div>
      <div class="tile"><dt>{t('admDb')}</dt><dd class="mono">{size(overview.db_size_bytes)} · {t('admSchema', { n: overview.schema_version })}</dd></div>
      <div class="tile"><dt>{t('admCatOff')}</dt><dd class="mono">{overview.catalog.products ? fmt(overview.catalog.products) : '–'}<small>{stand(overview.catalog.updated_at)}</small></dd></div>
      <div class="tile"><dt>{t('admCatBls')}</dt><dd class="mono">{overview.catalog.bls.products ? fmt(overview.catalog.bls.products) : '–'}<small>{stand(overview.catalog.bls.updated_at)}</small></dd></div>
    </dl>

    <section class="icard" aria-labelledby="adm-users">
      <h2 id="adm-users" class="micro quiet">{t('admUsers')}</h2>
      {#if users.length === 0}
        <p class="note">{t('admUsersNone')}</p>
      {:else}
        <div class="tablewrap">
          <table>
            <caption class="sr-only">{t('admUsers')}</caption>
            <thead>
              <tr><th scope="col">{t('admColUser')}</th><th scope="col" class="num">{t('admColEntries')}</th><th scope="col">{t('admColRange')}</th><th scope="col" class="num">{t('admColKeys')}</th><th scope="col" class="num">{t('admColHooks')}</th></tr>
            </thead>
            <tbody>
              {#each users as u (u.username)}
                <tr>
                  <th scope="row"><strong>{u.display_name}</strong>{#if u.demo}<small class="demotag">{t('admDemoTag')}</small>{:else if u.display_name !== u.username}<small class="mono">{u.username}</small>{/if}</th>
                  <td class="num" data-label={t('admColEntries')}>{fmt(u.entries)}</td>
                  <td data-label={t('admColRange')} class="mono">{day(u.first_day)} – {day(u.last_day)}</td>
                  <td class="num" data-label={t('admColKeys')}>{fmt(u.tokens)}</td>
                  <td class="num" data-label={t('admColHooks')}>{fmt(u.webhooks)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <p class="note">{t('admUsersNote')}</p>
    </section>

    {#if (overview.auth_mode === 'local' || overview.auth_mode === 'oidc') && auth.mode === overview.auth_mode}
      <UserManager users={users.filter((u) => !u.demo)} onchange={reloadUsers} />
    {/if}

    <h2 class="sect micro quiet">{t('admConnectors')}</h2>
    {#if error}<p class="note warn" role="alert">{error}</p>{/if}
    {#each [...GROUPS, ...(unknown.length ? [{ id: 'other', title: () => t('admGroupOther'), keys: unknown.map((c) => c.key) }] : [])] as group (group.id)}
      <section class="group" aria-labelledby={`g-${group.id}`}>
        <h3 id={`g-${group.id}`} class="gt">{group.title()}</h3>
        <div class="cards">
          {#each groupOf(group) as c (c.key)}
            {@render card(c)}
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>

<style>
  .admin { gap: 14px; }
  .lab { color: var(--lime); }
  .hero { background: var(--green); color: #fff; border-radius: 44px 44px 44px 14px; padding: 22px 22px 20px; display: flex; flex-direction: column; gap: 14px; --focus: var(--lime); }
  /* big figures wrap instead of colliding: on a phone two fit per row */
  .big { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 14px 10px; margin: 0; }
  .big dt { font-family: var(--f-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--on-deep); opacity: 0.9; }
  .big dd { margin: 2px 0 0; font-size: clamp(28px, 8vw, 44px); line-height: 1; white-space: nowrap; }
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 0; }
  .tile { background: var(--paper); border-radius: 24px 24px 24px 8px; padding: 14px 14px 14px 16px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .tile dt { font-family: var(--f-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--quiet); }
  .tile dd { margin: 0; font-size: 14px; font-weight: 600; display: flex; flex-direction: column; gap: 2px; word-break: break-word; }
  .tile small { font-size: 11.5px; font-weight: 500; color: var(--quiet); }
  .sect { margin-top: 6px; }
  .group { display: flex; flex-direction: column; gap: 8px; }
  .gt { font-family: var(--f-display); font-weight: 800; font-size: 20px; letter-spacing: -0.02em; margin-top: 4px; }
  .cards { display: grid; grid-template-columns: 1fr; gap: 8px; }
  .sub { display: flex; flex-direction: column; gap: 8px; }
  .sub + .sub, .warnbox + .sub { border-top: 1px solid var(--hairline); padding-top: 12px; }
  .sub .note { margin: 0; }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; }
  .acts .btn { min-height: 44px; }
  .demotag { align-self: flex-start; margin-top: 3px; padding: 2px 8px; border-radius: 10px; box-shadow: inset 0 0 0 1.5px var(--hairline); font-size: 11.5px; font-weight: 600; color: var(--text); }
  .sub h5 { margin: 0; }
  .setup { background: var(--stone); border-radius: 18px 18px 18px 6px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; border-left: 4px solid var(--lime); }
  .setup h5 { color: var(--green-text); margin: 0; }
  .setup .note { color: var(--text); margin: 0; }
  .envs { display: flex; flex-wrap: wrap; gap: 6px; }
  .warnbox { background: var(--stone); border-radius: 16px 16px 16px 6px; padding: 10px 14px; color: var(--text); border-left: 4px solid var(--warn); }
  .note.ok { color: var(--green-text); font-weight: 600; }
  .refresh { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .refresh .btn { min-height: 44px; }
  .rstate { width: 100%; display: flex; flex-direction: column; gap: 6px; }
  .bar { height: 10px; border-radius: 5px; background: var(--track); overflow: hidden; position: relative; }
  .bar i { position: absolute; inset: 0 auto 0 0; width: 35%; border-radius: 5px; background: var(--bar); animation: slide 1.4s ease-in-out infinite; }
  @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
  @media (prefers-reduced-motion: reduce) { .bar i { animation: none; width: 100%; opacity: 0.6; } }

  /* the users table: a real table; on the phone each row becomes a small card */
  .tablewrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  tbody tr { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; background: var(--stone); border-radius: 20px 20px 20px 8px; padding: 12px 14px 12px 16px; margin-bottom: 8px; }
  tbody th { grid-column: 1 / -1; text-align: left; font-weight: 600; display: flex; flex-direction: column; }
  tbody th small { font-size: 12px; color: var(--quiet); font-weight: 500; }
  td { display: flex; flex-direction: column; font-weight: 600; }
  td::before { content: attr(data-label); font-family: var(--f-mono); font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--quiet); font-weight: 500; }

  @media (min-width: 900px) {
    .admin { max-width: 1120px; }
    .hero { padding: 28px 30px 26px; }
    .big dd { font-size: 64px; }
    .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    thead { position: static; width: auto; height: auto; overflow: visible; clip: auto; }
    tbody tr { display: table-row; background: none; padding: 0; margin: 0; }
    tbody th, td { display: table-cell; padding: 12px 10px; border-top: 1px solid var(--hairline); vertical-align: middle; }
    td { font-weight: 500; }
    td::before { content: none; }
    th { font-family: var(--f-mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--quiet); font-weight: 500; text-align: left; padding: 8px 10px; }
    tbody th { text-transform: none; letter-spacing: 0; font-family: var(--f-body); font-size: 14px; color: var(--text); }
    tbody th small { display: block; }
    .num { text-align: right; }
  }
</style>
