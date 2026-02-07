import { Show, Switch, Match } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { Motion, Presence } from 'solid-motionone';
import type { Tab, Settings, Mode, VocabularyEntry, TranscriptionHistoryItem } from '../../types';
import { APP_NAME } from '../../branding';
import SettingsTab from './SettingsTab';
import VocabularyTab from './VocabularyTab';
import HistoryTab from './HistoryTab';
import ModesTab from './ModesTab';

type SettingsPanelProps = {
  visible: Accessor<boolean>;
  activeTab: Accessor<Tab>;
  settings: Accessor<Settings>;
  setSettings: Setter<Settings>;
  testMessage: Accessor<string>;
  vocabularyMessage: Accessor<string>;
  saving: Accessor<boolean>;
  isVocabularyEditorOpen: Accessor<boolean>;
  editorWord: Accessor<string>;
  setEditorWord: Setter<string>;
  editorReplacements: Accessor<string>;
  setEditorReplacements: Setter<string>;
  onCollapse: () => void;
  onTabChange: (tab: Tab) => void;
  onTest: () => void;
  onSave: () => void;
  onVocabularyOpenCreate: () => void;
  onVocabularyEdit: (entry: VocabularyEntry) => void;
  onVocabularySave: () => void;
  onVocabularyCancel: () => void;
  onVocabularyToggleEnabled: (id: string) => void;
  onVocabularyDelete: (id: string) => void;
  history: Accessor<TranscriptionHistoryItem[]>;
  historyMessage: Accessor<string>;
  onHistoryCopy: (text: string) => void;
  onHistoryDelete: (id: string) => void;
  onHistoryClearAll: () => void;
  modelsList: Accessor<string[]>;
  modelsLoading: Accessor<boolean>;
  modelsError: Accessor<string>;
  onUpdateMode: (id: string, field: keyof Mode, value: string) => void;
  onSetActiveModeId: (id: string | null) => void;
  onAddMode: () => void;
  onDeleteMode: (id: string) => void;
  ref?: (el: HTMLDivElement) => void;
};

export default function SettingsPanel(props: SettingsPanelProps) {
  return (
    <Presence>
      <Show when={props.visible()}>
        <Motion.div
          ref={props.ref}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18, easing: 'ease-out' }}
          class="settings-panel visible"
        >
          {/* Header */}
          <header class="settings-header">
            <span class="settings-title">{APP_NAME}</span>
            <button class="collapse-button" onClick={props.onCollapse} title="Collapse">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </header>

          {/* Tab Row */}
          <div class="tab-row">
            <button
              class="tab-button"
              classList={{ active: props.activeTab() === 'settings' }}
              onClick={() => props.onTabChange('settings')}
              type="button"
            >
              Settings
            </button>
            <button
              class="tab-button"
              classList={{ active: props.activeTab() === 'vocabulary' }}
              onClick={() => props.onTabChange('vocabulary')}
              type="button"
            >
              Vocabulary
            </button>
            <button
              class="tab-button"
              classList={{ active: props.activeTab() === 'history' }}
              onClick={() => props.onTabChange('history')}
              type="button"
            >
              History
            </button>
            <button
              class="tab-button"
              classList={{ active: props.activeTab() === 'modes' }}
              onClick={() => props.onTabChange('modes')}
              type="button"
            >
              Modes
            </button>
          </div>

          {/* Animated Tab Content */}
          <div class="settings-body">
            <Presence exitBeforeEnter>
              <Switch>
                <Match when={props.activeTab() === 'settings'}>
                  <Motion.div
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    class="settings-tab-pane"
                  >
                    <SettingsTab
                      settings={props.settings}
                      setSettings={props.setSettings}
                      testMessage={props.testMessage}
                      saving={props.saving}
                      onTest={props.onTest}
                      onSave={props.onSave}
                    />
                  </Motion.div>
                </Match>
                <Match when={props.activeTab() === 'vocabulary'}>
                  <Motion.div
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.15 }}
                    class="settings-tab-pane"
                  >
                    <VocabularyTab
                      vocabulary={props.settings().vocabulary}
                      message={props.vocabularyMessage}
                      isEditorOpen={props.isVocabularyEditorOpen}
                      editorWord={props.editorWord}
                      setEditorWord={props.setEditorWord}
                      editorReplacements={props.editorReplacements}
                      setEditorReplacements={props.setEditorReplacements}
                      onOpenCreate={props.onVocabularyOpenCreate}
                      onEdit={props.onVocabularyEdit}
                      onSave={props.onVocabularySave}
                      onCancel={props.onVocabularyCancel}
                      onToggleEnabled={props.onVocabularyToggleEnabled}
                      onDelete={props.onVocabularyDelete}
                    />
                  </Motion.div>
                </Match>
                <Match when={props.activeTab() === 'history'}>
                  <Motion.div
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.15 }}
                    class="settings-tab-pane"
                  >
                    <HistoryTab
                      history={props.history}
                      message={props.historyMessage}
                      onCopy={props.onHistoryCopy}
                      onDelete={props.onHistoryDelete}
                      onClearAll={props.onHistoryClearAll}
                    />
                  </Motion.div>
                </Match>
                <Match when={props.activeTab() === 'modes'}>
                  <Motion.div
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.15 }}
                    class="settings-tab-pane"
                  >
                    <ModesTab
                      settings={props.settings}
                      modes={() => props.settings().modes}
                      activeModeId={() => props.settings().active_mode_id}
                      modelsList={props.modelsList}
                      modelsLoading={props.modelsLoading}
                      modelsError={props.modelsError}
                      saving={props.saving}
                      onUpdateMode={props.onUpdateMode}
                      onSetActiveModeId={props.onSetActiveModeId}
                      onAddMode={props.onAddMode}
                      onDeleteMode={props.onDeleteMode}
                      onSave={props.onSave}
                    />
                  </Motion.div>
                </Match>
              </Switch>
            </Presence>
          </div>
        </Motion.div>
      </Show>
    </Presence>
  );
}
