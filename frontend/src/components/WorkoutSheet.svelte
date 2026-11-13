<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, inputNumber, parseNumber, t } from '../lib/i18n';
  import { changed, toast, ui, type WorkoutRequest } from '../lib/store.svelte';
  import { DEFAULT_WEIGHT_KG, KINDS, clock, estimateKcal, startAt } from '../lib/workouts';
  import { type WorkoutKind } from '../lib/types';

  let { req }: { req: WorkoutRequest } = $props();

  // the sheet is re-created for every request ({#key} in App), so reading `req` once is intended
  // svelte-ignore state_referenced_locally
  const w = req.workout;
  // svelte-ignore state_referenced_locally
  const day = req.day;

  let kind = $state<WorkoutKind>(w?.kind ?? 'walking');
  let name = $state(w?.name ?? '');
  let minutesText = $state(w ? inputNumber(w.minutes) : '30');
  let kcalText = $state(w && !w.kcal_estimated ? inputNumber(w.kcal) : '');
  let kmText = $state(w?.distance_m != null ? inputNumber(w.distance_m / 1000) : '');
  let timeText = $state(w?.started_at ? clock(w.started_at) : '');
  let note = $state(w?.note ?? '');
  let saving = $state(false);
  let error = $state('');
  let confirming = $state(false);
  let tried = $state(false);
  let weightKg = $state<number | null>(null);

  // the body weight the server estimates with: the latest value up to the day, else the latest of all
  onMount(async () => {
    try {
      const all = await api.weights(3660);
      const upTo = all.filter((p) => p.day <= day);
      weightKg = (upTo.length ? upTo[upTo.length - 1] : all[all.length - 1])?.kg ?? null;
    } catch { /* the estimate then uses the default weight */ }
  });

  const minutes = $derived(parseNumber(minutesText));
  const minutesOk = $derived(minutes != null && !Number.isNaN(minutes) && minutes > 0 && minutes <= 1440);
  const kcal = $derived(parseNumber(kcalText));
  const kcalOk = $derived(kcal === null || (!Number.isNaN(kcal) && kcal >= 0 && kcal <= 20000));
  const km = $derived(parseNumber(kmText));
  const kmOk = $derived(km === null || (!Number.isNaN(km) && km >= 0 && km <= 500));
  const started = $derived(timeText.trim() === '' ? null : startAt(day, timeText));
  const timeOk = $derived(timeText.trim() === '' || started != null);
  const estimate = $derived(minutesOk ? estimateKcal(kind, minutes as number, weightKg) : null);
  const showName = $derived(kind === 'other' || name !== '');

  const close = () => { ui.workout = null; };
  const failMsg = (err: unknown) => t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });

  async function save() {
    tried = true;
    if (!minutesOk || !kcalOk || !kmOk || !timeOk) { error = !minutesOk ? t('wkBadMinutes') : !timeOk ? t('wkBadTime') : t('wkBadNumber'); return; }
    saving = true;
    error = '';
    const body = {
      kind, name: showName && name.trim() ? name.trim() : null, minutes: minutes as number,
      kcal: kcal == null ? null : Math.round(kcal), distance_m: km == null ? null : Math.round(km * 1000),
      started_at: started, note: note.trim() || null,
    };
    try {
      if (w) await api.patchWorkout(w.id, body);
      else await api.addWorkout({ day, ...body });
      toast(t('wkSaved'));
      ui.workout = null;
      changed();
    } catch (err) {
      error = failMsg(err);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!w) return;
    if (!confirming) { confirming = true; return; }
    saving = true;
    try {
      await api.deleteWorkout(w.id);
      toast(t('wkRemoved'));
      ui.workout = null;
      changed();
    } catch (err) {
      error = failMsg(err);
      confirming = false;
    } finally {
      saving = false;
    }
  }
</script>

