import { Show, Index, For, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Mode, Settings } from '../../types';

type ModesTabProps = {
  settings: Accessor<Settings>;
  modes: Accessor<Mode[]>;
  activeModeId: Accessor<string | null>;
  modelsList: Accessor<string[]>;
  modelsLoading: Accessor<boolean>;
  modelsError: Accessor<string>;
  saving: Accessor<boolean>;
  onUpdateMode: (id: string, field: keyof Mode, value: string) => void;
  onSetActiveModeId: (id: string | null) => void;
  onAddMode: () => void;
  onDeleteMode: (id: string) => void;
  onSave: () => void;
};

export default function ModesTab(props: ModesTabProps) {
  const [editingModeId, setEditingModeId] = createSignal<string | null>(null);

  const toggleEditor = (id: string) => {
    setEditingModeId((current) => (current === id ? null : id));
  };

  return (
    <div class="settings-content modes-content">
      <div class="modes-toolbar">
        <span class="muted">
          Active mode:{' '}
          {props.activeModeId()
            ? props.modes().find((mode) => mode.id === props.activeModeId())?.name || 'Selected'
            : 'None'}
        </span>
        <button
          class="mini-button"
          disabled={props.activeModeId() === null}
          onClick={() => props.onSetActiveModeId(null)}
          type="button"
        >
          No active mode
        </button>
      </div>

      <Show when={props.modelsError()}>
        <div class="muted">{props.modelsError()}</div>
      </Show>

      <Show
        when={props.modes().length > 0}
        fallback={<div class="muted">No modes yet. Add a mode to format transcriptions.</div>}
      >
        <div class="modes-list">
          <Index each={props.modes()}>
            {(mode) => (
              <div class="mode-card" classList={{ active: props.activeModeId() === mode().id }}>
                <div class="mode-summary">
                  <div class="mode-summary-main">
                    <div class="mode-title">{mode().name.trim() || 'Untitled mode'}</div>
                    <div class="mode-summary-meta">
                      {props.activeModeId() === mode().id ? 'Active' : 'Inactive'}
                    </div>
                  </div>
                  <div class="mode-summary-actions">
                    <button
                      class="mini-button"
                      onClick={() =>
                        props.onSetActiveModeId(props.activeModeId() === mode().id ? null : mode().id)
                      }
                      type="button"
                    >
                      {props.activeModeId() === mode().id ? 'Deactivate' : 'Activate'}
                    </button>
                    <button class="mini-button" onClick={() => toggleEditor(mode().id)} type="button">
                      {editingModeId() === mode().id ? 'Close' : 'Edit'}
                    </button>
                    <button class="mini-button danger" onClick={() => props.onDeleteMode(mode().id)} type="button">
                      Delete
                    </button>
                  </div>
                </div>

                <Show when={editingModeId() === mode().id}>
                  <div class="mode-editor">
                    <div class="mode-field">
                      <span>Name</span>
                      <input
                        class="mode-name-input"
                        value={mode().name}
                        onInput={(e) => props.onUpdateMode(mode().id, 'name', e.currentTarget.value)}
                        placeholder="Mode name"
                      />
                    </div>
                    <div class="mode-field">
                      <span>System Prompt</span>
                      <textarea
                        rows={3}
                        value={mode().system_prompt}
                        onInput={(e) => props.onUpdateMode(mode().id, 'system_prompt', e.currentTarget.value)}
                        placeholder="Instructions for the LLM..."
                      />
                    </div>
                    <div class="mode-field">
                      <span>Model</span>
                      <Show
                        when={props.settings().provider !== 'custom'}
                        fallback={
                          <input
                            value={mode().model}
                            onInput={(e) => props.onUpdateMode(mode().id, 'model', e.currentTarget.value)}
                            placeholder="model-name"
                          />
                        }
                      >
                        <Show when={!props.modelsLoading()} fallback={<div class="muted">Loading models...</div>}>
                          <Show
                            when={props.modelsList().length > 0}
                            fallback={<div class="muted">No models available for this provider.</div>}
                          >
                            <select
                              value={mode().model}
                              onChange={(e) => props.onUpdateMode(mode().id, 'model', e.currentTarget.value)}
                            >
                              <For each={props.modelsList()}>{(m) => <option value={m}>{m}</option>}</For>
                            </select>
                          </Show>
                        </Show>
                      </Show>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </Index>
        </div>
      </Show>

      <button
        class="button ghost wide"
        onClick={props.onAddMode}
        type="button"
      >
        + Add mode
      </button>

      <button
        class="button primary wide"
        onClick={props.onSave}
        disabled={props.saving()}
        type="button"
      >
        {props.saving() ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
