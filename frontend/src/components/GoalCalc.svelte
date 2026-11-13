<script lang="ts">
  import { onMount } from 'svelte';
  import Sheet from './Sheet.svelte';
  import { api } from '../lib/api';
  import { ACTIVITY, CALC_LIMITS, calcValid, suggest, type Intent, type Sex } from '../lib/goals';
  import { fmt, inputNumber, parseNumber, t } from '../lib/i18n';

  let { onclose, onuse }: { onclose: () => void; onuse: (kcal: number) => void } = $props();

  const KEY = 'mahlwerk.calc';
  interface Saved { sex: Sex; age: string; height: string; weight: string; activity: number; intent: Intent }
  function load(): Saved {
    const base: Saved = { sex: 'x', age: '', height: '', weight: '', activity: 1, intent: 'keep' };
    try { return { ...base, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return base; }
  }
  const start = load();
  let sex = $state<Sex>(start.sex);
  let age = $state(start.age);
  let height = $state(start.height);
  let weight = $state(start.weight);
  let activity = $state(start.activity);
  let intent = $state<Intent>(start.intent);
  let fromLog = $state(false);

  onMount(async () => {
    try {
      const points = await api.weights(365);
      const last = [...points].sort((a, b) => (a.day < b.day ? -1 : 1)).pop();
      if (last) { weight = inputNumber(last.kg); fromLog = true; }
    } catch { /* keep what was typed before */ }
  });

  $effect(() => {
    const data: Saved = { sex, age, height, weight, activity, intent };
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* private mode: nothing to remember */ }
  });

  const num = (s: string) => { const v = parseNumber(s); return v == null ? NaN : v; };
  const input = $derived({ sex, age: num(age), height: num(height), weight: num(weight), activity, intent });
  const ok = $derived(calcValid(input));
  const result = $derived(ok ? suggest(input) : null);

  const sexes: [Sex, string][] = [['f', 'gpSexF'], ['m', 'gpSexM'], ['x', 'gpSexX']];
  const intents: [Intent, string][] = [['keep', 'gpIntentKeep'], ['lose', 'gpIntentLose'], ['gain', 'gpIntentGain']];
</script>

<Sheet title={t('gpCalcTitle')} {onclose}>
  <div class="calc">
    <div class="grp" role="radiogroup" aria-labelledby="c-sex">
      <span id="c-sex" class="lab">{t('gpSex')}</span>
      <div class="chips">
        {#each sexes as [v, key]}
          <button type="button" class="chip" class:on={sex === v} role="radio" aria-checked={sex === v} onclick={() => (sex = v)}>{t(key as 'gpSexF')}</button>
        {/each}
      </div>
      <p class="note">{t('gpSexNote')}</p>
    </div>
    <div class="three">
      <label class="field"><span>{t('gpAge')}</span><input inputmode="numeric" autocomplete="off" bind:value={age} aria-invalid={age !== '' && !(num(age) >= CALC_LIMITS.age[0] && num(age) <= CALC_LIMITS.age[1])} /></label>
      <label class="field"><span>{t('gpHeight')}</span><input inputmode="numeric" autocomplete="off" bind:value={height} aria-invalid={height !== '' && !(num(height) >= CALC_LIMITS.height[0] && num(height) <= CALC_LIMITS.height[1])} /></label>
      <label class="field"><span>{t('gpWeight')}</span><input inputmode="decimal" autocomplete="off" bind:value={weight} oninput={() => (fromLog = false)} aria-invalid={weight !== '' && !(num(weight) >= CALC_LIMITS.weight[0] && num(weight) <= CALC_LIMITS.weight[1])} /></label>
    </div>
    {#if fromLog}<p class="note">{t('gpWeightFromLog')}</p>{/if}

    <div class="grp" role="radiogroup" aria-labelledby="c-act">
      <span id="c-act" class="lab">{t('gpActivity')}</span>
      <div class="acts">
        {#each ACTIVITY as f, i}
          <button type="button" class="act" class:on={activity === i} role="radio" aria-checked={activity === i} onclick={() => (activity = i)}>
            <span class="t"><strong>{t(`gpAct${i}` as 'gpAct0')}</strong><small>{t(`gpAct${i}t` as 'gpAct0t')}</small></span>
            <span class="mono f">× {fmt(f, 3)}</span>
          </button>
        {/each}
      </div>
    </div>

    <div class="grp" role="radiogroup" aria-labelledby="c-int">
      <span id="c-int" class="lab">{t('gpIntent')}</span>
      <div class="chips">
        {#each intents as [v, key]}
          <button type="button" class="chip" class:on={intent === v} role="radio" aria-checked={intent === v} onclick={() => (intent = v)}>{t(key as 'gpIntentKeep')}</button>
        {/each}
      </div>
    </div>

    <p class="note">{t('gpCalcLocal')}</p>
    <p class="note">{t('gpCalcNote')}</p>
    <section class="result on-dark" aria-live="polite">
      {#if result}
        <div class="nums">
          <span><span class="micro">{t('gpBmr')}</span> <b class="mono">{fmt(result.bmr)}</b></span>
          <span><span class="micro">{t('gpTotal')}</span> <b class="mono">{fmt(result.total)}</b></span>
        </div>
        <div class="goalrow">
          <div class="big"><span class="micro">{t('gpSuggested')}</span><span class="display">{fmt(result.target)}<small class="mono"> kcal</small></span></div>
          <button type="button" class="btn lime" onclick={() => onuse(result.target)}>{t('gpTake')}</button>
        </div>
      {:else}
        <p class="need">{t('gpCalcNeed')}</p>
      {/if}
    </section>
  </div>
</Sheet>

<style>
  .calc { display: flex; flex-direction: column; gap: 16px; }
  .grp { display: flex; flex-direction: column; gap: 8px; }
  .lab { font-size: 13px; font-weight: 600; color: var(--quiet); }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .three .field > span { font-size: 12px; }
  .acts { display: flex; flex-direction: column; gap: 6px; }
  .act { min-height: 52px; padding: 6px 16px; border-radius: 20px 20px 20px 8px; background: var(--paper); border: 2px solid transparent; display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; }
  .act .t { display: flex; flex-direction: column; min-width: 0; }
  .act strong { font-size: 15px; font-weight: 600; }
  .act small { font-size: 12px; color: var(--quiet); }
  .act .f { font-size: 13px; font-weight: 600; flex-shrink: 0; }
  .act.on { background: var(--sel-bg); color: var(--sel-fg); }
  .act.on small { color: var(--sel-fg); opacity: 0.85; }
  .result { position: sticky; bottom: 0; z-index: 2; background: var(--green); color: #fff; border-radius: 28px 28px 28px 8px; padding: 14px 18px 14px 20px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 -6px 18px rgba(23, 33, 28, 0.18); --focus: var(--lime); }
  .nums { display: flex; flex-wrap: wrap; gap: 4px 20px; align-items: baseline; }
  .nums b { font-size: 15px; font-weight: 600; }
  .goalrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .big { display: flex; flex-direction: column; gap: 2px; }
  .micro { color: var(--lime); }
  .display { font-size: 44px; line-height: 1; }
  .display small { font-size: 14px; font-weight: 500; letter-spacing: 0; }
  .need { font-size: 14px; color: var(--on-deep); }
</style>
