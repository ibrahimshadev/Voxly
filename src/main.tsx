import { render } from 'solid-js/web';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { APP_NAME } from './branding';

async function boot() {
  document.title = APP_NAME;
  try {
    await getCurrentWindow().setTitle(APP_NAME);
  } catch {
    // Running outside Tauri (e.g. plain browser preview).
  }

  let isSettingsWindow = false;
  try {
    isSettingsWindow = getCurrentWindow().label === 'settings';
  } catch {
    // Running outside Tauri (e.g. plain browser preview) falls back to main UI.
  }

  if (isSettingsWindow) {
    await import('./settings.css');
    const { default: SettingsApp } = await import('./SettingsApp');
    render(() => <SettingsApp />, document.getElementById('root')!);
  } else {
    await import('./style.css');
    const { default: App } = await import('./App');
    render(() => <App />, document.getElementById('root')!);
  }
}

boot();
