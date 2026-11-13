<script lang="ts">
  import { untrack } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, lang, t } from '../lib/i18n';
  import { amountLabel } from '../lib/portion';
  import { mealByTime, openAmount, toast, ui } from '../lib/store.svelte';
  import type { FoodDetail as Detail, FoodList, FoodSort } from '../lib/types';
  import FoodDetail from './FoodDetail.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';
  import TickBar from './TickBar.svelte';

  // The foods eaten in the period: search, sort, page; a click opens the history of one food (side panel on wide
  // screens, sheet on the phone).
  let { from, to }: { from: string; to: string } = $props();

  const PAGE = 15;
  const SORTS: { key: FoodSort; label: () => string }[] = [
    { key: 'kcal', label: () => t('sortKcal') }, { key: 'times', label: () => t('sortTimes') }, { key: 'amount', label: () => t('sortAmount') },
    { key: 'last', label: () => t('sortLast') }, { key: 'name', label: () => t('sortName') },
  ];
  let q = $state('');
  let query = $state(''); // debounced
  let sort = $state<FoodSort>('kcal');
  let offset = $state(0);
  let list = $state<FoodList | null>(null);
  let error = $state('');
  let loading = $state(false);
  let token = 0;
  let timer = 0;

  function typed(value: string) {
    q = value;
    clearTimeout(timer);
    timer = window.setTimeout(() => { query = q.trim(); offset = 0; }, 250);
  }

  async function load(f: string, tt: string, text: string, order: FoodSort, off: number) {
    const mine = ++token;
    loading = true;
    try {
      const r = await api.insightsFoods({ from: f, to: tt, q: text, sort: order, limit: PAGE, offset: off });
      if (mine !== token) return;
      list = r;
      error = '';
    } catch (err) {
      if (mine !== token) return;
      error = err instanceof ApiError ? String(err.status || err.message) : 'error';
    } finally {
      if (mine === token) loading = false;
    }
  }
  $effect(() => {
    const args = [from, to, query, sort, offset] as const;
    ui.version;
    untrack(() => { void load(...args); });
  });
  // a new period starts at the first page and forgets the open food
  // svelte-ignore state_referenced_locally
  let seen = `${from}|${to}`;
  $effect(() => {
    const now = `${from}|${to}`;
    if (now !== seen) { seen = now; offset = 0; untrack(() => { selected = null; detail = null; }); }
  });

  let selected = $state<string | null>(null);
  let detail = $state<Detail | null>(null);
  let detailError = $state('');
  let dtoken = 0;
  async function open(key: string) {
    selected = key;
    const mine = ++dtoken;
    detail = null; detailError = '';
    try {
      const d = await api.insightsFoodDetail(key, from, to);
      if (mine === dtoken) detail = d;
    } catch (err) {
      if (mine === dtoken) detailError = err instanceof ApiError ? String(err.status || err.message) : 'error';
    }
  }
  const close = () => { selected = null; detail = null; dtoken += 1; };

  async function add() {
    if (!detail?.food_id) return;
    try {
      const food = await api.food(detail.food_id);
      const recent = await api.recent(50).catch(() => []);
      openAmount({ food, meal: mealByTime(), day: ui.today, lastAmount: recent.find((r) => r.food.id === food.id)?.last_amount });
    } catch {
      toast(t('foodGone'));
    }
  }

  const wideQuery = window.matchMedia('(min-width: 900px)');
  let wide = $state(wideQuery.matches);
  $effect(() => {
    const on = () => (wide = wideQuery.matches);
    wideQuery.addEventListener('change', on);
    return () => wideQuery.removeEventListener('change', on);
  });

  const total = $derived(list?.total ?? 0);
  const items = $derived(list?.items ?? []);
  const maxShare = $derived(Math.max(...items.map((i) => i.share), 0.0001));
  const rangeText = $derived(total ? t('foodsCount', { from: offset + 1, to: Math.min(offset + PAGE, total), total: fmt(total) }) : '');
  const lastText = (day: string) => new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'numeric', year: '2-digit' }).format(new Date(`${day}T12:00:00`));
