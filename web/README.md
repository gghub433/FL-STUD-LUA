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

**Сборка и поставка**

```bash
npm run build                 # dist/: те же ES-модули, минифицированные esbuild (структура URL сохранена, worklet и worker работают как есть)
node tools/serve.mjs dist     # проверить production-сборку в браузере

cd desktop && npm ci          # настольное приложение: тот же сайт в собственном окне (Electron), браузер не нужен
npm start                     # запустить его из исходников
npm run dist                  # файлы для вашей системы в desktop/out (Windows: установщик и portable .exe, Linux: AppImage и .deb, macOS: zip)
npm run smoke:built -- out/linux-unpacked/fl-lua-desktop   # запустить собранное приложение и проверить, что звук идёт
```

Окно приложения отдаёт файлы из частной схемы `fllua://app/`, поэтому у приложения один постоянный адрес: проекты, сэмплы и плагины сохраняются между запусками. Разрешения на микрофон и MIDI выдаются сами, меню Electron скрыто (у программы своё меню), положение и размер окна запоминаются. Исходный код оболочки ― `desktop/main.js`.
Готовые файлы для всех систем собирает и **проверяет запуском** workflow `.github/workflows/release.yml` (в релизе: установщик `FL-LUA-windows-x64-setup.exe` и portable `FL-LUA-windows-x64.exe`, AppImage и `.deb`, zip для macOS; установщик и `.deb` тоже проверяются установкой и запуском). Файлы не подписаны: Windows SmartScreen покажет предупреждение, на macOS нужен правый клик → «Открыть».

**Обновления** (`desktop/updater.js`, без подписи кода): установщик Windows и AppImage обновляются через electron-updater: скачивают новую версию из GitHub Releases, сверяют sha512 из `latest.yml` / `latest-linux.yml` и ставят её при перезапуске. Portable `.exe`, `.deb` и macOS (неподписанное приложение не может заменить себя) узнают о новой версии через GitHub API и открывают её загрузку. Проверка идёт раз в день (Help → Check for updates…); ничего не скачивается без согласия.

Облегчённый вариант без Electron: `npm run exe` собирает `dist-exe/fl-lua` ― маленький запускатор, который поднимает локальный сервер и открывает **ваш браузер**.

Горячие клавиши: `Space` — play/stop, `F5` Playlist, `F6` Channel Rack, `F7` Piano Roll, `F9` Mixer, `F8` Browser, `Alt+F8` Plugin Picker, `Alt+T` — tap tempo.

## Что внутри

| Область | Возможности |
|---|---|
| Транспорт, Channel Rack | Play/Stop/Pause/Record, Pattern/Song, темп с tap, метроном, count-in, overdub; Step Sequencer до 64 шагов, swing, graph-редактор (pan/vel/pitch/mod), группы и слои |
| Piano Roll | все инструменты (draw, paint, delete, mute, slice, select, zoom, slide, stamp, chord), панели свойств нот, шкалы, Riff machine, Arpeggiator, Strum, Quantize, Chop, Glue, Articulate, Claw machine и др. |
| Playlist | до 500 треков, клипы паттернов / аудио / автоматизации, маркеры, лупы, Performance mode, аранжировки, time-stretch и pitch клипов, фейды |
| Mixer | 125 инсертов + Master, 10 слотов эффектов, произвольная маршрутизация, sidechain, PDC, 3-полосный EQ, анализатор спектра |
| Инструменты | Sampler, FPC, Slicer, SubSynth, FM (6 операторов), Drum synth, Wavetable, Pluck, Organ, **Patcher** |
| Эффекты | 20 штук + **Patcher** (свой эффект из узлов) |
| Автоматизация | клипы автоматизации с кривыми, LFO и Envelope-контроллеры, MIDI learn |
| Browser | дерево, поиск, превью, drag-and-drop, пресеты, шаблоны, бэкапы |
| Запись | аудио со входа на выбранный инсерт (с компенсацией задержки), ноты с MIDI-клавиатуры и экранного пианино |
| Аудиоредактор | выделение, cut/copy/paste, нормализация, фейды, реверс, time-stretch / pitch, ресемплинг, любые эффекты микшера на выделении, регионы, спектрограмма, запись, отправка в проект |
| Экспорт | WAV 16/24/32f, FLAC, OGG (Opus), MP3, MIDI, стемы, дизеринг, хвост; проект `.fllua` и ZIP со сэмплами, автосохранение, история отмен |

## Plugin store: скачиваемые плагины

**Tools → Plugin store…** (также ADD → Get more plugins…, кнопка **Get more…** в Plugin picker). В комплекте два пакета, ставятся в один клик и работают везде, как встроенные плагины:

