import { onMount, onCleanup } from 'solid-js';
import SiriWave from 'siriwave';

type SineWavesProps = {
  width?: number;
  height?: number;
  amplitude?: number;
};

export default function SineWaves(props: SineWavesProps) {
  let container: HTMLDivElement | undefined;
  let wave: SiriWave | undefined;

  onMount(() => {
    if (container) {
      wave = new SiriWave({
        container,
        width: props.width ?? 90,
        height: props.height ?? 35,
        style: 'ios9',
        speed: 0.06,
        amplitude: props.amplitude ?? 4,
        autostart: true,
      });
    }
  });

  onCleanup(() => {
    wave?.dispose();
  });

  return <div ref={container} class="sine-waves-container" />;
}
