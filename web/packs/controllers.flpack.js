// FL LUA Controller Scripts: small MIDI scripts for hardware controllers (see docs/PACKS.md, "Controller scripts").
// Turn them on in TOOLS > MIDI settings. Each one sees the messages of the devices it matches before FL LUA does
// and returns true for the ones it used.
//   Knobs to the selected channel   CC 21–28 and CC 70–77 (the knob banks of most small keyboards) move the
//                                   selected channel's first eight parameters
//   Faders to the mixer             CC 7 (volume) on MIDI channels 1–16 moves mixer inserts 1–16; on channel 16 the master
//   Pads play drums                 notes on MIDI channel 10 always go to the first drum channel (FPC, Drum synth),
//                                   whichever channel is selected
globalThis.__flluaRegisterPack({
  id: 'fllua-controllers',
  name: 'FL LUA Controller Scripts',
  version: '1.0.0',
  author: 'FL LUA',
  license: 'MIT',
  description: 'MIDI controller scripts: knobs to the selected channel, faders to the mixer, pads that always play the drums.',
  api: 1,
  plugins() {
    const KNOBS = [21, 22, 23, 24, 25, 26, 27, 28, 70, 71, 72, 73, 74, 75, 76, 77];
    return {
      controllers: {
        knobs: {
          meta: { name: 'Knobs to the selected channel', description: 'CC 21–28 / 70–77 move the selected channel\'s first eight parameters' },
          ports: [],
          create(api) {
            return {
              onMidi(m) {
                if ((m[0] >> 4) !== 11) return false;
                const i = KNOBS.indexOf(m[1]);
                if (i < 0) return false;
                const list = api.channelParams();
                const addr = list[i % 8];
                if (!addr) return false;
                api.setParam(addr, m[2] / 127);
                return true;
              },
            };
          },
        },
        faders: {
          meta: { name: 'Faders to the mixer', description: 'CC 7 on MIDI channel n moves mixer insert n (channel 16: the master)' },
          ports: [],
          create(api) {
            return {
              onMidi(m) {
                if ((m[0] >> 4) !== 11 || m[1] !== 7) return false;
                const ch = m[0] & 15;
                api.mixerVolume(ch === 15 ? 0 : ch + 1, m[2] / 127);
                return true;
              },
            };
          },
        },
        pads: {
          meta: { name: 'Pads play drums', description: 'Notes on MIDI channel 10 go to the first FPC or Drum synth channel' },
          ports: [],
          create(api) {
            const drum = () => { const c = api.channels().find((x) => x.type === 'fpc' || x.type === 'drums'); return c ? c.id : null; };
            return {
              onMidi(m) {
                const type = m[0] >> 4;
                if ((m[0] & 15) !== 9 || (type !== 9 && type !== 8)) return false;
                const ch = drum();
                if (ch == null) return false;
                if (type === 9 && m[2] > 0) api.noteOn(m[1], m[2], ch); else api.noteOff(m[1], ch);
                return true;
              },
            };
          },
        },
      },
    };
  },
});
