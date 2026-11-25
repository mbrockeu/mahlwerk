import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { initTheme } from './lib/theme.svelte';

initTheme();
mount(App, { target: document.getElementById('app')! });

// Pinch zoom stays allowed (WCAG 1.4.4: text can be enlarged; in the iOS app there is no other way to zoom).
