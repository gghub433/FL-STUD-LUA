<p align="center"><img src="assets/logo.svg" alt="FL LUA" width="380"></p>

# FL LUA

Веб-DAW с паттерновым воркфлоу (Channel Rack → Piano Roll → Playlist → Mixer). Чистый JavaScript, без фреймворков и сборки;
звук считает **AudioWorklet**, события планируются по номеру сэмпла, а не таймерами. Тёмная тема и все графические элементы собственные.

```bash
cd web
node tools/serve.mjs          # http://localhost:8080/
npm test                      # unit-тесты движка, эффектов и инструментов (node:test)
node tests/e2e/run.mjs        # E2E в настоящем Chromium: клики + проверка, что AudioWorklet выдаёт звук
```

Горячие клавиши: `Space` — play/stop, `F5` Playlist, `F6` Channel Rack, `F7` Piano Roll, `F9` Mixer, `F8` Browser, `Alt+F8` Plugin Picker, `Alt+T` — tap tempo.

## Плагины

| Генераторы | Эффекты |
|---|---|
| Sampler (SMP/INS/MISC/FUNC), FPC (64 пэда), Slicer, SubSynth, FM (6 операторов), Drum synth, **Wavetable**, **Pluck** (Karplus-Strong), **Organ** (драйбары) | Parametric EQ (7 полос), Compressor (sidechain), Multiband, Limiter, Gate, Reverb, Convolver, Delay, Chorus, Flanger, Phaser, Distortion, Bitcrusher, Filter, Stereo Enhancer, Vocoder, Gross-Beat-подобный Time/Volume manipulator, **Tremolo / Auto-pan**, **Transient Shaper**, **Pitch Shifter**, **Frequency Shifter / Ring mod**, **Tape Saturator** |

Фабричные пресеты есть у всех новых плагинов и у основных старых (меню **Presets ▾** в окне плагина, свои пресеты сохраняются в браузере).
Как написать свой плагин: [docs/PLUGINS.md](docs/PLUGINS.md). Архитектура: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Логотип

Знак: буква **L** и полумесяц (lua — «луна» по-португальски), три огонька в основании — как шаги секвенсора.
Рисунок оригинальный, исходник — `assets/icon.svg` (PNG-версии: `node tools/make-icons.mjs`). Проект не связан с Image-Line и не использует их название, логотип или графику.