| Пакет | Что внутри |
|---|---|
| **FL LUA Synths** | Acid Bass (лестничный фильтр, accent, slide), Tri-Osc (3 осциллятора, sync, кольцевая модуляция, FM), Chip (пульс / треугольник / шум, арпеджио), Additive (до 64 парциалов, форманта, морфинг спектров) |
| **FL LUA Effects** | Soft Clipper, Maximizer (3 полосы + look-ahead), Hyper Chorus, Waveshaper (8 кривых), Overdrive, Delay Bank (4 отводки), Pitcher (корректор высоты) |

Свои пакеты: **Install from file…**, **From address…**, **Add catalog…**. Как написать пакет и опубликовать каталог ― [docs/PACKS.md](docs/PACKS.md). Пакет ― это код: ставьте только от тех, кому доверяете.

## Плагины WAM (Web Audio Modules 2.0)

Сторонние инструменты и эффекты открытого веб-стандарта [WAM 2.0](https://www.webaudiomodules.com): **ADD → Instrument plugin → WAM plugin…** (канал) или **WAM plugin…** в списке эффектов слота микшера. Вставьте адрес главного модуля плагина (обычно `…/index.js`); в комплекте два примера (`wam/example-synth`, `wam/example-tremolo`), чтобы попробовать без интернета. Каталог плагинов: [webaudiomodules.com/community](https://www.webaudiomodules.com/community/).

* Окно канала или слота показывает собственный интерфейс плагина (или ползунки его параметров), **Change…** загружает другой, **Reload** — заново.
* Адрес и состояние плагина хранятся в проекте: сохранение, автосохранение, отмена, смена аудиоустройства — плагин возвращается с теми же настройками.
* Звук идёт через движок как у встроенных плагинов (микшер, маршрутизация, PDC); у WAM-эффекта задержка ровно один блок (128 сэмплов) плюс заявленная плагином, микшер её компенсирует. Ноты WAM-инструменту приходят прямо в его процессор, с точностью до сэмпла (на один блок позже встроенных).
* Экспорт, стемы и анализ громкости проекта с WAM-плагинами рендерятся через `OfflineAudioContext` с теми же плагинами (быстрее реального времени).
* До 16 WAM-плагинов одновременно. Плагин с другого сайта должен разрешать загрузку (CORS). Автоматизации параметров WAM-плагинов пока нет. Плагин ― это код: загружайте только из источников, которым доверяете.

## Patcher

Модульная среда как плагин: **Channel Rack → Add → Patcher** (генератор) или слот микшера **→ Patcher** (эффект).
Узлы: Audio In/Out, Note In, Macro (16 ручек с автоматизацией и MIDI), LFO, Envelope, Envelope follower, Random, Math, Map, Volume/Pan, Crossfade, Transpose, Note filter, Chord, Velocity и **любой генератор и эффект** программы.
Тяните от точки справа у узла к точке слева у другого; точки раскрашены по виду сигнала (звук, управление, ноты). Кнопка ⇄ у параметра делает из него вход для модулятора. Фабричные патчи: **Patches ▾**.

## Аудиоредактор

**Tools → Audio editor** (пустой, с записью), **Edit an audio file…**, кнопка **Edit…** у Sampler, пункты контекстных меню клипа и сэмпла в Browser.
`Space` — воспроизведение, `Ctrl+C/X/V`, `Del`, `Ctrl+Z/Y`, колесо — зум, `Shift`+колесо — прокрутка, `Z` — привязка к нулям.

## Плагины

| Генераторы | Эффекты |
|---|---|
| Sampler (SMP/INS/MISC/FUNC), FPC (64 пэда), Slicer, SubSynth, FM (6 операторов), Drum synth, **Wavetable**, **Pluck** (Karplus-Strong), **Organ** (драйбары) | Parametric EQ (7 полос), Compressor (sidechain), Multiband, Limiter, Gate, Reverb, Convolver, Delay, Chorus, Flanger, Phaser, Distortion, Bitcrusher, Filter, Stereo Enhancer, Vocoder, Gross-Beat-подобный Time/Volume manipulator, **Tremolo / Auto-pan**, **Transient Shaper**, **Pitch Shifter**, **Frequency Shifter / Ring mod**, **Tape Saturator** |

Фабричные пресеты есть у всех новых плагинов и у основных старых (меню **Presets ▾** в окне плагина, свои пресеты сохраняются в браузере).
Как написать свой плагин: [docs/PLUGINS.md](docs/PLUGINS.md). Архитектура: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Логотип

Знак: буква **L** и полумесяц (lua — «луна» по-португальски), три огонька в основании — как шаги секвенсора.
Рисунок оригинальный, исходник — `assets/icon.svg` (PNG-версии: `node tools/make-icons.mjs`). Проект не связан с Image-Line и не использует их название, логотип или графику.
