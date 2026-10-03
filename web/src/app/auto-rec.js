// Records knob moves as automation while the transport records in Song mode (OPTIONS > Recording: Automation).
// Each moved parameter is "touched" in the engine, so its existing automation stops fighting the hand; on Stop the
// takes become automation clips (or replace the curve inside a clip that already covers them), one undo step.
import { paramDef, paramLabel } from '../core/addr.js';
import { toNorm } from '../core/schema.js';
import { applyRecordedAutomation } from '../core/auto-record.js';

export function installAutomationRecording(app) {
  const store = app.store, host = app.host;
  let takes = null, warned = false;

  store.bus.on('user-param', (addr, v, prev) => {
    const st = host.st;
    if (!st.recording || !st.playing || store.project.settings.recAuto === 0) return;
    if (app.transport.mode !== 'song') {
      if (!warned) { warned = true; app.toast('Automation is recorded in SONG mode. Switch to SONG and record again'); }
      return;
    }
    const tick = app.transport.displayTick();
    const def = paramDef(store.project, addr);
    if (tick < 0 || !def) return;                                   // count-in
    if (!takes) takes = new Map();
    let take = takes.get(addr);
    if (!take) {
      take = { start: toNorm(def, prev ?? v), segments: [[]] };
      takes.set(addr, take);
      host.send({ t: 'touch', addr, on: 1 });
    }
    let seg = take.segments[take.segments.length - 1];
    if (seg.length && tick < seg[seg.length - 1].t - 1) { seg = []; take.segments.push(seg); }   // the loop wrapped: a new pass
    seg.push({ t: tick, v: toNorm(def, v) });
  });

  const rec = app.autoRec = {
    get active() { return !!takes; },
    finish() {
      warned = false;
      if (!takes) return null;
      const all = takes; takes = null;
      for (const addr of all.keys()) host.send({ t: 'touch', addr, on: 0 });
      const names = [];
      store.edit('Record automation', (p) => {
        for (const [addr, take] of all) {
          let made = null;
          for (const seg of take.segments) if (seg.length) made = applyRecordedAutomation(p, addr, seg, { startValue: take.start }) || made;
          if (made) names.push(paramLabel(p, addr));
        }
      }, [['channels'], ['playlist']]);
      if (names.length) app.toast(`Recorded automation: ${names.join(', ')}`);
      return names;
    },
  };
  host.bus.on('ended', () => rec.finish());
  return rec;
}