</script>

<div class="foods" class:split={wide && selected}>
  <div class="main">
    <div class="tools">
      <label class="search">
        <Icon name="search" size={20} />
        <span class="sr-only">{t('foodsSearch')}</span>
        <input type="search" value={q} placeholder={t('foodsSearch')} oninput={(e) => typed(e.currentTarget.value)} autocomplete="off" />
      </label>
      <div class="sorts" role="group" aria-label={t('foodsSort')}>
        {#each SORTS as s (s.key)}
          <button class="chip" class:on={sort === s.key} aria-pressed={sort === s.key} onclick={() => { sort = s.key; offset = 0; }}>{s.label()}</button>
        {/each}
      </div>
    </div>

    {#if error && !list}
      <div class="error-box"><p>{t('loadFailed', { reason: error })}</p><button class="btn primary" onclick={() => load(from, to, query, sort, offset)}>{t('retry')}</button></div>
    {:else if !list}
      <div class="skel" aria-hidden="true"></div>
    {:else if !items.length}
      <p class="note">{query ? t('foodsNone') : t('foodsEmpty')}</p>
    {:else}
      {#if !selected}<p class="note">{t('foodsPick')}</p>{/if}
      <div class="head mono micro quiet" aria-hidden="true">
        <span>{t('foodsColFood')}</span><span class="r">{t('foodsColTimes')}</span><span class="r">{t('foodsColAmount')}</span>
        <span class="r">{t('foodsColKcal')}</span><span>{t('foodsColShare')}</span><span class="r">{t('foodsColLast')}</span>
      </div>
      <ul class="rows2" class:stale={loading}>
        {#each items as f (f.key)}
          <li>
            <button class="frow" class:on={selected === f.key} aria-pressed={selected === f.key} onclick={() => open(f.key)}
              aria-label="{t('foodOpenAria', { name: f.name })}. {t('foodRowAria', { name: f.name, times: f.times, kcal: fmt(Math.round(f.kcal_total)), share: fmt(Math.round(f.share * 100)) })}">
              <span class="nm"><strong>{f.name}</strong>{#if f.brand}<small>{f.brand}</small>{/if}</span>
              <span class="mono times">{t('foodTimes', { n: f.times })}</span>
              <span class="mono amount">{amountLabel(f, f.amount_total)}</span>
              <span class="mono kcal">{fmt(Math.round(f.kcal_total))} kcal</span>
              <span class="share"><TickBar value={f.share} goal={maxShare} track="var(--track)" fill="var(--bar)" label="" height={8} /><small class="mono">{fmt(f.share * 100, f.share < 0.1 ? 1 : 0)} %</small></span>
              <span class="mono last">{lastText(f.last_day)}</span>
            </button>
          </li>
        {/each}
      </ul>
      <div class="pager">
        <span class="mono note">{rangeText}</span>
        <div class="btns">
          <button class="round" onclick={() => (offset = Math.max(0, offset - PAGE))} disabled={offset === 0} aria-label={t('foodsPrev')}><Icon name="left" size={22} /></button>
          <button class="round" onclick={() => (offset += PAGE)} disabled={offset + PAGE >= total} aria-label={t('foodsNext')}><Icon name="right" size={22} /></button>
        </div>
      </div>
    {/if}
  </div>

  {#if wide}
    <aside class="panel" aria-live="polite">
      {#if selected && detail}
        <button class="round x" onclick={close} aria-label={t('close')}><Icon name="close" size={20} /></button>
        <FoodDetail {detail} onadd={detail.food_id ? add : null} />
      {:else if selected && detailError}
        <p class="note warn" role="alert">{t('foodDetailFailed', { reason: detailError })}</p>
      {:else if selected}
        <div class="skel" aria-hidden="true"></div>
      {/if}
    </aside>
  {:else if selected}
    <Sheet title={detail?.name ?? '…'} onclose={close} tall>
      {#if detail}<FoodDetail {detail} bare onadd={detail.food_id ? add : null} />
      {:else if detailError}<p class="note warn" role="alert">{t('foodDetailFailed', { reason: detailError })}</p>
      {:else}<div class="skel" aria-hidden="true"></div>{/if}
    </Sheet>
  {/if}
</div>

<style>
  .foods { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
  .main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .tools { display: flex; flex-direction: column; gap: 10px; }
  .search { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 0 16px; border-radius: 16px; background: var(--stone); border: 2px solid var(--field-line); }
  .search:focus-within { border-color: var(--focus-base); }
  .search input { flex: 1; min-width: 0; background: transparent; border: 0; font-size: 16px; font-family: var(--f-body); color: var(--text); outline: none; min-height: 44px; }
  .sorts { display: flex; flex-wrap: wrap; gap: 6px; }
  .sorts .chip { min-height: 40px; padding: 0 14px; font-size: 13px; }
  .skel { height: 220px; border-radius: 20px; background: var(--hairline); opacity: 0.5; }
  .head { display: none; }
  .rows2 { display: flex; flex-direction: column; gap: 4px; transition: opacity 160ms; }
  .rows2.stale { opacity: 0.55; }
  .frow {
    width: 100%; text-align: left; border-radius: 18px 18px 18px 6px; padding: 10px 14px; background: var(--stone); min-height: 56px;
    display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'nm kcal' 'times share'; gap: 3px 12px; align-items: center; border: 2px solid transparent;
  }
  .frow.on { border-color: var(--focus-base); }
  .nm { grid-area: nm; display: flex; flex-direction: column; min-width: 0; }
  .nm strong { font-size: 14.5px; font-weight: 600; line-height: 1.2; overflow-wrap: anywhere; }
  .nm small { font-size: 12px; color: var(--quiet); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kcal { grid-area: kcal; font-size: 14px; font-weight: 600; text-align: right; }
  .times { grid-area: times; font-size: 12px; color: var(--quiet); }
  .amount, .last { display: none; }
  .share { grid-area: share; display: flex; align-items: center; gap: 8px; justify-self: end; width: 150px; }
  .share :global(svg) { flex: 1; min-width: 0; }
  .share small { font-size: 11px; color: var(--quiet); min-width: 34px; text-align: right; }
  .pager { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .btns { display: flex; gap: 6px; }
  .round[disabled] { opacity: 0.4; cursor: default; }
  .panel { display: none; }

  @media (min-width: 900px) {
    .foods.split { grid-template-columns: minmax(0, 1fr) 400px; }
    .tools { flex-direction: row; align-items: center; justify-content: space-between; gap: 16px; }
    .search { width: 320px; flex-shrink: 0; }
    .sorts { justify-content: flex-end; }
    .head, .frow { display: grid; grid-template-columns: minmax(0, 1fr) 54px 92px 100px 150px 78px; gap: 12px; align-items: center; }
    .head { padding: 0 14px; }
    .head .r { text-align: right; }
    .frow { grid-template-areas: none; padding: 8px 14px; min-height: 52px; }
    .frow > * { grid-area: auto; }
    .times, .amount, .kcal, .last { display: block; text-align: right; font-size: 13px; color: var(--text); }
    .times { color: var(--text); }
    .kcal { font-weight: 600; }
    .last { color: var(--quiet); }
    .share { width: auto; justify-self: stretch; }
    .foods.split .search { width: 230px; }
    .foods.split .head, .foods.split .frow { grid-template-columns: minmax(0, 1fr) 54px 96px 110px; }
    .foods.split .head > :nth-child(5), .foods.split .frow .share { display: none; }
    .foods.split .head > :nth-child(6), .foods.split .frow .last { display: none; }
    .panel { display: block; position: sticky; top: calc(16px + var(--band, 0px)); align-self: start; background: var(--stone); border-radius: 24px 24px 24px 8px; padding: 20px 20px 22px; min-height: 160px; max-height: calc(100dvh - 32px - var(--band, 0px)); overflow-y: auto; }
    .foods:not(.split) .panel { display: none; }
    .x { position: absolute; top: 10px; right: 10px; width: 36px; height: 36px; }
  }
</style>
