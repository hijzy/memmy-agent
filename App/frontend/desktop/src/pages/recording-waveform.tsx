const IDLE_LEVELS = [
  .08, .18, .3, .15, .42, .56, .28, .66, .4, .78,
  .46, .94, .58, .8, .44, .7, .96, .52, .82, .6,
  .92, .48, .72, .38, .62, .26, .5, .32, .18, .1
];

/** Idle is a static illustration; recording and pause retain actual mic levels. */
export function RecordingWaveform(props: { levels: number[]; active: boolean; idle: boolean }) {
  const samples = props.levels.slice(-40);
  const levels = props.idle ? IDLE_LEVELS : [...Array<number>(40 - samples.length).fill(0), ...samples];
  return <div className={`recording-waveform${props.active ? " recording-waveform--active" : ""}${props.idle ? " recording-waveform--idle" : ""}`} aria-hidden="true">
    {levels.map((level, index) => <span key={index} className="recording-waveform__bar"
      style={{ height: `${Math.round(8 + Math.min(1, Math.max(0, level)) * 92)}%` }} />)}
  </div>;
}
