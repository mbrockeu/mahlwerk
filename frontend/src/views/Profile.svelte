<script lang="ts">
  import { onMount } from 'svelte';
  import GoalCalc from '../components/GoalCalc.svelte';
  import NameCard from '../components/NameCard.svelte';
  import AccountCard from '../components/AccountCard.svelte';
  import CookidooAccount from '../components/CookidooAccount.svelte';
  import YazioImport from '../components/YazioImport.svelte';
  import TokenCard from '../components/TokenCard.svelte';
  import WebhookCard from '../components/WebhookCard.svelte';
  import Icon from '../components/Icon.svelte';
  import KcalScale from '../components/KcalScale.svelte';
  import NumField from '../components/NumField.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { api, ApiError } from '../lib/api';
  import {
    KCAL_LIMITS, MACRO_LIMITS, PRESETS, STEPS_LIMITS, WATER_LIMITS, alignCarbs, clamp, macroGap, macroShares, matchingPreset, presetMacros,
    type MacroKey, type PresetId,
  } from '../lib/goals';
  import type { ImportBatch } from '../lib/types';
  import { fmt, fmtDate, langPref, setLangPref, t, type LangPref } from '../lib/i18n';
  import { setThemePref, theme, type ThemePref } from '../lib/theme.svelte';
  import { guard, navigate } from '../lib/router.svelte';
  import { auth, changed, loadMe, resetTour, switchDemo, toast, ui, viewingDemo } from '../lib/store.svelte';

  interface Draft { kcal: number; protein: number; carbs: number; fat: number; water: number; steps: number }
  const DEFAULTS: Draft = { kcal: 2000, protein: 100, carbs: 250, fat: 65, water: 2000, steps: 8000 };

  let draft = $state<Draft>({ ...DEFAULTS });
  let saved = $state<Draft>({ ...DEFAULTS });
  let hasGoal = $state(true);
  let loaded = $state(false);
  let saving = $state(false);
  let error = $state('');
  let fieldError = $state<'' | 'kcal' | MacroKey | 'water' | 'steps'>('');
  let calcOpen = $state(false);
  let leaving = $state<string | null>(null);

  const dirty = $derived((Object.keys(draft) as (keyof Draft)[]).some((k) => draft[k] !== saved[k]));
  const showBar = $derived(loaded && (dirty || !hasGoal));
  const macros = $derived({ protein: draft.protein, carbs: draft.carbs, fat: draft.fat });
  const shares = $derived(macroShares(macros));
  const gap = $derived(macroGap(draft.kcal, macros));
  const aligned = $derived(alignCarbs(draft.kcal, macros));
  const preset = $derived(matchingPreset(draft.kcal, macros));
  const glasses = $derived(clamp(Math.round(draft.water / 250), 4, 24));
  const gapText = $derived(
    Math.abs(gap.diff) < 5
      ? t('gpMacroSum', { total: fmt(gap.total) })
      : t(gap.diff < 0 ? 'gpMacroUnder' : 'gpMacroOver', { total: fmt(gap.total), diff: fmt(Math.abs(gap.diff)) }),
  );

  const tiles: { key: MacroKey; label: () => string; bg: string; track: string; radius: string }[] = [
    { key: 'protein', label: () => t('protein'), bg: '#ff8a1f', track: '#b85e0c', radius: '28px 28px 8px 28px' },
    { key: 'carbs', label: () => t('carbs'), bg: '#c9f04a', track: '#8fb022', radius: '28px' },
    { key: 'fat', label: () => t('fat'), bg: '#ffb8d6', track: '#d97aa6', radius: '28px 28px 28px 8px' },
  ];
  const presetName = (id: PresetId) => t(id === 'balanced' ? 'gpPresetBalanced' : id === 'protein' ? 'gpPresetProtein' : 'gpPresetLowcarb');

  // ---- appearance: kept on this device ----
  const LANGS: { id: LangPref; label: () => string }[] = [
    { id: 'auto', label: () => t('langAuto') }, { id: 'de', label: () => t('langDe') }, { id: 'en', label: () => t('langEn') },
  ];
  const THEMES: { id: ThemePref; label: () => string }[] = [
    { id: 'auto', label: () => t('themeAuto') }, { id: 'light', label: () => t('themeLight') }, { id: 'dark', label: () => t('themeDark') },
  ];
  const currentLang = langPref();
  const DRAFT_KEY = 'mahlwerk.profile-draft';
  /** The language changes by reloading the page; goal edits not yet saved are carried over so that nothing is lost. */
  function chooseLang(pref: LangPref) {
    if (pref === currentLang) return;
    try { if (dirty) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* the draft is then lost */ }
    guard.block = null;
    setLangPref(pref);
  }
  function restoreDraft() {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      sessionStorage.removeItem(DRAFT_KEY);
      const back = JSON.parse(raw) as Partial<Draft>;
      for (const key of Object.keys(DEFAULTS) as (keyof Draft)[]) if (typeof back[key] === 'number') draft[key] = back[key] as number;
    } catch { /* an unreadable draft is ignored */ }
  }

  // ---- settings (unchanged behaviour, saved at once) ----
  let demoDays = $state(30);
  let demoBusy = $state(false);
  let demoConfirm = $state(false);
  let demoError = $state('');
  let playBusy = $state(false);
  let playError = $state('');
  const playful = $derived(ui.me?.settings?.playful !== false);
  const fasting = $derived(ui.me?.settings?.fasting ?? { enabled: false, target_hours: 16 });
  const addToGoal = $derived(ui.me?.settings?.activity?.add_to_goal === true);
  let actBusy = $state(false);
  let actError = $state('');
  const FAST_PRESETS = [12, 14, 16, 18, 20];
  let fastBusy = $state(false);
  let fastError = $state('');
  let fastOther = $state('');
  let imports = $state<ImportBatch[]>([]);
  let importConfirm = $state<number | null>(null);
  let importBusy = $state(false);
  let importError = $state('');

  onMount(() => {
    guard.block = (target) => {
      if (!dirty) return false;
      leaving = target;
      return true;
    };
    const beforeUnload = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    void (async () => {
      await loadMe();
      const g = ui.me?.goal;
      hasGoal = !!g;
      const base: Draft = g ? { kcal: g.kcal, protein: g.protein, carbs: g.carbs, fat: g.fat, water: g.water_ml ?? DEFAULTS.water, steps: g.steps ?? DEFAULTS.steps } : { ...DEFAULTS };
      draft = { ...base };
      saved = { ...base };
      restoreDraft();
      fastOther = FAST_PRESETS.includes(fasting.target_hours) ? '' : String(fasting.target_hours);
      loaded = true;
      try { imports = await api.imports(); } catch { imports = []; }
    })();
    return () => { guard.block = null; window.removeEventListener('beforeunload', beforeUnload); };
  });

  // ---- goals ----
  const setKcal = (v: number) => { draft.kcal = clamp(Math.round(v), KCAL_LIMITS.min, KCAL_LIMITS.max); fieldError = ''; };
  const setMacro = (k: MacroKey, v: number) => { draft[k] = clamp(v, MACRO_LIMITS.min, MACRO_LIMITS.max); fieldError = ''; };
  const setSteps = (v: number) => { draft.steps = clamp(Math.round(v), STEPS_LIMITS.min, STEPS_LIMITS.max); fieldError = ''; };
  const setWater = (v: number) => { draft.water = clamp(Math.round(v), WATER_LIMITS.min, WATER_LIMITS.max); fieldError = ''; };
  const applyPreset = (id: PresetId) => { Object.assign(draft, presetMacros(draft.kcal, id)); fieldError = ''; };
  function useSuggestion(kcal: number) {
    const was = matchingPreset(draft.kcal, macros);
    setKcal(kcal);
    if (was) applyPreset(was);
    calcOpen = false;
    toast(t('gpTaken', { n: fmt(draft.kcal) }));
  }
  const discard = () => { draft = { ...saved }; fieldError = ''; error = ''; leaving = null; };

  async function save() {
    saving = true;
    error = '';
    try {
      const goal = await api.setGoal({ kcal: draft.kcal, protein: draft.protein, carbs: draft.carbs, fat: draft.fat, water_ml: draft.water, steps: draft.steps });
      if (ui.me) ui.me.goal = goal;
      saved = { ...draft };
      hasGoal = true;
      changed();
      toast(t('goalSaved'));
      navigate('today');
    } catch (err) {
      error = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      saving = false;
    }
  }

  function leaveNow() {
    const target = leaving;
    guard.block = null;
    leaving = null;
    if (target) location.hash = target; else navigate('today');
  }
  const close = () => { if (dirty) leaving = '#/'; else navigate('today'); };

  // ---- settings ----
  async function replayTour() {
    await resetTour();
    navigate('today');
  }

  async function togglePlayful() {
    if (!ui.me || playBusy) return;
    playBusy = true;
    playError = '';
    try {
      ui.me.settings = await api.setSettings({ playful: !playful });
      changed();
    } catch (err) {
      playError = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      playBusy = false;
    }
  }

  const suggestOn = $derived(ui.me?.settings?.suggestions !== false);
  let sugBusy = $state(false);
  let sugError = $state('');
  async function toggleSuggestions() {
    if (!ui.me || sugBusy) return;
    sugBusy = true;
    sugError = '';
    try {
      ui.me.settings = await api.setSettings({ suggestions: !suggestOn });
      changed();
    } catch (err) {
      sugError = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      sugBusy = false;
    }
  }

  async function toggleAddToGoal() {
    if (!ui.me || actBusy) return;
    actBusy = true;
    actError = '';
    try {
      ui.me.settings = await api.setSettings({ activity: { add_to_goal: !addToGoal } });
      changed();
    } catch (err) {
      actError = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      actBusy = false;
    }
  }

  async function setFasting(patch: { enabled?: boolean; target_hours?: number }) {
    if (!ui.me || fastBusy) return;
    fastBusy = true;
    fastError = '';
    try {
      ui.me.settings = await api.setSettings({ fasting: patch });
      if (patch.target_hours != null) fastOther = FAST_PRESETS.includes(patch.target_hours) ? '' : String(patch.target_hours);
    } catch (err) {
      fastError = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      fastBusy = false;
    }
  }
  function commitOther() {
    const raw = fastOther.trim().replace(',', '.');
    if (raw === '') { fastOther = FAST_PRESETS.includes(fasting.target_hours) ? '' : String(fasting.target_hours); return; }
    const v = /^\d*\.?\d+$/.test(raw) ? Number(raw) : NaN;
    if (Number.isNaN(v) || v < 8 || v > 72) { fastError = t('fastTargetBad'); return; }
    if (v !== fasting.target_hours) void setFasting({ target_hours: v });
  }

  async function refresh() {
    await loadMe();
    changed();
  }

  async function removeImport(id: number) {
    if (importConfirm !== id) { importConfirm = id; return; }
    importBusy = true;
    importError = '';
    try {
      const r = await api.deleteImport(id);
      importConfirm = null;
      imports = await api.imports();
      await refresh();
      toast(t('importRemoved', { entries: r.entries }));
    } catch (err) {
      importError = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      importBusy = false;
    }
  }

  async function createDemo() {
    demoBusy = true;
    demoError = '';
    try {
      const r = await api.createDemo(demoDays);
      await refresh();
      toast(r.entries + r.weights + (r.activity ?? 0) > 0 ? t('demoCreated', { entries: r.entries }) : t('demoCreatedNothing'));
    } catch (err) {
      demoError = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      demoBusy = false;
    }
  }

  async function removeDemo() {
    if (!demoConfirm) { demoConfirm = true; return; }
    demoBusy = true;
    demoError = '';
    try {
      const r = await api.deleteDemo();
      demoConfirm = false;
      await refresh();
      toast(t('demoRemoved', { entries: r.entries }));
    } catch (err) {
      demoError = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      demoBusy = false;
    }
  }
