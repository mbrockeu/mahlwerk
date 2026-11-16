<script lang="ts">
  import ActivityCard from '../components/ActivityCard.svelte';
  import FastCard from '../components/FastCard.svelte';
  import Icon from '../components/Icon.svelte';
  import Ring from '../components/Ring.svelte';
  import ReviewCard from '../components/ReviewCard.svelte';
  import Suggestions from '../components/Suggestions.svelte';
  import MicroRow from '../components/MicroRow.svelte';
  import TickBar from '../components/TickBar.svelte';
  import WaterRow from '../components/WaterRow.svelte';
  import WeightTile from '../components/WeightTile.svelte';
  import { api, ApiError } from '../lib/api';
  import { fromDay, isoWeek, shiftDay, shortDate, weekdayLong } from '../lib/date';
  import { defaultHome, move, normalize, sameHome, toggleHidden, toggleWide, type HomeCard, type HomeId } from '../lib/homeLayout';
  import { fmt, t } from '../lib/i18n';
  import { reducedMotion } from '../lib/motion.svelte';
  import { directory, ensureNutrients } from '../lib/nutrients.svelte';
  import { entryAmount } from '../lib/portion';
  import { navigate } from '../lib/router.svelte';
  import { changed, mealByTime, openAdd, openAmount, toast, ui } from '../lib/store.svelte';
  import { MEALS, type Day, type Entry, type Meal, type Review } from '../lib/types';

  let data = $state<Day | null>(null);
  let error = $state('');
  let token = 0;
  let expanded = $state<Record<string, boolean>>({});
  let microsOpen = $state(false);
  void ensureNutrients();
  // vitamins and minerals first, everything else after them; only what the day's entries state
  const micros = $derived.by(() => {
    const totals = data?.extra_totals ?? {};
    const order = ['vitamin', 'mineral', 'fat', 'carb', 'other'];
    return directory.list
      .filter((n) => totals[n.key])
      .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
      .map((n) => ({ ...n, ...totals[n.key] }));
  });

  async function load(day: string, _version: number) {
    const mine = ++token;
    try {
      const result = await api.day(day);
      if (mine !== token) return;
      data = result;
      error = '';
    } catch (err) {
      if (mine !== token) return;
      error = err instanceof ApiError ? String(err.status || err.message) : 'error';
    }
  }
  $effect(() => { void load(ui.day, ui.version); });

  const title = $derived(
    ui.day === ui.today ? t('today')
      : ui.day === shiftDay(ui.today, -1) ? t('yesterday')
        : ui.day === shiftDay(ui.today, 1) ? t('tomorrow') : weekdayLong(ui.day),
  );
  const goal = $derived(data?.goal ?? null);
  // the goal that counts today: with active energy added it is the calorie goal plus that day's bonus
  const kcalGoal = $derived(data?.kcal_goal ?? goal?.kcal ?? null);
  const bonus = $derived(data?.activity?.bonus_kcal ?? 0);
  const eaten = $derived(Math.round(data?.totals.kcal ?? 0));
  const suggested = $derived(ui.day === ui.today ? mealByTime() : null);
  // the quiet card "what still fits today" (profile setting; only on today: it counts against what is left of today)
  const ideasOn = $derived(ui.me?.settings?.suggestions !== false && ui.day === ui.today);

  const tiles = $derived([
    { key: 'protein', label: t('protein'), value: data?.totals.protein ?? 0, goal: goal?.protein ?? null, bg: '#ff8a1f', track: '#b85e0c', radius: '28px 28px 8px 28px' },
    { key: 'carbs', label: t('carbs'), value: data?.totals.carbs ?? 0, goal: goal?.carbs ?? null, bg: '#c9f04a', track: '#8fb022', radius: '28px' },
    { key: 'fat', label: t('fat'), value: data?.totals.fat ?? 0, goal: goal?.fat ?? null, bg: '#ffb8d6', track: '#d97aa6', radius: '28px 28px 28px 8px' },
  ]);

  const mealName = (m: Meal) => t(m);
  const summary = (m: Meal) => data?.meals[m].entries.map((e) => e.name || '?').join(', ') ?? '';
  const entryLine = (e: Entry) => [e.brand, entryAmount(e)].filter(Boolean).join(' · ');

  // swipe left/right to change the day
  let sx = 0, sy = 0;
  const touchStart = (e: TouchEvent) => { if (editing) return; sx = e.touches[0].clientX; sy = e.touches[0].clientY; };
  const touchEnd = (e: TouchEvent) => {
    if (editing) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45) ui.day = shiftDay(ui.day, dx < 0 ? 1 : -1);
  };

  // same as yesterday: one tap copies the meal of the previous day, the toast can take it back
  let copying = $state(false);
  const preview = (m: Meal) => {
    const y = data?.yesterday?.[m];
    if (!y) return '';
    const names = y.names.length > 3 ? `${y.names.slice(0, 3).join(', ')} …` : y.names.join(', ');
    return t('yesterdayPreview', { names, kcal: fmt(Math.round(y.kcal)) });
  };
  async function copyYesterday(m: Meal) {
    if (copying) return;
    copying = true;
    try {
      const { entries } = await api.copyEntries(ui.day, { from_day: shiftDay(ui.day, -1), meal: m });
      changed();
      toast(t('copiedN', { n: entries.length }), {
        label: t('undo'),
        run: async () => {
          await Promise.allSettled(entries.map((e) => api.deleteEntry(e.id)));
          changed();
          toast(t('undone'));
        },
      });
    } catch (err) {
      toast(t('copyFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' }));
    } finally {
      copying = false;
    }
  }

  // save a logged meal as a template (inline form inside the opened meal)
  let templating = $state<Meal | null>(null);
  let tplName = $state('');
  let tplError = $state('');
  let tplBusy = $state(false);
  function startTemplate(m: Meal) {
    const names = (data?.meals[m].entries ?? []).slice(0, 2).map((e) => e.name || '?').join(', ');
    tplName = `${mealName(m)}: ${names}`.slice(0, 80);
    tplError = '';
    templating = m;
  }
  async function saveTemplate(event: SubmitEvent, m: Meal) {
    event.preventDefault();
    const name = tplName.trim();
    if (!name || name.length > 80) { tplError = t('templateNameBad'); return; }
    tplBusy = true;
    try {
      await api.createTemplate(name, { day: ui.day, meal: m });
      templating = null;
      toast(t('templateSaved', { name }));
    } catch (err) {
      tplError = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      tplBusy = false;
    }
  }

  // weekly review: Monday to Wednesday on today's page, for the week before; hidden per week once dismissed
  const DISMISSED_KEY = 'mahlwerk.review-dismissed';
  const readDismissed = (): string[] => {
    try { const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
  };
  let dismissed = $state<string[]>(readDismissed());
  const playful = $derived(ui.me?.settings?.playful !== false);
  const reviewWeek = $derived(
    playful && ui.day === ui.today && (fromDay(ui.today).getDay() + 6) % 7 <= 2 ? isoWeek(shiftDay(ui.today, -7)) : null,
  );
  let review = $state<Review | null>(null);
  $effect(() => {
    const w = reviewWeek;
    review = null;
    if (!w || dismissed.includes(w)) return;
    let live = true;
    api.review(w).then((r) => { if (live) review = r; }).catch(() => { /* the card is a bonus */ });
    return () => { live = false; };
  });
  const showReview = $derived(!!review && !!reviewWeek && !dismissed.includes(reviewWeek) && !review.badges.includes('quiet_week'));
  function dismissReview() {
    if (!reviewWeek) return;
    dismissed = [...dismissed, reviewWeek].slice(-30);
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed)); } catch { /* private mode: it just returns next time */ }
  }

  const fastingOn = $derived(ui.me?.settings?.fasting?.enabled === true && ui.day === ui.today);

  // ---- the arrangement of the cards (settings.home): shown from the server value, edited in place on this page ----
  let editing = $state(false);
  let draft = $state<HomeCard[]>([]);
  let saving = $state(false);
  let dragging = $state<HomeId | null>(null);
  const stored = $derived(normalize(ui.me?.settings?.home));
  const layout = $derived(editing ? draft : stored);
  // a card that has nothing to show right now (fasting off, no micros, ideas off) is not drawn, also not while editing
  const available = (id: HomeId) => id === 'fasting' ? fastingOn : id === 'micros' ? micros.length > 0 : id === 'suggestions' ? ideasOn : true;
  const shown = $derived(layout.filter((c) => available(c.id) && (editing || !c.hidden)));
  const calm = $derived(reducedMotion());

  function startEdit() { draft = stored.map((c) => ({ ...c })); editing = true; }
  const cancelEdit = () => { editing = false; dragging = null; };
  async function finishEdit() {
    if (saving) return;
    if (sameHome(draft, stored)) { cancelEdit(); return; }
    saving = true;
    try {
      const home = sameHome(draft, defaultHome()) ? null : draft;
      const settings = await api.setSettings({ home });
      if (ui.me) ui.me.settings = settings;
      cancelEdit();
    } catch (err) {
      toast(t('homeSaveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' }));
    } finally {
      saving = false;
    }
  }
  // one step up or down among the cards that are drawn
  function step(id: HomeId, dir: -1 | 1) {
    const at = shown.findIndex((c) => c.id === id);
    const other = shown[at + dir];
    if (!other) return;
    draft = move(draft, draft.findIndex((c) => c.id === id), draft.findIndex((c) => c.id === other.id));
  }
  const cardName = (id: HomeId) => t(`homeCard_${id}`);

  let lastOver: HomeId | null = null;
  function dragStart(e: PointerEvent, id: HomeId) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = id;
    lastOver = id;
  }
  function dragMove(e: PointerEvent) {
    if (!dragging) return;
    // near the top or bottom edge the page scrolls along
    if (e.clientY < 90) window.scrollBy(0, -14);
    else if (e.clientY > window.innerHeight - 90) window.scrollBy(0, 14);
    const over = (document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-card]') as HTMLElement | null)?.dataset.card as HomeId | undefined;
    if (!over || over === lastOver) return;
    lastOver = over;
    if (over === dragging) return;
    draft = move(draft, draft.findIndex((c) => c.id === dragging), draft.findIndex((c) => c.id === over));
  }
  function dragEnd(e: PointerEvent) {
    if (!dragging) return;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    dragging = null;
    lastOver = null;
  }

  const streakText = $derived(!data ? '' : data.streak === 0 ? t('noStreak') : t(data.streak === 1 ? 'streak1' : 'streakN', { n: data.streak }));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="page today" ontouchstart={touchStart} ontouchend={touchEnd}>
  <div class="page-head">
    <div class="titleline">
      <h1>{title}</h1>
      <span class="micro quiet date">{shortDate(ui.day)}</span>
    </div>
  </div>

  <div class="daybar">
    <div class="arrows">
      <button class="round" onclick={() => (ui.day = shiftDay(ui.day, -1))} aria-label={t('prevDay')}><Icon name="left" size={22} /></button>
      <button class="round" onclick={() => (ui.day = shiftDay(ui.day, 1))} aria-label={t('nextDay')}><Icon name="right" size={22} /></button>
      {#if ui.day !== ui.today}
        <button class="chip" onclick={() => (ui.day = ui.today)}>{t('today')}</button>
      {/if}
      {#if data && !editing}
        <button class="round" onclick={startEdit} aria-label={t('homeEdit')} title={t('homeEdit')}><Icon name="sliders" size={22} /></button>
      {/if}
    </div>
    {#if data}
      {#snippet strokes()}
        <svg width="50" height="12" viewBox="0 0 50 12" aria-hidden="true">
          {#each data!.week as d, i}
            <rect x={i * 7.3} y={d.day === data!.day ? 0 : 2} width="3.6" height={d.day === data!.day ? 12 : 8} rx="1.8" fill={d.logged ? '#c9f04a' : 'var(--tick-off)'} />
          {/each}
        </svg>
      {/snippet}
      {#if playful}
        <a class="pill on-dark" href="#/badges" aria-label="{t('weekAria')}: {streakText}. {t('streakToBadges')}">
          {@render strokes()}
          <span>{streakText}</span>
        </a>
      {:else}
        <div class="pill on-dark" role="img" aria-label={t('weekAria')}>{@render strokes()}</div>
      {/if}
    {/if}
  </div>

  {#if editing}
    <div class="editbar" role="group" aria-label={t('homeEdit')} data-no-pull>
      <p class="hint">{t('homeHint')}</p>
      <div class="ebtns">
        <button type="button" class="btn primary" onclick={finishEdit} disabled={saving}>{t('homeDone')}</button>
        <button type="button" class="btn" onclick={() => (draft = defaultHome())} disabled={saving}>{t('homeReset')}</button>
        <button type="button" class="btn quiet-btn" onclick={cancelEdit} disabled={saving}>{t('homeCancel')}</button>
      </div>
    </div>
  {/if}

  {#if !data && error}
    <div class="error-box">
      <p>{t('loadFailed', { reason: error })}</p>
      <button class="btn primary" onclick={() => load(ui.day, 0)}>{t('retry')}</button>
    </div>
  {:else if !data}
    <div class="skeleton" aria-hidden="true"></div>
  {:else}
    {#if showReview && review}
      <ReviewCard {review} ondismiss={dismissReview} spread />
    {/if}
    {#if !goal}
      <section class="nogoal">
        <div><strong>{t('noGoalTitle')}</strong><p>{t('noGoalText')}</p></div>
        <button class="btn primary" onclick={() => navigate('profile')}>{t('setGoal')}</button>
      </section>
    {/if}

    <div class="grid" class:editing data-no-pull={editing ? '' : undefined}>
      {#each shown as c (c.id)}
        {@const id = c.id}
        <div class="card x-{id}" class:wide={c.wide} class:ghost={c.hidden} class:lifted={dragging === id} class:calm data-card={id}>
          {#if editing}
            <div class="tools" data-no-pull>
              <button type="button" class="tb grip" onpointerdown={(e) => dragStart(e, id)} onpointermove={dragMove} onpointerup={dragEnd} onpointercancel={dragEnd}
                aria-label={t('homeDrag', { card: cardName(id) })}><Icon name="grip" size={22} /></button>
              <span class="cname">{cardName(id)}</span>
              <button type="button" class="tb" onclick={() => step(id, -1)} disabled={shown[0].id === id} aria-label={t('homeUp', { card: cardName(id) })}><Icon name="up" size={22} /></button>
              <button type="button" class="tb" onclick={() => step(id, 1)} disabled={shown[shown.length - 1].id === id} aria-label={t('homeDown', { card: cardName(id) })}><Icon name="down" size={22} /></button>
              <button type="button" class="tb wtoggle" onclick={() => (draft = toggleWide(draft, id))} aria-pressed={c.wide}
                aria-label={t(c.wide ? 'homeNarrow' : 'homeWide', { card: cardName(id) })}><Icon name={c.wide ? 'narrow' : 'wide'} size={22} /></button>
              <button type="button" class="tb" onclick={() => (draft = toggleHidden(draft, id))} aria-pressed={c.hidden}
                aria-label={t(c.hidden ? 'homeShow' : 'homeHide', { card: cardName(id) })}><Icon name={c.hidden ? 'eyeoff' : 'eye'} size={22} /></button>
            </div>
          {/if}
          <div class="body" inert={editing}>
            {#if id === 'ring'}
          <section class="hero on-dark" data-tour="ring" aria-label={t('today')}>
            <Ring {eaten} goal={kcalGoal} day={data.day} />
            <div class="stats">
              <div><span class="micro lab">{t('eaten')}</span><span class="val">{fmt(eaten)}</span></div>
              <div><span class="micro lab">{t('goal')}</span><span class="val">{kcalGoal != null ? fmt(kcalGoal) : '–'}</span>{#if bonus > 0}<span class="incl mono">{t('actInclActive', { n: fmt(bonus) })}</span>{/if}</div>
            </div>
          </section>
            {:else if id === 'macros'}
          <section class="tiles" data-tour="macros">
            {#each tiles as tile}
              <div class="tile" style="background:{tile.bg}; border-radius:{tile.radius}">
                <span class="tl">{tile.label}</span>
                <span class="tv display">{fmt(tile.value)}{#if tile.goal}<span class="mono unit"> /{fmt(tile.goal)} g</span>{:else}<span class="mono unit"> g</span>{/if}</span>
                <TickBar value={tile.value} goal={tile.goal} track={tile.track}
                  label={tile.goal ? t('macroAria', { value: fmt(tile.value), goal: fmt(tile.goal) }) : t('macroAriaNoGoal', { value: fmt(tile.value) })} />
              </div>
            {/each}
          </section>
            {:else if id === 'fasting'}
              <FastCard />
            {:else if id === 'water'}
              <WaterRow day={data.day} ml={data.water?.ml ?? 0} goalMl={data.water?.goal_ml ?? 2000} drinksMl={data.water?.drinks_ml ?? 0} />
            {:else if id === 'activity'}
              <ActivityCard day={data.day} activity={data.activity} />
            {:else if id === 'weight'}
              <WeightTile />
            {:else if id === 'meals'}
              <section class="rows meals">
        {#each MEALS as m, mi}
          {@const meal = data.meals[m]}
          {@const has = meal.entries.length > 0}
          {@const cta = suggested === m && !has}
          <div class="meal" data-tour={mi === 0 ? 'meal' : undefined} class:cta class:open={expanded[m]}>
            <div class="head">
              {#if has}
                <button class="main" aria-expanded={!!expanded[m]} onclick={() => (expanded[m] = !expanded[m])}>
                  <span class="t"><strong>{mealName(m)}</strong><small>{summary(m)}</small></span>
                  <span class="v">{fmt(Math.round(meal.kcal))}</span>
                </button>
              {:else}
                <button class="main" onclick={() => openAdd(m, ui.day, 'search')}>
                  <span class="t"><strong>{mealName(m)}</strong><small>{cta && ui.day === ui.today ? t('whatsFor') : t('emptyMeal')}</small></span>
                </button>
              {/if}
              <button class="plus" onclick={() => openAdd(m, ui.day, 'search')} aria-label={t('addTo', { meal: mealName(m) })}>
                <Icon name="plus" size={20} stroke={2.4} />
              </button>
            </div>
            {#if !has && data.yesterday?.[m]}
              <button class="again" onclick={() => copyYesterday(m)} disabled={copying}>
                <Icon name="repeat" size={20} />
                <span class="t"><strong>{t('sameAsYesterday')}</strong><small>{preview(m)}</small></span>
              </button>
            {/if}
            {#if has && expanded[m]}
              <ul class="entries">
                {#each meal.entries as e (e.id)}
                  <li>
                    <button onclick={() => openAmount({ entry: e, meal: e.meal, day: ui.day })}
                      aria-label={t('entryAria', { name: e.name ?? '?', amount: entryAmount(e), kcal: e.kcal == null ? '–' : fmt(Math.round(e.kcal)) })}>
                      <span class="t"><strong>{e.name || '?'}</strong><small>{entryLine(e)}</small></span>
                      <span class="v">{e.kcal == null ? '–' : fmt(Math.round(e.kcal))}</span>
                    </button>
                  </li>
                {/each}
              </ul>
              {#if templating === m}
                <form class="tplform" onsubmit={(e) => saveTemplate(e, m)}>
                  <label class="field"><span>{t('templateName')}</span>
                    <input bind:value={tplName} maxlength="80" autocomplete="off" aria-invalid={tplError ? 'true' : undefined} />
                  </label>
                  {#if tplError}<p class="note warn" role="alert">{tplError}</p>{/if}
                  <div class="tplbtns">
                    <button class="btn primary" disabled={tplBusy}>{t('save')}</button>
                    <button type="button" class="btn" onclick={() => (templating = null)}>{t('cancel')}</button>
                  </div>
                </form>
              {:else}
                <button class="astpl" onclick={() => startTemplate(m)}><Icon name="bookmark" size={18} />{t('saveAsTemplate')}</button>
              {/if}
            {/if}
          </div>
        {/each}
              </section>
            {:else if id === 'micros'}
        <div class="micros" class:open={microsOpen}>
        <button class="main" aria-expanded={microsOpen} onclick={() => (microsOpen = !microsOpen)}>
          <span class="t"><strong>{t('microsToday')}</strong><small>{micros.length}</small></span>
          <span class="chev" aria-hidden="true"><Icon name="down" size={18} /></span>
        </button>
        {#if microsOpen}
          <p class="note">{t('microNoteToday')}</p>
          <ul class="mlist">
            {#each micros as m (m.key)}
              <MicroRow key={m.key} unit={m.unit} amount={m.amount} nrv={m.nrv} coverage={m.coverage} />
            {/each}
          </ul>
        {/if}
      </div>
            {:else if id === 'suggestions'}
              <Suggestions day={ui.day} variant="card" />
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .titleline { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
  .date { white-space: nowrap; font-size: 12px; text-transform: none; }
  .daybar { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: -2px; }
  .arrows { display: flex; align-items: center; gap: 6px; }
  .pill {
    display: flex; align-items: center; gap: 9px; height: 36px; padding: 0 14px; border-radius: 20px; background: var(--deep); color: var(--on-deep);
    font-size: 13px; font-weight: 600; white-space: nowrap; text-decoration: none; --focus: var(--focus-base);
  }
  a.pill { min-height: 44px; height: 44px; }
  .skeleton { height: 250px; border-radius: 44px 44px 44px 14px; background: var(--hairline); opacity: 0.5; }

  .hero {
    min-height: 250px; border-radius: 44px 44px 44px 14px; background: var(--green); color: #fff; padding: 24px 20px;
    display: flex; align-items: center; gap: 14px; --focus: var(--lime);
  }
  .stats { display: flex; flex-direction: column; gap: 16px; flex-grow: 1; min-width: 0; }
  .stats div { display: flex; flex-direction: column; gap: 2px; }
  .lab { color: #d5ead0; }
  .val { font-family: var(--f-mono); font-size: 22px; font-weight: 600; }
  .incl { font-size: 12px; font-weight: 500; color: var(--lime); }

  .nogoal { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
  .nogoal p { font-size: 14px; color: var(--quiet); margin-top: 2px; }

  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .tile { height: 96px; color: var(--on-tile); padding: 12px 12px 12px 14px; display: flex; flex-direction: column; justify-content: space-between; min-width: 0; }
  .tl { font-size: 12px; font-weight: 600; white-space: nowrap; letter-spacing: -0.01em; }
  .tv { font-size: 26px; line-height: 1; white-space: nowrap; }
  .unit { font-size: 12px; font-weight: 500; letter-spacing: 0; }

  /* one grid for all cards, in the order of the layout: a single column on the phone, two on wide screens (`wide` spans both) */
  .grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .card { display: flex; flex-direction: column; min-width: 0; }
  .body { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .body > :global(*) { flex: 1; }
  .rows { gap: 6px; }
  .meal { background: var(--paper); border-radius: 20px; overflow: hidden; }
  .meal.cta { background: var(--deep); color: var(--on-deep); border-radius: 20px 20px 20px 8px; --focus: var(--lime); }
  .head { display: flex; align-items: center; min-height: 52px; }
  .main { flex: 1; min-width: 0; min-height: 52px; padding: 6px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; }
  .t { display: flex; flex-direction: column; min-width: 0; }
  .t strong { font-size: 15px; font-weight: 600; line-height: 1.2; }
  .t small { font-size: 12px; color: var(--quiet); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cta .t small { color: #cfd6cc; }
  .again {
    width: calc(100% - 16px); margin: 0 8px 8px; min-height: 52px; padding: 6px 14px; border-radius: 14px 14px 14px 6px; display: flex; align-items: center; gap: 12px;
    text-align: left; background: var(--stone); color: var(--text); border: 2px solid transparent;
  }
  .again .t { flex: 1; }
  .again .t small { color: var(--quiet); }
  .again :global(svg) { flex-shrink: 0; color: var(--green-text); }
  .cta .again { background: var(--lime); color: var(--on-lime); }
  .cta .again .t small { color: #2c3a14; }
  .cta .again :global(svg) { color: var(--on-lime); }
  .astpl { width: 100%; min-height: 48px; padding: 4px 18px; display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; color: var(--green-text); border-top: 1px solid var(--hairline); }
  .tplform { border-top: 1px solid var(--hairline); padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
  .tplform .field input { background: var(--stone); }
  .tplbtns { display: flex; gap: 8px; }
  .tplbtns .btn { flex: 1; }
  .v { font-family: var(--f-mono); font-size: 16px; font-weight: 600; }
  .plus {
    width: 44px; height: 44px; margin: 0 4px 0 -4px; border-radius: 22px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    border: 2px solid var(--hairline); color: var(--text);
  }
  .cta .plus { background: var(--lime); border-color: var(--lime); color: var(--on-lime); }
  .entries { border-top: 1px solid var(--hairline); padding: 4px 0 6px; animation: unfold 220ms ease-out; }
  .entries button { width: 100%; min-height: 48px; padding: 4px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; }
  .entries .v { font-size: 14px; }
  .micros { background: var(--paper); border-radius: 20px; margin-top: 6px; overflow: hidden; }
  .micros .main { width: 100%; }
  .micros .t small { color: var(--quiet); }
  .micros .chev { display: flex; transition: transform 160ms; }
  .micros.open .chev { transform: rotate(180deg); }
  .micros .note { padding: 0 18px; animation: unfold 220ms ease-out; }
  .mlist { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px 40px; padding: 12px 18px 18px; animation: unfold 220ms ease-out; }
  @keyframes unfold { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
  .meals { display: flex; flex-direction: column; }
  .micros { margin-top: 0; }

  /* edit mode: every card carries its toolbar, the content is inert */
  .editbar {
    position: sticky; top: calc(var(--safe-t) + 8px); z-index: 30; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px;
    padding: 10px 12px 10px 16px; border-radius: 24px 24px 24px 8px; background: var(--deep); color: var(--on-deep); --focus: var(--lime);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  }
  .editbar .hint { font-size: 13px; flex: 1 1 200px; }
  .ebtns { display: flex; flex-wrap: wrap; gap: 8px; }
  .editbar .btn.quiet-btn { color: var(--on-deep); }
  .editbar .btn:not(.primary):not(.quiet-btn) { background: transparent; color: var(--on-deep); border-color: #5b6b61; }
  .grid.editing .card { outline: 2px dashed var(--hairline); outline-offset: 3px; border-radius: 20px; }
  .tools { display: flex; align-items: center; gap: 2px; padding: 2px 4px; margin-bottom: 6px; background: var(--paper); border-radius: 22px; }
  .cname { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px; }
  .tb { width: 44px; height: 44px; min-width: 44px; border-radius: 22px; display: inline-flex; align-items: center; justify-content: center; color: var(--text); flex-shrink: 0; }
  .tb[disabled] { opacity: 0.35; }
  .tb[aria-pressed='true'] { background: var(--sel-bg); color: var(--sel-fg); }
  .grip { cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
  .lifted .grip { cursor: grabbing; }
  .wtoggle { display: none; }
  .card.ghost .body { opacity: 0.4; }
  .card:not(.calm) { transition: transform 140ms, box-shadow 140ms; }
  .card.lifted { transform: scale(1.015); box-shadow: 0 14px 34px rgba(0, 0, 0, 0.3); z-index: 5; position: relative; outline-style: solid; outline-color: var(--lime); }
  @media (prefers-reduced-motion: reduce) { .card { transition: none !important; } }

  @media (min-width: 900px) {
    .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
    .card.wide { grid-column: 1 / -1; }
    .wtoggle { display: inline-flex; }
    .nogoal { flex-direction: row; align-items: center; justify-content: space-between; }
    /* the macro tiles stack when the card is half wide, and sit side by side when it is full wide */
    .card:not(.wide) .tiles { grid-template-columns: minmax(0, 1fr); grid-template-rows: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .card:not(.wide) .tile { height: auto; min-height: 88px; padding: 14px 18px; }
    .card.wide .tiles { gap: 12px; }
    .card:not(.wide) .tv { font-size: 30px; }
    .card.wide .meals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; align-items: start; }
    .mlist { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .hero { min-height: 300px; padding: 28px 40px; justify-content: space-around; gap: 32px; }
    .stats { flex-grow: 0; gap: 26px; min-width: 190px; }
    .stats div { gap: 4px; }
    .val { font-family: var(--f-display); font-weight: 800; letter-spacing: -0.04em; font-size: clamp(44px, 5vw, 60px); line-height: 0.95; }
    .skeleton { height: 300px; }
  }
  @media (max-width: 359px) { .hero { flex-direction: column; padding: 20px; } .stats { flex-direction: row; } }
</style>
