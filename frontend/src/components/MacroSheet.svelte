<script lang="ts">
  import { shortDate } from '../lib/date';
  import { fmt, t } from '../lib/i18n';
  import { breakdown, MACRO_KEYS, type MacroKey } from '../lib/macroBreakdown';
  import { MEALS, type Day, type Entry, type Meal } from '../lib/types';
  import Sheet from './Sheet.svelte';

  // Where the protein, carbs or fat of the shown day came from: per meal and the foods that gave the most. Opened by a
  // tap on a macro tile of the day view; the tabs switch between the three without closing.
  let { day, start, onclose }: { day: Day; start: MacroKey; onclose: () => void } = $props();

  // svelte-ignore state_referenced_locally
  let key = $state<MacroKey>(start);
  const LABEL = { protein: 'protein', carbs: 'carbs', fat: 'fat' } as const;
  // the darker tile colours: readable as bars on paper, the value next to them carries the number
  const BAR = { protein: '#b85e0c', carbs: '#6f8f12', fat: '#c0508a' } as const;

  const entries = $derived(Object.fromEntries(MEALS.map((m) => [m, day.meals[m].entries])) as Record<Meal, Entry[]>);
  const b = $derived(breakdown(MEALS, entries, key));
  const goal = $derived(day.goal?.[key] ?? null);
  const name = $derived(t(LABEL[key]));
  const pct = (share: number) => `${Math.round(share * 100)} %`;

  function tabKey(event: KeyboardEvent, i: number) {
    const n = MACRO_KEYS.length;
    const to = event.key === 'ArrowRight' ? (i + 1) % n : event.key === 'ArrowLeft' ? (i + n - 1) % n
      : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    key = MACRO_KEYS[to];
    document.getElementById(`mb-tab-${key}`)?.focus();
  }
</script>

<Sheet title={t('mbTitle', { macro: name, date: shortDate(day.day) })} {onclose}>
  <div class="tabs" role="tablist" aria-label={t('mbTabs')}>
    {#each MACRO_KEYS as k, i}
      <button role="tab" id="mb-tab-{k}" class="chip" class:on={key === k} aria-selected={key === k} aria-controls="mb-panel"
        tabindex={key === k ? 0 : -1} onclick={() => (key = k)} onkeydown={(e) => tabKey(e, i)}>{t(LABEL[k])}</button>
    {/each}
  </div>

  <div role="tabpanel" id="mb-panel" aria-labelledby="mb-tab-{key}" class="panel">
    <p class="sum">
      <b class="display">{fmt(b.total)} g</b>
      {#if goal}
        <span class="mono">{t('mbOf', { goal: fmt(goal) })}</span>
        <span class="state">{b.total <= goal ? t('mbLeft', { n: fmt(goal - b.total) }) : t('mbOver', { n: fmt(b.total - goal) })}</span>
      {/if}
    </p>

    {#if b.total <= 0}
      <p class="note">{t('mbEmpty', { macro: name })}</p>
    {:else}
      <h3 class="micro">{t('mbMeals')}</h3>
      <ul class="meals">
        {#each b.meals as m (m.meal)}
          <li class:none={m.grams <= 0}>
            <span class="m">{t(m.meal)}</span>
            <span class="v mono">{fmt(m.grams)} g{#if m.grams > 0}{' · '}{pct(m.share)}{/if}</span>
            <span class="track" aria-hidden="true"><span class="bar" style="width:{m.share * 100}%; background:{BAR[key]}"></span></span>
          </li>
        {/each}
      </ul>

      <h3 class="micro">{t('mbFoods')}</h3>
      <ol class="foods">
        {#each b.foods as f}
          <li>
            <span class="f"><span class="n">{f.name}</span>{#if f.brand}<span class="br">{f.brand}</span>{/if}</span>
            <span class="v mono">{fmt(f.grams)} g · {pct(f.share)}</span>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</Sheet>

<style>
  .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
  .panel { display: flex; flex-direction: column; gap: 10px; padding-bottom: 8px; }
  .sum { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
  .sum b { font-size: 30px; line-height: 1; }
  .sum .state { color: var(--quiet); font-size: 14px; }
  .micro { margin-top: 8px; }
  .meals, .foods { display: flex; flex-direction: column; gap: 10px; list-style: none; padding: 0; margin: 0; }
  .meals li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; align-items: baseline; }
  .meals li.none { color: var(--quiet); }
  .track { grid-column: 1 / -1; height: 8px; border-radius: 4px; background: var(--hairline); overflow: hidden; }
  .bar { display: block; height: 100%; border-radius: 4px; }
  .foods li { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; background: var(--paper); border-radius: 16px; padding: 10px 14px; }
  .f { display: flex; flex-direction: column; min-width: 0; }
  .n { overflow-wrap: anywhere; font-weight: 600; }
  .br { font-size: 13px; color: var(--quiet); }
  .v { white-space: nowrap; font-size: 14px; }
  .note { color: var(--quiet); }
</style>
