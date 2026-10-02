# Как написать плагин для FL LUA

Плагин — это ES-модуль в `src/core/instruments/` (генератор) или `src/core/effects/` (эффект) и одна строка в реестре.
Модули чистые (без DOM и Web Audio): один и тот же код работает в AudioWorklet, в офлайн-рендере экспорта и в тестах Node.
Интерфейс (окно с ручками, автоматизация, пресеты, MIDI-привязка) строится по **схеме параметров** автоматически.

## Схема параметров

```js
import { def, bool, choice } from '../schema.js';
export const schema = [
  def('cutoff', 'Cutoff', 20, 20000, 5000, { unit: 'Hz', curve: 'log', group: 'Filter' }),  // group = вкладка окна
  def('drive', 'Drive', 0, 1, 0.2),
  bool('mono', 'Mono', 0),
  choice('shape', 'Shape', ['Sine', 'Saw', 'Square'], 0),
];
export const meta = { id: 'myfx', name: 'My Effect', category: 'Distortion', description: 'One line for the picker' };
```

`curve`: `lin` (по умолчанию), `log` (min > 0), `pow`. Автоматизация и MIDI работают с нормализованным значением 0..1.

## Эффект

```js
class MyFx {
  constructor(sr, host) { this.p = defaults(schema); /* host.tempo, host.tick, host.playing */ }
  setParam(id, v) { this.p[id] = v; }
  reset() {}
  process(L, R, n, ctx) { /* меняет L и R на месте; ctx.scL/scR — sidechain или null */ }
  // latency: число сэмплов задержки (микшер сам выровняет параллельные пути); если latency зависит от параметра,
  // добавьте latencyParams = ['grain'] и обновляйте this.latency в setParam
}
export function create(sr, host) { return new MyFx(sr, host); }
```

Регистрация: `import * as myfx from './myfx.js'` и добавить `myfx` в `EFFECTS` в `effects/index.js`. Тест `effects.test.js`
автоматически проверит схему, отсутствие NaN и тишину на тишине.

## Генератор

```js
class MySynth {
  constructor(sr, host) {}
  get active() { /* есть ли звучащие голоса */ }
  setParam(id, v) {}
  noteOn(ev) {}      // ev: { key, vel 0..1, pan -1..1, rel, fine (центы), slide, len (сэмплы), ... }
  noteOff(key) {}
  allOff() {} chokeAll() {}
  process(L, R, i0, i1) { /* ДОБАВЛЯЕТ звук в L[i0..i1), R[i0..i1) */ }
}
```

Регистрация: `INSTRUMENTS` в `instruments/index.js`. Окно по умолчанию — генерируемое по схеме; свой редактор регистрируется в
`app.editors[type]` (см. `ui/instrument-editors.js`). Фабричные пресеты — `core/presets.js`; тест проверяет, что все ключи существуют и значения в диапазоне.

## Чего избегать в `process`

Выделения памяти (`new`, массивы-литералы, замыкания в цикле по сэмплам), `Math.random()` (используйте `Noise`), блокирующих вычислений
(таблицы строят заранее, например в конструкторе или при смене параметра).

## Patcher: свои узлы

Узлы Patcher описаны в `src/core/patcher/spec.js` (`NODE_TYPES`: порты, схема параметров) и реализованы в `runtime.js` (класс-наследник `RT`, регистрация в `IMPL`).
Минимальный узел управления:

```js
// spec.js
double: { name: 'Double', cat: 'Control', ins: [C('in', 'In')], outs: [C('out', 'Out')], params: [def('amount', 'Amount', 0, 1, 1)], desc: 'Doubles a control signal' },
// runtime.js
class DoubleNode extends RT { process() { this.co.out = clamp(this.ctl('in', 0) * 2 * this.p.amount, 0, 1); } }
// IMPL = { …, double: DoubleNode }
```

Правила: `process(i0, i1)` вызывается на срезе блока; аудио читается из `this.inb[portId]` (`{L, R}` или `undefined`), пишется в `this.outb[portId]`, управляющие значения читаются через `this.ctl(portId, default)` и пишутся в `this.co[portId]`; ноты приходят в `onNote/offNote` и уходят через `emitOn/emitOff`. Входной буфер менять нельзя: он принадлежит другому узлу. Параметры в `this.p` уже учитывают модуляцию; реакция на смену параметра — `onParam(id, v)`.
Любой зарегистрированный генератор или эффект (кроме самого Patcher) доступен как узел автоматически.