<Sheet title={w ? t('wkTitleEdit') : t('wkTitleNew')} onclose={close} tall>
  <div class="kinds" role="group" aria-label={t('wkKind')}>
    {#each KINDS as k (k.key)}
      <button type="button" class="kind" class:on={kind === k.key} aria-pressed={kind === k.key} onclick={() => (kind = k.key)}>
        <Icon name={k.icon} size={22} /><span>{t(`wk_${k.key}`)}</span>
      </button>
    {/each}
  </div>

  {#if showName}
    <label class="field"><span>{t('wkName')}</span>
      <input bind:value={name} maxlength="100" autocomplete="off" placeholder={t('wkNamePh')} />
    </label>
  {/if}

  <div class="two">
    <label class="field"><span>{t('wkMinutes')}</span>
      <input inputmode="decimal" autocomplete="off" bind:value={minutesText} aria-invalid={tried && !minutesOk ? 'true' : undefined}
        onfocus={(e) => e.currentTarget.select()} onkeydown={(e) => e.key === 'Enter' && save()} />
    </label>
    <label class="field"><span>{t('wkKcal')}</span>
      <input inputmode="decimal" autocomplete="off" bind:value={kcalText} placeholder={estimate == null ? t('wkKcalPh') : `≈ ${fmt(estimate)}`}
        aria-invalid={tried && !kcalOk ? 'true' : undefined} onkeydown={(e) => e.key === 'Enter' && save()} />
    </label>
  </div>

  <div class="result" aria-live="polite">
    {#if kcal != null && kcalOk}
      <span class="big display">{fmt(Math.round(kcal))}<span class="mono unit"> kcal</span></span>
    {:else}
      <span class="big display">{estimate == null ? '–' : `≈ ${fmt(estimate)}`}<span class="mono unit"> kcal</span></span>
      <span class="basis mono">{weightKg == null ? t('wkEstimateBasisNoWeight', { kg: DEFAULT_WEIGHT_KG }) : t('wkEstimateBasis', { kg: fmt(weightKg, 1) })}</span>
    {/if}
  </div>

  <div class="two">
    <label class="field"><span>{t('wkDistance')}</span>
      <input inputmode="decimal" autocomplete="off" bind:value={kmText} aria-invalid={tried && !kmOk ? 'true' : undefined} />
    </label>
    <label class="field"><span>{t('wkTime')}</span>
      <input type="time" bind:value={timeText} aria-invalid={tried && !timeOk ? 'true' : undefined} />
    </label>
  </div>
  <label class="field"><span>{t('wkNote')}</span>
    <input bind:value={note} maxlength="500" autocomplete="off" />
  </label>

  {#if error}<p class="note warn" role="alert">{error}</p>{/if}
  <button class="btn primary" onclick={save} disabled={saving}>{t('save')}</button>
  {#if w}
    <button class="btn danger" onclick={remove} disabled={saving}>{confirming ? t('wkDeleteConfirm') : t('delete')}</button>
  {/if}
</Sheet>

<style>
  .kinds { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
  .kind {
    min-height: 64px; padding: 8px 6px; border-radius: 20px 20px 20px 8px; background: var(--stone); border: 2px solid transparent;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; font-size: 12.5px; font-weight: 600; text-align: center; line-height: 1.15;
  }
  .kind.on { background: var(--sel-bg); color: var(--sel-fg); }
  .two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
  .two .field { min-width: 0; }
  .two input { width: 100%; min-width: 0; box-sizing: border-box; }
  /* iOS Safari gives a time field its own minimum width and ignores the grid; without the native look it follows the column */
  .two input[type='time'] { -webkit-appearance: none; appearance: none; }
  .two input[type='time']::-webkit-date-and-time-value { text-align: left; }
  .result { background: var(--deep); color: var(--on-deep); border-radius: 28px 28px 28px 8px; padding: 14px 20px 16px; display: flex; flex-direction: column; gap: 4px; }
  .big { font-size: 40px; line-height: 1; }
  .unit { margin-left: 6px; font-size: 14px; font-weight: 500; letter-spacing: 0; }
  .basis { font-size: 12px; color: #cfd6cc; line-height: 1.4; }
</style>
