<script lang="ts">
  import { onMount } from 'svelte';
  import { lang, t } from '../lib/i18n';
  // the demo lives at <site>/demo/, the site's pages one level up
  const home = lang === 'de' ? '../de/' : '../';
  // leaves room under the fixed bar; only a mounted banner (demo build) sets the class
  onMount(() => { document.documentElement.classList.add('demo'); });
</script>

<div class="demo-banner" role="note">
  <span>{t('demoBanner')}</span>
  <a href={home}>{t('demoBack')}</a>
</div>

<style>
  :global(html.demo #app) { padding-top: 30px; }
  .demo-banner {
    position: fixed; z-index: 60; top: 0; left: 0; right: 0; height: var(--demo-bar, 30px);
    display: flex; align-items: center; justify-content: center; gap: 10px; padding: 0 12px;
    background: var(--lime); color: #17211c; font: 600 12px/1 'Schibsted Grotesk', system-ui, sans-serif;
    white-space: nowrap; overflow: hidden;
  }
  span { overflow: hidden; text-overflow: ellipsis; }
  a { color: inherit; text-decoration: underline; text-underline-offset: 2px; flex: none; }
  a:focus-visible { outline: 3px solid #17211c; outline-offset: 2px; border-radius: 4px; }
</style>