</script>

<div class="page wide gp">
  <div class="page-head">
    <h1>{t('gpTitle')}</h1>
    <button class="round" onclick={close} aria-label={t('back')}><Icon name="close" size={22} /></button>
  </div>

  {#if loaded}
    {#if !viewingDemo()}<NameCard />{/if}
    <div class="cols">
      <div class="goals">
        <!-- calorie goal: the green block -->
        <section class="hero on-dark" aria-label={t('gpKcalLabel')}>
          <span class="micro lab">{t('gpKcalLabel')}</span>
          <div class="bigrow">
            <NumField class="big display" value={draft.kcal} min={KCAL_LIMITS.min} max={KCAL_LIMITS.max} label={t('gpKcalAria')}
              onset={setKcal} onbad={() => (fieldError = 'kcal')} />
            <span class="mono unit">{t('gpKcalUnit')}</span>
          </div>
          {#if fieldError === 'kcal'}<p class="err" role="alert">{t('goalBad')}</p>{/if}
          <KcalScale value={draft.kcal} onset={setKcal} />
          <div class="steps">
            <button type="button" class="step minus" onclick={() => setKcal(draft.kcal - 50)} aria-label={t('gpMinusAria', { n: 50 })}>{t('gpMinus', { n: 50 })}</button>
            <button type="button" class="step plus" onclick={() => setKcal(draft.kcal + 50)} aria-label={t('gpPlusAria', { n: 50 })}>{t('gpPlus', { n: 50 })}</button>
          </div>
          <p class="hint">{t('gpScaleHint')}</p>
        </section>

        <!-- macros -->
        <section class="macros" aria-labelledby="gp-macros">
          <h2 id="gp-macros" class="sr-only">{t('gpMacros')}</h2>
          <div class="tiles">
            {#each tiles as tile}
              <div class="tile" style="background:{tile.bg}; border-radius:{tile.radius}; --track:{tile.track}">
                <span class="tl">{tile.label()}</span>
                <div class="gr display">
                  <NumField value={draft[tile.key]} min={MACRO_LIMITS.min} max={MACRO_LIMITS.max} digits={1}
                    label={t('gpGrams', { name: tile.label() })} onset={(v) => setMacro(tile.key, v)} onbad={() => (fieldError = tile.key)} />
                  <span class="mono unit">g</span>
                </div>
                <span class="mono pct">{t('gpShare', { n: shares[tile.key] })}</span>
                <div class="pm">
                  <button type="button" onclick={() => setMacro(tile.key, draft[tile.key] - 5)} aria-label={t('gpGramsLess', { name: tile.label() })}>−</button>
                  <button type="button" onclick={() => setMacro(tile.key, draft[tile.key] + 5)} aria-label={t('gpGramsMore', { name: tile.label() })}>+</button>
                </div>
              </div>
            {/each}
          </div>
          {#if fieldError === 'protein' || fieldError === 'carbs' || fieldError === 'fat'}<p class="note warn" role="alert">{t('goalBad')}</p>{/if}
          <div class="split" role="img" aria-label={t('gpMacroBarAria', { p: shares.protein, c: shares.carbs, f: shares.fat })}>
            <i style="flex:{Math.max(shares.protein, 0.0001)}; background:#ff8a1f"></i>
            <i style="flex:{Math.max(shares.carbs, 0.0001)}; background:#c9f04a"></i>
            <i style="flex:{Math.max(shares.fat, 0.0001)}; background:#ffb8d6"></i>
          </div>
          <p class="sum" aria-live="polite">{gapText}</p>
          {#if gap.rel > 0.1}
            <div class="align">
              <p>{aligned != null ? t('gpAlignHint', { g: fmt(aligned) }) : t('gpAlignNone')}</p>
              {#if aligned != null}<button type="button" class="btn" onclick={() => setMacro('carbs', aligned)}>{t('gpAlign')}</button>{/if}
            </div>
          {/if}
        </section>

        <!-- presets -->
        <section class="presets" aria-labelledby="gp-presets">
          <h2 id="gp-presets" class="micro quiet">{t('gpPresets')}</h2>
          <div class="chips">
            {#each PRESETS as p}
              <button type="button" class="chip pre" class:on={preset === p.id} aria-pressed={preset === p.id} onclick={() => applyPreset(p.id)}>
                {presetName(p.id)}<span class="mono">{p.shares.join(' · ')}</span>
              </button>
            {/each}
          </div>
          <p class="note">{t('gpPresetNote')}</p>
        </section>

        <!-- water -->
        <section class="water" aria-labelledby="gp-water">
          <div class="top">
            <span id="gp-water" class="micro lab"><Icon name="drop" size={14} stroke={2.4} />{t('waterTitle')}</span>
            <span class="amt">
              <NumField class="wv" value={draft.water} min={WATER_LIMITS.min} max={WATER_LIMITS.max} label={t('gpWaterAria')} grouping={false}
                onset={setWater} onbad={() => (fieldError = 'water')} /> ml
            </span>
          </div>
          <div class="glasses" role="img" aria-label={t('gpWaterGlasses', { ml: fmt(draft.water), n: glasses })}>
            {#each Array.from({ length: glasses }) as _}<span class="g"><i></i></span>{/each}
          </div>
          {#if fieldError === 'water'}<p class="note warn" role="alert">{t('waterBad')}</p>{/if}
          <div class="btns">
            <button type="button" class="minus" onclick={() => setWater(draft.water - 250)} aria-label={t('waterTakeBackAria', { n: 250 })}>{t('waterTakeBack', { n: 250 })}</button>
            <button type="button" class="add" onclick={() => setWater(draft.water + 250)} aria-label={t('waterAddAria', { n: 250 })}>{t('waterAdd', { n: 250 })}</button>
          </div>
        </section>

        <!-- steps -->
        <section class="water steps" aria-labelledby="gp-steps">
          <div class="top">
            <span id="gp-steps" class="micro lab"><Icon name="steps" size={15} stroke={2.4} />{t('gpStepsTitle')}</span>
            <span class="amt">
              <NumField class="wv" value={draft.steps} min={STEPS_LIMITS.min} max={STEPS_LIMITS.max} label={t('gpStepsAria')}
                onset={setSteps} onbad={() => (fieldError = 'steps')} /> {t('gpStepsUnit')}
            </span>
          </div>
          {#if fieldError === 'steps'}<p class="note warn" role="alert">{t('gpStepsBad')}</p>{/if}
          <div class="btns">
            <button type="button" class="minus" onclick={() => setSteps(draft.steps - STEPS_LIMITS.step)} aria-label={t('gpStepsLess')}>− {STEPS_LIMITS.step}</button>
            <button type="button" class="add" onclick={() => setSteps(draft.steps + STEPS_LIMITS.step)} aria-label={t('gpStepsMore')}>+ {STEPS_LIMITS.step}</button>
          </div>
        </section>

        <button type="button" class="calc-open" onclick={() => (calcOpen = true)}>
          <span><strong>{t('gpCalcOpen')}</strong><small>Mifflin-St Jeor</small></span>
          <Icon name="right" size={22} />
        </button>
        {#if error}<p class="note warn" role="alert">{error}</p>{/if}
      </div>

      <div class="settings">
        <section class="card" aria-labelledby="look-title">
          <h2 id="look-title" class="micro quiet">{t('displayTitle')}</h2>
          <div class="field">
            <span id="look-lang">{t('langLabel')}</span>
            <div class="chips" role="group" aria-labelledby="look-lang">
              {#each LANGS as l}
                <button type="button" class="chip" class:on={currentLang === l.id} aria-pressed={currentLang === l.id}
                  lang={l.id === 'auto' ? undefined : l.id} onclick={() => chooseLang(l.id)}>{l.label()}</button>
              {/each}
            </div>
          </div>
          <div class="field">
            <span id="look-theme">{t('themeLabel')}</span>
            <div class="chips" role="group" aria-labelledby="look-theme">
              {#each THEMES as m}
                <button type="button" class="chip" class:on={theme.pref === m.id} aria-pressed={theme.pref === m.id}
                  onclick={() => setThemePref(m.id)}>{m.label()}</button>
              {/each}
            </div>
          </div>
          <p class="note">{t('displayNote')}</p>
        </section>

        <section class="card" aria-labelledby="play-title">
          <h2 id="play-title" class="micro quiet">{t('playTitle')}</h2>
          <Toggle checked={playful} label={t('playTitle')} sub={playful ? t('playOn') : t('playOff')} disabled={playBusy} onchange={togglePlayful} />
          <p class="note">{t('playText')}</p>
          {#if playError}<p class="note warn" role="alert">{playError}</p>{/if}
          {#if playful}<a class="row-pill link" href="#/badges"><span class="t"><strong>{t('badgesLink')}</strong></span><span class="v">→</span></a>{/if}
        </section>

        <section class="card" aria-labelledby="sug-title">
          <h2 id="sug-title" class="micro quiet">{t('sgSettingTitle')}</h2>
          <Toggle checked={suggestOn} label={t('sgSettingTitle')} sub={suggestOn ? t('playOn') : t('playOff')} disabled={sugBusy} onchange={toggleSuggestions} />
          <p class="note">{t('sgSettingText')}</p>
          {#if sugError}<p class="note warn" role="alert">{sugError}</p>{/if}
        </section>

        <section class="card" aria-labelledby="tour-title">
          <h2 id="tour-title" class="micro quiet">{t('tourReplayTitle')}</h2>
          <button type="button" class="row-pill link" onclick={replayTour}>
            <span class="t"><strong>{t('tourReplay')}</strong><small>{t('tourReplayText')}</small></span><span class="v">→</span>
          </button>
        </section>

        <section class="card" aria-labelledby="act-title">
          <h2 id="act-title" class="micro quiet">{t('actTitle')}</h2>
          <Toggle checked={addToGoal} label={t('actSettingTitle')} sub={addToGoal ? t('playOn') : t('playOff')} disabled={actBusy} onchange={toggleAddToGoal} />
          <p class="note">{t('actSettingText')}</p>
          {#if actError}<p class="note warn" role="alert">{actError}</p>{/if}
        </section>

        <section class="card" aria-labelledby="fast-title">
          <h2 id="fast-title" class="micro quiet">{t('fastSettingsTitle')}</h2>
          <Toggle checked={fasting.enabled} label={t('fastSettingsTitle')} sub={fasting.enabled ? t('playOn') : t('playOff')} disabled={fastBusy} onchange={() => setFasting({ enabled: !fasting.enabled })} />
          <p class="note">{t('fastSettingsHint')}</p>
          {#if fasting.enabled}
            <div class="field">
              <span id="fast-target">{t('fastTarget')}</span>
              <div class="chips" role="group" aria-labelledby="fast-target">
                {#each FAST_PRESETS as h}
                  <button type="button" class="chip" class:on={fasting.target_hours === h} aria-pressed={fasting.target_hours === h}
                    disabled={fastBusy} onclick={() => setFasting({ target_hours: h })}>{h} h</button>
                {/each}
                <input class="other" inputmode="decimal" placeholder={t('fastTargetOther')} aria-label={t('fastTargetOther')} bind:value={fastOther}
                  onchange={commitOther} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitOther(); } }} autocomplete="off" />
              </div>
            </div>
          {/if}
          <p class="note">{t('fastNote')}</p>
          {#if fastError}<p class="note warn" role="alert">{fastError}</p>{/if}
        </section>

        {#if ui.me?.demo.available}
          <section class="card" aria-labelledby="demo-title">
            <h2 id="demo-title" class="micro quiet">{t('demoTitle')}</h2>
            <p class="note">{t('demoText')}</p>
            {#if ui.me?.is_admin}<p class="note">{t('demoDataHint')}</p>{/if}
            <div class="field">
              <span id="demo-days">{t('demoDays')}</span>
              <div class="chips" role="group" aria-labelledby="demo-days">
                {#each [14, 30, 90] as n}
                  <button type="button" class="chip" class:on={demoDays === n} aria-pressed={demoDays === n}
                    onclick={() => (demoDays = n)}>{t('demoDaysN', { n })}</button>
                {/each}
              </div>
            </div>
            <div class="chips"><button class="btn" disabled={demoBusy} onclick={createDemo}>{t('demoCreate')}</button></div>
            {#if ui.me.demo.entries > 0 || ui.me.demo.weights > 0 || ui.me.demo.water > 0 || (ui.me.demo.activity ?? 0) > 0}
              <p class="note">{t('demoPresent', { entries: ui.me.demo.entries, weights: ui.me.demo.weights })}</p>
              <div class="chips">
                <button class="btn danger" disabled={demoBusy} onclick={removeDemo}>{demoConfirm ? t('demoConfirm') : t('demoRemove')}</button>
                {#if demoConfirm}
                  <button class="btn quiet-btn" disabled={demoBusy} onclick={() => (demoConfirm = false)}>{t('cancel')}</button>
                {/if}
              </div>
            {/if}
            {#if demoError}<p class="note warn" role="alert">{demoError}</p>{/if}
          </section>
        {/if}

        {#if ui.me?.demo_account?.can_switch}
          <section class="card" aria-labelledby="dacct-title">
            <h2 id="dacct-title" class="micro quiet">{t('demoAcctTitle')}</h2>
            <p class="note">{t('demoAcctText')}</p>
            <div class="chips"><button class="btn" type="button" onclick={() => switchDemo(true)}>{t('demoAcctSwitch')}</button></div>
          </section>
        {/if}

        <section class="card" aria-labelledby="con-title" data-testid="connections">
          <h2 id="con-title" class="micro quiet">{t('conTitle')}</h2>
          <p class="note">{t('conText')}</p>
          {#if ui.me?.features?.cookidoo}
            <div class="conn" role="group" aria-labelledby="con-ck">
              <h3 id="con-ck" class="ct">{t('ckaTitleOwn')}</h3>
              <p class="note">{t('ckaTextOwn')}</p>
              <CookidooAccount scope="own" id="me-ck" />
            </div>
          {:else}
            <p class="note">{t('ckaNeedsConnector')}</p>
          {/if}
        </section>

        {#if !viewingDemo()}<YazioImport onimported={async () => { try { imports = await api.imports(); } catch { /* keep the list */ } await refresh(); }} />{/if}

        {#if imports.length > 0}
          <section class="card" aria-labelledby="import-title">
            <h2 id="import-title" class="micro quiet">{t('importTitle')}</h2>
            <p class="note">{t('importText')}</p>
            {#each imports as batch (batch.id)}
              <div class="batch">
                <p class="note">
                  <strong>{t('importYazio')}</strong> · {fmtDate(batch.created_at)}<br />
                  {t('importCounts', { entries: fmt(batch.counts.entries), days: fmt(batch.counts.days), foods: fmt(batch.counts.foods), weights: fmt(batch.counts.weights) })}
                  {#if batch.counts.activity_days || batch.counts.workouts}<br />{t('importActivity', { days: fmt(batch.counts.activity_days ?? 0), workouts: fmt(batch.counts.workouts ?? 0) })}{/if}
                </p>
                <div class="chips">
                  <button class="btn danger" disabled={importBusy} onclick={() => removeImport(batch.id)}>{importConfirm === batch.id ? t('importConfirm') : t('importRemove')}</button>
                  {#if importConfirm === batch.id}
                    <button class="btn quiet-btn" disabled={importBusy} onclick={() => (importConfirm = null)}>{t('cancel')}</button>
                  {/if}
                </div>
              </div>
            {/each}
            {#if importError}<p class="note warn" role="alert">{importError}</p>{/if}
          </section>
        {/if}

        <section class="card" aria-labelledby="cat-title">
          <h2 id="cat-title" class="micro quiet">{t('gpCatalog')}</h2>
          <p class="stand">
            {#if ui.me && ui.me.catalog.products > 0 && ui.me.catalog.updated_at}
              {t('catalogInfo', { n: fmt(ui.me.catalog.products), date: fmtDate(ui.me.catalog.updated_at) })}
            {:else}
              {t('catalogNone')}
            {/if}
          </p>
          <p class="stand">
            {#if ui.me && ui.me.catalog.bls.products > 0 && ui.me.catalog.bls.updated_at}
              {t('catalogBls', { n: fmt(ui.me.catalog.bls.products), date: fmtDate(ui.me.catalog.bls.updated_at) })}
            {:else}
              {t('catalogBlsNone')}
            {/if}
          </p>
          <p class="note credit">{t('credit')} <a href="https://world.openfoodfacts.org" rel="noopener">Open Food Facts</a> (ODbL) · {t('creditBls')}</p>
        </section>

        {#if auth.mode === 'local' || auth.mode === 'oidc'}<AccountCard />{/if}
        {#if ui.me?.features?.access_tokens !== false}<TokenCard />{/if}
        {#if ui.me?.features?.webhooks !== false}<WebhookCard />{/if}

        {#if ui.me?.is_admin}
          <section class="card" aria-labelledby="admin-title">
            <h2 id="admin-title" class="micro quiet">{t('admTitle')}</h2>
            <p class="note">{t('admCardText')}</p>
            <a class="row-pill link" href="#/admin"><span class="t"><strong>{t('admOpen')}</strong></span><span class="v">→</span></a>
          </section>
        {/if}

        <section class="card" aria-labelledby="acc-title">
          <h2 id="acc-title" class="micro quiet">{t('gpAccount')}</h2>
          <p class="note">{t('goalHint')}</p>
        </section>
      </div>
    </div>

    {#if showBar}
      <div class="bar on-dark" role="region" aria-label={t('gpUnsaved')}>
        {#if leaving}
          <span class="msg" role="alert">{t('gpLeaveAsk')}</span>
          <div class="acts">
            <button type="button" class="b ghost" onclick={() => (leaving = null)}>{t('gpStay')}</button>
            <button type="button" class="b" onclick={leaveNow}>{t('gpLeave')}</button>
          </div>
        {:else}
          <span class="msg micro">{dirty ? t('gpUnsaved') : t('setGoal')}</span>
          <div class="acts">
            {#if dirty}<button type="button" class="b ghost" onclick={discard} disabled={saving}>{t('gpDiscard')}</button>{/if}
            <button type="button" class="b lime" onclick={save} disabled={saving}>{t('save')}</button>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

{#if calcOpen}<GoalCalc onclose={() => (calcOpen = false)} onuse={useSuggestion} />{/if}

<style>
  .cols { display: flex; flex-direction: column; gap: 12px; }
  .goals, .settings { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .micro.lab { display: inline-flex; align-items: center; gap: 6px; }

  /* hero */
  .hero { background: var(--green); color: #fff; border-radius: 44px 44px 44px 14px; padding: 22px 22px 20px; display: flex; flex-direction: column; gap: 10px; --focus: var(--lime); }
  .hero .lab { color: var(--lime); }
  .bigrow { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .bigrow :global(.big) { font-size: 76px; line-height: 1; border-bottom: 3px dotted var(--green-tick); padding-bottom: 2px; border-radius: 0; }
  .bigrow :global(.big:focus-visible) { border-bottom-color: var(--lime); outline-offset: 6px; }
  .unit { font-size: 14px; font-weight: 500; color: var(--on-deep); }
  .err { color: #ffd9b0; font-size: 13px; }
  .steps { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .step { min-height: 52px; border-radius: 26px 26px 26px 10px; font-family: var(--f-mono); font-weight: 600; font-size: 16px; }
  .step.minus { background: var(--green-deep); color: #fff; border: 2px solid var(--green-tick); }
  .step.plus { background: var(--lime); color: var(--on-lime); }
  .step:active { transform: scale(0.97); }
  .hint { font-size: 12.5px; color: var(--on-deep); opacity: 0.88; }

  /* macro tiles */
  .macros { display: flex; flex-direction: column; gap: 12px; }
  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .tile { color: var(--on-tile); padding: 12px 10px 12px 14px; display: flex; flex-direction: column; gap: 4px; min-width: 0; --focus: var(--on-tile); }
  .tl { font-size: 12px; font-weight: 600; white-space: nowrap; letter-spacing: -0.01em; }
  .gr { display: flex; align-items: baseline; gap: 2px; font-size: 32px; line-height: 1.1; min-width: 0; }
  .gr :global(input) { font-size: 32px; border-bottom: 2px dotted var(--track); border-radius: 0; }
  .tile .unit { font-size: 12px; color: var(--on-tile); }
  .pct { font-size: 12px; font-weight: 600; }
  .pm { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 6px; padding-right: 4px; }
  .pm button { min-height: 44px; border-radius: 14px 14px 14px 6px; background: rgba(23, 19, 15, 0.14); color: var(--on-tile); font-size: 22px; font-weight: 600; line-height: 1; }
  .pm button:active { background: rgba(23, 19, 15, 0.26); }
  .split { display: flex; gap: 3px; height: 22px; }
  .split i { display: block; min-width: 3px; border-radius: 8px 8px 8px 3px; transition: flex 200ms; }
  .sum { font-size: 14px; color: var(--text); font-weight: 500; }
  .align { background: var(--paper); border-radius: 20px 20px 20px 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
  .align p { font-size: 13.5px; color: var(--quiet); }
  .align .btn { min-height: 44px; }

  /* presets */
  .presets { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 16px 16px 14px 18px; display: flex; flex-direction: column; gap: 10px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .pre { flex-direction: column; align-items: flex-start; gap: 0; padding: 6px 16px; justify-content: center; border-radius: 22px 22px 22px 8px; }
  .pre .mono { font-size: 11px; font-weight: 500; letter-spacing: 0.04em; opacity: 0.85; }
  .chip { border-radius: 22px 22px 22px 8px; }

  /* water (the water row's look) */
  .water { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 14px 14px 14px 18px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .water .top { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .water .lab { color: var(--quiet); }
  .amt { font-family: var(--f-mono); font-size: 14px; font-weight: 600; color: var(--quiet); }
  .amt :global(.wv) { font-size: 20px; color: var(--text); border-bottom: 2px dotted var(--hairline); border-radius: 0; text-align: right; }
  .glasses { display: flex; gap: 4px; height: 30px; padding-right: 4px; }
  .g { flex: 1 1 0; min-width: 0; display: flex; align-items: flex-end; background: var(--stone); border-radius: 7px 7px 7px 3px; overflow: hidden; }
  .g i { display: block; width: 100%; height: 100%; background: var(--green-tick); }
  .btns { display: flex; gap: 8px; }
  .btns button { min-height: 44px; border-radius: 22px 22px 22px 8px; font-weight: 600; font-size: 14px; white-space: nowrap; --focus: var(--focus-base); }
  .btns .add { flex: 1; background: var(--deep); color: var(--on-deep); }
  .btns .minus { padding: 0 18px; border: 2px solid var(--hairline); font-family: var(--f-mono); font-size: 13px; }
  .btns button:active { transform: scale(0.97); }

  .calc-open { width: 100%; min-height: 64px; border-radius: 20px 20px 20px 8px; background: var(--deep); color: var(--on-deep); padding: 8px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; --focus: var(--lime); }
  .calc-open span { display: flex; flex-direction: column; }
  .calc-open strong { font-size: 16px; font-weight: 600; }
  .calc-open small { font-family: var(--f-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.8; }

  /* save bar */
  .bar { position: sticky; z-index: 15; bottom: calc(var(--nav-h) + 30px + var(--safe-b)); background: var(--deep); color: var(--on-deep); border-radius: 20px 20px 20px 8px; padding: 8px 8px 8px 18px; display: flex; align-items: center; justify-content: space-between; gap: 10px; box-shadow: 0 8px 24px rgba(23, 33, 28, 0.28); --focus: var(--lime); }
  .bar .msg { font-size: 14px; font-weight: 600; min-width: 0; }
  .bar .msg.micro { font-size: 11px; font-weight: 500; }
  .bar .acts { display: flex; gap: 6px; flex-shrink: 0; }
  .b { min-height: 44px; padding: 0 16px; border-radius: 16px 16px 16px 6px; background: var(--on-deep); color: var(--on-lime); font-weight: 700; font-size: 14px; }
  .b.lime { background: var(--lime); }
  .b.ghost { background: transparent; color: var(--on-deep); box-shadow: inset 0 0 0 2px var(--deep-line); }
  .b[disabled] { opacity: 0.55; }

  /* settings cards */
  .card { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 18px 16px 18px 18px; display: flex; flex-direction: column; gap: 12px; }
  .card .note { padding-right: 2px; }
  .conn { display: flex; flex-direction: column; gap: 10px; }
  .ct { font-family: var(--f-display); font-weight: 800; font-size: 20px; letter-spacing: -0.02em; margin: 0; }
  .batch { display: flex; flex-direction: column; gap: 10px; }
  .link { text-decoration: none; color: var(--text); background: var(--stone); }
  .stand { font-size: 14px; }
  .other { width: 92px; min-height: 44px; padding: 0 14px; border-radius: 22px 22px 22px 8px; background: var(--paper); border: 2px solid var(--hairline); font-size: 16px; }
  .other:focus-visible { outline-offset: 0; border-color: var(--green-text); }
  .card .btn { min-height: 44px; }

  @media (min-width: 900px) {
    .gp { max-width: 1120px; }
    .cols { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(0, 1fr); gap: 20px; align-items: start; }
    .goals, .settings { gap: 14px; }
    .hero { padding: 28px 30px 24px; }
    .bigrow :global(.big) { font-size: 96px; }
    .bar { bottom: 20px; max-width: 560px; margin: 0 auto; width: 100%; }
    .glasses { height: 38px; }
  }
  /* big windows: the settings cards flow into two columns next to the goals */
  @media (min-width: 1800px) {
    .gp { max-width: 1640px; }
    .cols { grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.25fr); gap: 28px; }
    .settings { display: block; columns: 2; column-gap: 14px; }
    .settings > :global(*) { break-inside: avoid; margin-bottom: 14px; }
  }
</style>
