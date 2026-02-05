import { render } from 'solid-js/web';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import SettingsApp from './SettingsApp';
import './style.css';

let isSettingsWindow = false;
try {
  isSettingsWindow = getCurrentWindow().label === 'settings';
} catch {
  // Running outside Tauri (e.g. plain browser preview) falls back to main UI.
}

const Root = isSettingsWindow ? SettingsApp : App;

render(() => <Root />, document.getElementById('root')!);
