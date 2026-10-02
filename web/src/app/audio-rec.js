// Ties the AudioRecorder to the transport: pressing Record with an armed mixer track also records the input;
// stopping turns the take into an audio channel (routed to that track) and a playlist clip.
import { AudioRecorder } from '../host/recorder.js';
import { PPQ } from '../core/constants.js';

export function installAudioRecording(app) {
  const rec = new AudioRecorder(app.host);
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
      session = { track, startTick: Math.max(0, Math.round(startTick)), tempo: app.store.project.tempo, wall: performance.now() };
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
      const entry = app.bank.addPCM(`Recording ${new Date().toLocaleTimeString()}`, take.rate, mono ? [take.channels[0]] : take.channels);
      await app.library.save('recorded', entry.name, { id: entry.id });
      const sec2tick = (sec) => Math.round(sec * (s.tempo / 60) * PPQ);
      const ch = app.cmd.addAudioChannel(app.store, { id: entry.id, name: entry.name });
      app.cmd.setMixerTarget(app.store, ch.id, s.track);
      const trim = sec2tick(take.latency);                              // drop the input latency so the take lines up
      const len = Math.max(1, sec2tick(n / take.rate) - trim);
      const made = app.cmd.addClips(app.store, [{ type: 'audio', track: freeTrack(app, s.startTick, len), s: s.startTick, l: len, ref: ch.id, o: trim }], 'Record audio');
      app.toast(`Recorded ${(n / take.rate).toFixed(1)} s onto insert ${s.track}`);
      return made[0];
    },
  };
}

function freeTrack(app, s, l) {
  const arr = app.store.arrangement;
  for (let t = 1; t <= 500; t++) if (!arr.clips.some((c) => c.track === t && c.s < s + l && c.s + c.l > s)) return t;
  return 500;
}
