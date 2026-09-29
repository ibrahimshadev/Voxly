/**
 * Display form of a Tauri accelerator: "CommandOrControl+Space" → "Ctrl + Space".
 * `winKey` also shows Super as "Win" (the pill tooltip does; the meeting hint keeps "Super").
 */
export function formatHotkey(hotkey: string, winKey = false): string {
  const ctrl = hotkey.replace('CommandOrControl', 'Ctrl').replace('Control', 'Ctrl');
  return (winKey ? ctrl.replace('Super', 'Win') : ctrl).replace(/\+/g, ' + ');
}
