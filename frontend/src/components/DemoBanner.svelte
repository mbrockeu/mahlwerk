<script lang="ts">
  import { onMount } from 'svelte';
  import { lang, t } from '../lib/i18n';
  // the demo lives at <site>/demo/, the site's pages one level up
  const home = lang === 'de' ? '../de/' : '../';
  // leaves room under the fixed bar; only a mounted banner (demo build) sets the class
  let bar: HTMLElement;
  // the bar wraps at a very narrow width (200 % zoom): its measured height keeps the room under it
  onMount(() => {
    document.documentElement.classList.add('demo');
    const root = document.documentElement;
    const measure = () => root.style.setProperty('--demo-bar', `${bar.offsetHeight}px`);
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  });
</script>

<div class="demo-banner" role="note" bind:this={bar}>
  <span>{t('demoBanner')}</span>
  <a href={home}>{t('demoBack')}</a>
</div>

<style>
  :global(html.demo #app) { padding-top: var(--demo-bar, 30px); }
  .demo-banner {
    position: fixed; z-index: 60; top: 0; left: 0; right: 0; height: 30px;
    display: flex; align-items: center; justify-content: center; gap: 10px; padding: 0 12px;
    background: var(--lime); color: #17211c; font: 600 12px/1 'Schibsted Grotesk', system-ui, sans-serif;
    white-space: nowrap; overflow: hidden;
  }
  /* very narrow (200 % zoom): the bar wraps instead of cutting the text */
  @media (max-width: 299px) {
    .demo-banner { height: auto; min-height: 30px; padding: 6px 12px; flex-wrap: wrap; white-space: normal; text-align: center; gap: 2px 10px; }
    span { overflow: visible; text-overflow: clip; }
    :global(html.demo .more) { top: calc(var(--band, 0px) + var(--demo-bar, 30px) - 30px); }
  }
  span { overflow: hidden; text-overflow: ellipsis; }
  a { color: inherit; text-decoration: underline; text-underline-offset: 2px; flex: none; }
  a:focus-visible { outline: 3px solid #17211c; outline-offset: 2px; border-radius: 4px; }
</style>
