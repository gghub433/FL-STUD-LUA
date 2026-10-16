// Ties the AudioRecorder to the transport: pressing Record with an armed mixer track also records the input;
// stopping turns the take into an audio channel (routed to that track) and a playlist clip. Recording while the
// song loops gives one clip over the loop region with a take per pass (core/playlist-ops.js loopPasses).
import { AudioRecorder } from '../host/recorder.js';
import { PPQ } from '../core/constants.js';
import { nextId, createChannel, currentArrangement } from '../core/project.js';
import { TimeMap } from '../core/timemap.js';
import { freeTrack, loopPasses, sortClips } from '../core/playlist-ops.js';

export function installAudioRecording(app) {
  const rec = new AudioRecorder(app.host);
  app.host.bus.on('restarted', () => { rec.ready = null; });           // the recorder module belongs to the old context
  let session = null;
  const armed = () => { const t = app.store.project.mixer.tracks; for (let n = 1; n < t.length; n++) if (t[n].arm) return n; return 0; };

  app.audioRec = {
    recorder: rec,
    get recording() { return !!session; },
    async devices() { return rec.devices(); },
    // called by the transport when recording starts; startTick = song position where the clip will sit
    async begin(startTick) {
      const track = armed();
      if (!track || session) return false;
      const dev = (await rec.devices())[app.store.project.mixer.tracks[track].input - 1];
      try {
        await rec.start({ deviceId: dev ? dev.id : null });
      } catch (err) {
        app.toast(err && err.name === 'NotAllowedError' ? 'Microphone permission was denied' : `Could not open the audio input: ${err.message || err}`);
        return false;
      }
      const p = app.store.project, arr = app.store.arrangement, song = app.transport.mode === 'song';
      const st = Math.max(0, Math.round(startTick));
      // the count-in is recorded too: the song position `st` is that far into the recording
      const lead = p.settings.countIn ? new TimeMap(p.timeSig, song ? arr.markers : []).barLenAt(st) : 0;
      session = { track, startTick: st, lead, loop: song && arr.loop ? { ...arr.loop } : null, tempo: p.tempo, wall: performance.now() };
      app.store.bus.emit('audio-rec', { on: true, track });
      return true;
    },
    // called when the transport stops; resolves to the created clip (or null)
    async end() {
      if (!session) return null;
      const s = session; session = null;
      const take = await rec.stop();
      app.store.bus.emit('audio-rec', { on: false, track: s.track });
      if (!take || !take.channels[0].length) return null;
      const n = take.channels[0].length;
      const mono = take.channels.length === 1 || take.channels[1].every((v, i) => v === take.channels[0][i]);
      let channels = mono ? [take.channels[0]] : take.channels;
      const sec2tick = (sec) => Math.round(sec * (s.tempo / 60) * PPQ);
      const trim = sec2tick(take.latency);                              // drop the input latency so the take lines up
      const loop = s.loop && loopPasses({ start: s.startTick, lead: s.lead, trim, total: (n / take.rate) * (s.tempo / 60) * PPQ, ls: s.loop.s, le: s.loop.e });
      if (loop && loop.pad) {                                           // the first pass began inside the loop: silence before it
        const pad = Math.round(((loop.pad * 60) / (s.tempo * PPQ)) * take.rate);
        channels = channels.map((c) => { const x = new Float32Array(c.length + pad); x.set(c, pad); return x; });
      }
      const entry = app.bank.addPCM(`Recording ${new Date().toLocaleTimeString()}`, take.rate, channels);
      await app.library.save('recorded', entry.name, { id: entry.id });
      if (loop) return loopTakes(app, s, entry, loop);
      const ch = app.cmd.addAudioChannel(app.store, { id: entry.id, name: entry.name });
      app.cmd.setMixerTarget(app.store, ch.id, s.track);
      const len = Math.max(1, sec2tick(n / take.rate) - trim - s.lead);
      const made = app.cmd.addClips(app.store, [{ type: 'audio', track: freeTrack(app.store.arrangement.clips, s.startTick, len), s: s.startTick, l: len, ref: ch.id, o: trim + s.lead }], 'Record audio');
      app.toast(`Recorded ${(n / take.rate).toFixed(1)} s onto insert ${s.track}`);
      return made[0];
    },
  };
}

// Loop recording: one clip over the loop region with a take per pass; the newest plays, the others wait in the
// clip's Takes menu. All passes are one recording, so the takes differ only in where the clip looks into it
// (take.t = recording seconds at the loop start). Channel and clip are one undo step.
function loopTakes(app, s, entry, loop) {
  const tick2sec = 60 / (s.tempo * PPQ), L = s.loop.e - s.loop.s;
  const clip = app.store.edit('Record audio', (p) => {
    const ch = createChannel(p, 'audio', { name: entry.name, sample: { id: entry.id, name: entry.name }, mixer: s.track });
    p.channels.push(ch);
    const arr = currentArrangement(p);
    const takes = loop.passes.map((o) => ({ id: nextId(p), t: Math.round(o * tick2sec * 1e6) / 1e6 }));
    const c = { id: nextId(p), type: 'audio', track: freeTrack(arr.clips, s.loop.s, L), s: s.loop.s, l: L, ref: ch.id, o: loop.passes[takes.length - 1], mute: 0, takes, take: takes[takes.length - 1].id };
    arr.clips.push(c);
    sortClips(arr.clips);
    return c;
  }, [['channels'], ['playlist']]);
  app.store.select(clip.ref);
  app.toast(`Recorded ${loop.passes.length} takes onto insert ${s.track}`);
  return clip;
}
