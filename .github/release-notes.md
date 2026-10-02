# FL LUA

Цифровая звуковая станция с паттерновым процессом (Channel Rack → Piano Roll → Playlist → Mixer). **Отдельное приложение со своим окном: браузер и установка не нужны.**

## Скачать

| Система | Файл |
|---|---|
| **Windows** | **`FL-LUA-windows-x64.exe`**: один файл, двойной клик |
| Linux (x64) | `FL-LUA-linux-x64.AppImage`: `chmod +x FL-LUA-linux-x64.AppImage` и запуск (если нет FUSE: `--appimage-extract-and-run`) |
| macOS (Apple Silicon) | `FL-LUA-macos-arm64.zip`: распаковать и открыть `FL LUA.app` |
| плагины | `synths.flpack.js`, `effects.flpack.js` и `catalog.json`: пакеты плагинов отдельными файлами (**Tools → Plugin store → Install from file…**). Они уже есть внутри программы |
| веб-версия | `FL-LUA-web.zip`: тот же сайт для любого статического сервера (нужен современный Chrome, Edge или Firefox) |

Проекты, сэмплы, пресеты, установленные плагины и автосохранения хранятся в профиле приложения (Windows: `%APPDATA%\FL LUA`), **File → Save as…** сохраняет проект файлом `.fllua` или ZIP со сэмплами. Приложение помнит размер и положение окна.

> Файлы **не подписаны**. Windows SmartScreen: «Подробнее» → «Выполнить в любом случае». macOS: правый клик по приложению → «Открыть» (или `xattr -dr com.apple.quarantine "FL LUA.app"`).

## Что внутри

* **Движок**: AudioWorklet, события планируются по номеру сэмпла; тот же код рендерит экспорт офлайн.
* **Channel Rack** со Step Sequencer, **Piano Roll** со всеми инструментами и генераторами нот, **Playlist** до 500 треков (паттерны, аудио, автоматизация, маркеры, Performance mode, аранжировки), **Mixer** на 125 инсертов (10 слотов, маршрутизация, sidechain, PDC).
* **Инструменты**: Sampler, FPC, Slicer, SubSynth, FM (6 операторов), Drum synth, Wavetable, Pluck, Organ. **Эффекты**: 20 штук (EQ, компрессоры, ревербы, дилеи, модуляция, дисторшены, вокодер и др.).
* **Plugin store**: скачиваемые плагины. В комплекте **FL LUA Synths** (Acid Bass, Tri-Osc, Chip, Additive) и **FL LUA Effects** (Soft Clipper, Maximizer, Hyper Chorus, Waveshaper, Overdrive, Delay Bank, Pitcher); свои пакеты и каталоги ставятся из файла или по адресу.
* **Patcher**: модульная среда (узлы, провода, макро-ручки) как генератор и как эффект.
* **Аудиоредактор** в духе Edison: выделение, обработка, любые эффекты, спектрограмма, регионы, запись.
* **Запись** звука со входа на инсерт и нот с MIDI-клавиатуры, автоматизация, LFO/Envelope-контроллеры, MIDI learn, Browser с перетаскиванием.
* **Экспорт**: WAV 16/24/32f, FLAC, OGG (Opus), MP3, MIDI, стемы, дизеринг, хвост. Проект `.fllua`, ZIP, автосохранение, бэкапы, история отмен.

Проект не связан с Image-Line и не использует чужие названия, логотипы и ассеты. Подробности: [документация](https://github.com/gghub433/FL-STUD-LUA/tree/__TAG__/web).
