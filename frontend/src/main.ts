import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { initTheme } from './lib/theme.svelte';

initTheme();
mount(App, { target: document.getElementById('app')! });

// iOS Safari ignores user-scalable=no; its pinch gesture is cancelled here instead.
document.addEventListener('gesturestart', (event) => event.preventDefault());
