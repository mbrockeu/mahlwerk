<script lang="ts">
  type Name = 'home' | 'bars' | 'list' | 'trend' | 'scan' | 'plus' | 'left' | 'right' | 'down' | 'close' | 'camera' | 'user' | 'check' | 'search' | 'clock' | 'more' | 'repeat' | 'bookmark' | 'edit' | 'drop' | 'shield' | 'copy' | 'pot' | 'medal' | 'logout'
    | 'steps' | 'flame' | 'walk' | 'run' | 'bike' | 'mountain' | 'swim' | 'dumbbell' | 'lotus' | 'bolt' | 'stairs' | 'ball' | 'music' | 'folder' | 'up';
  let { name, size = 24, stroke = 2.2 }: { name: Name; size?: number; stroke?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke}
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#if name === 'home'}<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" />
  {:else if name === 'bars'}<path d="M5 20V11M12 20V4M19 20v-6" />
  {:else if name === 'list'}<path d="M4 6h16M4 12h16M4 18h10" />
  {:else if name === 'trend'}<path d="M4 17l5-5 4 3 7-8" />
  {:else if name === 'scan'}<path d="M3 8V5a2 2 0 0 1 2-2h3M18 3h3a2 2 0 0 1 2 2v3M23 18v3a2 2 0 0 1-2 2h-3M8 23H5a2 2 0 0 1-2-2v-3M8 9v8M12 9v8M15 9v8M18 9v8" transform="translate(-1 -1)" />
  {:else if name === 'plus'}<path d="M12 5v14M5 12h14" />
  {:else if name === 'left'}<path d="M14.5 5l-7 7 7 7" />
  {:else if name === 'right'}<path d="M9.5 5l7 7-7 7" />
  {:else if name === 'down'}<path d="M5 9.5l7 7 7-7" />
  {:else if name === 'close'}<path d="M6 6l12 12M18 6L6 18" />
  {:else if name === 'camera'}<path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><circle cx="12" cy="13" r="3.5" />
  {:else if name === 'user'}<circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20c.8-3.6 3.6-5.5 7.5-5.5s6.7 1.9 7.5 5.5" />
  {:else if name === 'check'}<path d="M5 12.5l4.5 4.5L19 7.5" />
  {:else if name === 'search'}<circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" />
  {:else if name === 'clock'}<circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
  {:else if name === 'more'}<circle cx="5.5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="18.5" cy="12" r="1.4" fill="currentColor" />
  {:else if name === 'repeat'}<path d="M4 12a8 8 0 0 1 13.5-5.8L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.5 5.8L4 15.5M4 20v-4.5h4.5" />
  {:else if name === 'bookmark'}<path d="M6.5 4h11a1 1 0 0 1 1 1v15l-6.5-4.2L5.5 20V5a1 1 0 0 1 1-1z" />
  {:else if name === 'edit'}<path d="M4.5 19.5l.8-4L16 4.8a1.6 1.6 0 0 1 2.2 0l1 1a1.6 1.6 0 0 1 0 2.2L8.5 18.7z" /><path d="M14.5 6.5l3 3" />
  {:else if name === 'drop'}<path d="M12 3.5c3.4 4.2 5.6 7 5.6 10.1a5.6 5.6 0 0 1-11.2 0c0-3.1 2.2-5.9 5.6-10.1z" />
  {:else if name === 'shield'}<path d="M12 3.2l7 2.6v5.4c0 4.4-2.9 7.9-7 9.6-4.1-1.7-7-5.2-7-9.6V5.8z" /><path d="M9 12l2.2 2.2L15.2 10" />
  {:else if name === 'pot'}<path d="M4.5 11h15v5a4 4 0 0 1-4 4h-7a4 4 0 0 1-4-4z" /><path d="M3 11h18M9 7.5c0-1.4 1.2-1.4 1.2-2.8M14 7.5c0-1.4 1.2-1.4 1.2-2.8" />
  {:else if name === 'medal'}<circle cx="12" cy="9.5" r="5" /><path d="M8.6 13.4L7 20.5l5-2.6 5 2.6-1.6-7.1" />
  {:else if name === 'logout'}<path d="M9.5 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3.5M15 8l4 4-4 4M19 12H9.5" />
  {:else if name === 'copy'}<rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  {:else if name === 'steps'}<path d="M8.2 4.5c1.6 0 2.6 1.7 2.6 3.7 0 1.8-.9 3.3-2.5 3.3S5.7 10 5.7 8.2c0-2 .9-3.7 2.5-3.7z" /><path d="M7 14.3h2.8v1.3c0 1-.6 1.8-1.4 1.8S7 16.6 7 15.6z" /><path d="M15.8 8c1.6 0 2.5 1.7 2.5 3.6 0 1.8-.9 3.3-2.5 3.3s-2.5-1.5-2.5-3.3c0-1.9.9-3.6 2.5-3.6z" /><path d="M14.6 17.5h2.8v1.3c0 1-.6 1.8-1.4 1.8s-1.4-.8-1.4-1.8z" />
  {:else if name === 'flame'}<path d="M12 3c.6 3.2-2.7 4.6-2.7 8.1a2.7 2.7 0 0 0 5.4 0c0-1-.4-1.8-1-2.5 2.7 1 4.3 3.1 4.3 5.9a6 6 0 0 1-12 0c0-3.9 2.9-6.3 6-11.5z" />
  {:else if name === 'walk'}<circle cx="13" cy="4.6" r="1.7" /><path d="M13 8l-2 6 3 2 .8 4.5M13 8l3 3.2 2.2.6M13 8l-3.2 2.4L8 13M11 14l-3 6" />
  {:else if name === 'run'}<circle cx="15.5" cy="4.6" r="1.7" /><path d="M14 8.2l-3.2 4.8 3.7 2.4-1 4.6M14 8.2l3.2 1.6 2.4-1.6M14 8.2l-4 1-1.8 3.2M10.8 13L7.5 13.8 5 12.4" />
  {:else if name === 'bike'}<circle cx="6" cy="16" r="3.6" /><circle cx="18" cy="16" r="3.6" /><path d="M6 16l4-7h5l3 7M10 9l3.6 7M8.8 9H11.5M15 9l-.8-2.2h2" />
  {:else if name === 'mountain'}<path d="M3 19l6-10.5 3.6 6 2.4-3.5L21 19z" />
  {:else if name === 'swim'}<circle cx="16.5" cy="6.5" r="1.7" /><path d="M6 13l4.6-3.4 3.6 1.6 1.8 2.3M3 18c1.5-1.4 3-1.4 4.5 0s3 1.4 4.5 0 3-1.4 4.5 0 3 1.4 4.5 0" />
  {:else if name === 'dumbbell'}<path d="M6.5 7.5v9M3.5 10v4M17.5 7.5v9M20.5 10v4M6.5 12h11" />
  {:else if name === 'lotus'}<path d="M12 19c-3.2-1-5.3-3.7-5.8-7.4 2.6.3 4.4 1.7 5.8 3.7 1.4-2 3.2-3.4 5.8-3.7-.5 3.7-2.6 6.4-5.8 7.4zM12 14.6c-1.2-2.1-1.2-4.8 0-7.6 1.2 2.8 1.2 5.5 0 7.6z" />
  {:else if name === 'bolt'}<path d="M13 3L6 13.5h5L10 21l8-11h-5z" />
  {:else if name === 'stairs'}<path d="M4 19h4.5v-4h4v-4H17V7h3" />
  {:else if name === 'ball'}<circle cx="12" cy="12" r="8" /><path d="M5.2 6.8c4.2 2.2 4.2 8.2 0 10.4M18.8 6.8c-4.2 2.2-4.2 8.2 0 10.4" />
  {:else if name === 'folder'}<path d="M3.5 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2h8a1.5 1.5 0 0 1 1.5 1.5v8.3a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
  {:else if name === 'up'}<path d="M5 14.5l7-7 7 7" />
  {:else if name === 'music'}<path d="M9 18V6.5l10-2V16M9 18a2.4 2.4 0 1 1-2.4-2.4A2.4 2.4 0 0 1 9 18zM19 16a2.4 2.4 0 1 1-2.4-2.4A2.4 2.4 0 0 1 19 16z" />
  {/if}
</svg>
