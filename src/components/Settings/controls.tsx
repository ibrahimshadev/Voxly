import { For, createSignal } from 'solid-js';
import type { JSX, Setter } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Eye, EyeOff } from 'lucide-solid';
import type { Settings } from '../../types';

type TextSetting = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings];

/** `onInput` handler factory: `field('api_key')` writes the input's text into that setting. */
export const settingsFieldSetter = (setSettings: Setter<Settings>) => (key: TextSetting) => (event: Event) => {
  const value = (event.target as HTMLInputElement).value;
  setSettings((current) => ({ ...current, [key]: value }));
};

type Option<T> = { value: T; label: string };

/** Native select styled like the text inputs. A value missing from `options` is still shown. */
export function Select(props: {
  value: string;
  options: Option<string>[];
  onChange: (value: string) => void;
  class?: string;
}) {
  const options = () =>
    props.options.some((option) => option.value === props.value)
      ? props.options
      : [{ value: props.value, label: props.value }, ...props.options];
  return (
    <select
      onChange={(event) => props.onChange(event.currentTarget.value)}
      class={`w-full bg-input-bg border border-white/15 rounded-lg py-2 text-sm text-gray-300 cursor-pointer transition-colors appearance-none truncate hover:border-white/20 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary ${props.class ?? ''}`}
    >
      <For each={options()}>
        {(option) => (
          <option value={option.value} selected={option.value === props.value}>
            {option.label}
          </option>
        )}
      </For>
    </select>
  );
}

/** Pill-style segmented control. */
export function Segmented<T>(props: { value: T; options: Option<T>[]; onChange: (value: T) => void }) {
  return (
    <div class="flex bg-input-bg p-1 rounded-lg border border-white/15">
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            onClick={() => props.onChange(option.value)}
            class={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              props.value === option.value
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}

/**
 * Password field with a show/hide toggle. With a leading `icon` it uses the roomier
 * Settings-form layout; without one, the compact layout of the meeting forms.
 */
export function SecretInput(props: {
  value: string;
  onInput: (event: Event) => void;
  onBlur?: () => void;
  placeholder: string;
  icon?: JSX.Element;
  class?: string;
}) {
  const [visible, setVisible] = createSignal(false);
  const iconSize = () => (props.icon ? 24 : 15);
  return (
    <div class={`relative ${props.class ?? ''}`}>
      {props.icon}
      <input
        type={visible() ? 'text' : 'password'}
        value={props.value}
        onInput={props.onInput}
        onBlur={() => props.onBlur?.()}
        placeholder={props.placeholder}
        class={`w-full bg-input-bg border border-white/15 rounded-lg pr-10 text-sm font-mono text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700 ${
          props.icon ? 'py-2 pl-10' : 'py-1.5 pl-3'
        }`}
      />
      <button
        type="button"
        onClick={() => setVisible((value) => !value)}
        class={`absolute top-1/2 -translate-y-1/2 hover:text-gray-300 transition-colors cursor-pointer ${
          props.icon
            ? 'right-2 flex items-center justify-center w-7 h-7 text-gray-500 rounded hover:bg-white/5'
            : 'right-2.5 text-gray-600'
        }`}
        title={visible() ? 'Hide key' : 'Show key'}
      >
        {visible() ? <EyeOff size={iconSize()} /> : <Eye size={iconSize()} />}
      </button>
    </div>
  );
}

/** Toggle-switch track and knob; pass `onToggle` to make it a button of its own. */
export function SwitchKnob(props: { on: boolean; onToggle?: () => void; title?: string }) {
  return (
    <Dynamic
      component={props.onToggle ? 'button' : 'span'}
      type={props.onToggle ? 'button' : undefined}
      onClick={props.onToggle}
      title={props.title}
      class={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        props.onToggle ? 'cursor-pointer' : ''
      } ${props.on ? 'bg-primary' : 'bg-white/10'}`}
    >
      <span
        class={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          props.on ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </Dynamic>
  );
}
