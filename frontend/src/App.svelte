<script lang="ts">
  import { onMount } from 'svelte';
  import AddSheet from './components/AddSheet.svelte';
  import BadgeMoment from './components/BadgeMoment.svelte';
  import AmountSheet from './components/AmountSheet.svelte';
  import MoreMenu from './components/MoreMenu.svelte';
  import Nav from './components/Nav.svelte';
  import PullRefresh from './components/PullRefresh.svelte';
  import Tour from './components/Tour.svelte';
  import ProductEditor from './components/ProductEditor.svelte';
  import RecipeEditor from './components/RecipeEditor.svelte';
  import WorkoutSheet from './components/WorkoutSheet.svelte';
  import { router } from './lib/router.svelte';
  import { auth, endMoment, loadAuth, loadMe, markTourSeen, runToastAction, tourSeen, ui } from './lib/store.svelte';
  import Gate from './views/Gate.svelte';
  import Admin from './views/Admin.svelte';
  import Badges from './views/Badges.svelte';
  import Insights from './views/Insights.svelte';
  import Products from './views/Products.svelte';
  import Recipes from './views/Recipes.svelte';
  import Profile from './views/Profile.svelte';
  import Today from './views/Today.svelte';
  import Weight from './views/Weight.svelte';
  import DemoBanner from './components/DemoBanner.svelte';
  import DemoViewBand from './components/DemoViewBand.svelte';
  import { DEMO } from './lib/demo';

  // First-run tour: only on the day view, once the profile is known, and never over another dialog.
  let tourOpen = $state(false);
  const tourDue = $derived(
    auth.signedIn && router.route === 'today' && !!ui.me && !tourSeen()
      && !ui.add && !ui.amount && !ui.recipe && !ui.editor && !ui.workout && !ui.moment,
  );
  $effect(() => {
    if (!tourDue || tourOpen) return;
    // wait until the day has loaded and the ring is on screen
    let tries = 0;
    const timer = window.setInterval(() => {
      const ring = document.querySelector('[data-tour="ring"]');
      if (ring && ring.getClientRects().length > 0) { window.clearInterval(timer); window.setTimeout(() => { if (tourDue) tourOpen = true; }, 500); }
      else if (++tries > 40) window.clearInterval(timer);
    }, 150);
    return () => window.clearInterval(timer);
  });
  // leaving the day view (browser back) or a dialog opening ends the tour without counting it as seen
  $effect(() => { if (tourOpen && (router.route !== 'today' || ui.add || ui.amount || ui.recipe || ui.editor || ui.workout || ui.moment)) tourOpen = false; });
  const endTour = () => { tourOpen = false; void markTourSeen(); };

  // the phone's more menu (round avatar, top right) is on every main page; profile, badges and admin have their own close button there
  const hasMenu = $derived(['today', 'history', 'products', 'recipes', 'weight'].includes(router.route));

  onMount(() => { void (async () => { await loadAuth(); if (auth.signedIn) await loadMe(); })(); });
</script>

{#if DEMO}<DemoBanner />{/if}

{#if !auth.ready}
  <!-- first answer of the server pending: nothing to show yet -->
{:else if !auth.signedIn}
  <Gate />
{:else}
{#key auth.epoch}
{#if ui.me?.demo_account?.viewing}<DemoViewBand />{/if}
<main class:hasmenu={hasMenu}>
  {#if router.route === 'today'}<Today />
  {:else if router.route === 'history'}<Insights />
  {:else if router.route === 'products'}<Products />
  {:else if router.route === 'recipes'}<Recipes />
  {:else if router.route === 'weight'}<Weight />
  {:else if router.route === 'badges'}<Badges />
  {:else if router.route === 'admin'}<Admin />
  {:else}<Profile />{/if}
</main>

{#if hasMenu}<MoreMenu />{/if}
<Nav />
<PullRefresh />

{#if ui.add}{#key ui.add}<AddSheet meal={ui.add.meal} day={ui.add.day} tab={ui.add.tab} />{/key}{/if}
{#if ui.amount}{#key ui.amount}<AmountSheet req={ui.amount} />{/key}{/if}
{#if ui.recipe}{#key ui.recipe}<RecipeEditor req={ui.recipe} />{/key}{/if}
{#if ui.editor}{#key ui.editor}<ProductEditor req={ui.editor} />{/key}{/if}
{#if ui.workout}{#key ui.workout}<WorkoutSheet req={ui.workout} />{/key}{/if}

{#if tourOpen}<Tour ondone={endTour} />{/if}

{#if ui.moment}<BadgeMoment codes={ui.moment} ondone={endMoment} />{/if}
{/key}
{/if}

{#if ui.toast}
  <div class="toast" role="status">
    <span>{ui.toast}</span>
    {#if ui.toastAction}
      <button class="undo" onclick={runToastAction}>{ui.toastAction.label}</button>
    {/if}
  </div>
{/if}

<style>
  .toast {
    position: fixed; z-index: 40; left: 50%; transform: translateX(-50%); bottom: calc(var(--nav-h) + 30px + var(--safe-b));
    width: max-content; max-width: calc(100% - 40px); background: var(--green); color: #fff; font-weight: 600; font-size: 14px;
    padding: 12px 18px; border-radius: 20px 20px 20px 8px; display: flex; align-items: center; gap: 14px; box-shadow: 0 8px 24px rgba(23, 33, 28, 0.25);
    animation: pop 240ms cubic-bezier(0.2, 0.9, 0.3, 1.3);
  }
  .toast .undo { min-height: 44px; margin: -8px -8px -8px 0; padding: 0 16px; border-radius: 16px 16px 16px 6px; background: var(--lime); color: var(--on-lime); font-weight: 700; font-size: 14px; flex-shrink: 0; }
  @media (min-width: 900px) { .toast { left: calc(50% + 52px); bottom: 30px; } }
  @keyframes pop { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 0); } }
</style>
