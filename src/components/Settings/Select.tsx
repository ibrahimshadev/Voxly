import { createSignal, For, Show, onCleanup } from 'solid-js';

type SelectOption = {
  value: string;
  label: string;
};

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  class?: string;
};

export default function Select(props: SelectProps) {
  const [open, setOpen] = createSignal(false);
  let triggerRef!: HTMLButtonElement;
  let dropdownRef!: HTMLDivElement;

  const selectedLabel = () =>
    props.options.find((o) => o.value === props.value)?.label ?? props.value;

  const handleClickOutside = (e: MouseEvent) => {
    if (
      !triggerRef.contains(e.target as Node) &&
      !dropdownRef?.contains(e.target as Node)
    ) {
      setOpen(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  };

  const attachListeners = () => {
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  };

  const detachListeners = () => {
    document.removeEventListener('mousedown', handleClickOutside);
    document.removeEventListener('keydown', handleKeyDown);
  };

  onCleanup(detachListeners);

  const toggle = () => {
    const next = !open();
    setOpen(next);
    if (next) attachListeners();
    else detachListeners();
  };

  const select = (value: string) => {
    props.onChange(value);
    setOpen(false);
    detachListeners();
  };

  return (
    <div class="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        class={`w-full text-left bg-input-bg border rounded-lg py-2 text-sm text-gray-300 cursor-pointer transition-colors appearance-none truncate ${
          open() ? 'border-primary ring-1 ring-primary' : 'border-white/15 hover:border-white/20'
        } ${props.class ?? ''}`}
      >
        {selectedLabel()}
      </button>

      <Show when={open()}>
        <div
          ref={dropdownRef}
          class="absolute z-50 mt-1 w-full bg-surface-dark border border-white/10 rounded-lg shadow-2xl overflow-hidden"
        >
          <div class="max-h-48 overflow-y-auto scrollbar-hide py-1">
            <For each={props.options}>
              {(option) => (
                <button
                  type="button"
                  onClick={() => select(option.value)}
                  class={`w-full text-left px-3 py-2 text-sm transition-colors ${
                    option.value === props.value
                      ? 'text-primary bg-primary/10'
                      : 'text-gray-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  {option.label}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
