-- Instrument definitions. Drums are synthesized once into sample buffers;
-- melodic instruments are rendered in real time by the engine (see engine.lua).
-- Everything is generated from code, so the app ships without sample files.
local S = {}

local SR = 44100
S.SR = SR

local sin, exp, abs, floor, pi = math.sin, math.exp, math.abs, math.floor, math.pi
local TWO_PI = 2 * pi

-- Deterministic noise (Park-Miller) so every build sounds identical.
local seed = 1
local function rnd()
  seed = (seed * 16807) % 2147483647
  return seed / 1073741823.5 - 1
end

local function tanh(x)
  if x > 20 then return 1 elseif x < -20 then return -1 end
  local e = exp(2 * x)
  return (e - 1) / (e + 1)
end
S.tanh = tanh

-- One-pole high-pass filter state helper.
local function hpCoef(fc)
  return 1 / (1 + TWO_PI * fc / SR)
end

-- Normalize, fade the tail and append a guard sample for interpolation.
local function finish(buf, n)
  local peak = 0
  for i = 1, n do
    local a = abs(buf[i])
    if a > peak then peak = a end
  end
  local g = peak > 0 and 0.9 / peak or 1
  local fade = math.min(n, floor(0.004 * SR))
  for i = 1, n do
    local v = buf[i] * g
    local fromEnd = n - i
    if fromEnd < fade then v = v * fromEnd / fade end
    buf[i] = v
  end
  buf[n + 1] = 0
  return { data = buf, len = n }
end

local gen = {}

function gen.kick()
  seed = 101
  local n = floor(0.5 * SR)
  local b, ph = {}, 0
  for i = 1, n do
    local t = (i - 1) / SR
    local f = 48 + 125 * exp(-t * 30)
    ph = ph + f / SR
    local s = sin(TWO_PI * ph) * exp(-t * 5.5)
    if t < 0.004 then s = s + rnd() * 0.3 * (1 - t / 0.004) end
    b[i] = tanh(s * 1.8)
  end
  return finish(b, n)
end

function gen.snare()
  seed = 202
  local n = floor(0.32 * SR)
  local b, lp = {}, 0
  for i = 1, n do
    local t = (i - 1) / SR
    local tone = sin(TWO_PI * 185 * t) * exp(-t * 20) * 0.55
               + sin(TWO_PI * 330 * t) * exp(-t * 28) * 0.25
    local w = rnd()
    lp = lp + 0.35 * (w - lp)
    local noise = ((w - lp) * 0.8 + lp * 0.4) * exp(-t * 13)
    b[i] = tone + noise * 0.75
  end
  return finish(b, n)
end

function gen.clap()
  seed = 303
  local n = floor(0.4 * SR)
  local b = {}
  local f = 2 * sin(pi * 1200 / SR)
  local q = 0.6
  local low, band = 0, 0
  for i = 1, n do
    local t = (i - 1) / SR
    local env = 0
    for k = 0, 2 do
      local tk = k * 0.011
      if t >= tk then
        local e = exp(-(t - tk) * 200)
        if e > env then env = e end
      end
    end
    if t >= 0.03 then
      local e = 0.7 * exp(-(t - 0.03) * 14)
      if e > env then env = e end
    end
    local x = rnd() * env
    low = low + f * band
    local high = x - low - q * band
    band = band + f * high
    b[i] = band * 1.5 + high * 0.3
  end
  return finish(b, n)
end

local function hat(dur, decay, sd)
  seed = sd
  local n = floor(dur * SR)
  local b = {}
  local freqs = { 205.3, 304.4, 369.6, 522.7, 540.0, 800.0 }
  local phs = { 0, 0, 0, 0, 0, 0 }
  local a = hpCoef(6500)
  local x1, y1, x2, y2 = 0, 0, 0, 0
  for i = 1, n do
    local t = (i - 1) / SR
    local m = 0
    for k = 1, 6 do
      phs[k] = (phs[k] + freqs[k] * 1.7 / SR) % 1
      m = m + (phs[k] < 0.5 and 1 or -1)
    end
    local x = m / 6 * 0.6 + rnd() * 0.7
    -- two cascaded one-pole high-pass filters
    local h1 = a * (y1 + x - x1); x1 = x; y1 = h1
    local h2 = a * (y2 + h1 - x2); x2 = h1; y2 = h2
    local env = exp(-t * decay)
    if t < 0.002 then env = env * t / 0.002 end
    b[i] = h2 * env
  end
  return finish(b, n)
end

function gen.hat() return hat(0.12, 45, 404) end
function gen.ohat() return hat(0.6, 6.5, 505) end

function gen.tom()
  seed = 606
  local n = floor(0.45 * SR)
  local b, ph = {}, 0
  for i = 1, n do
    local t = (i - 1) / SR
    ph = ph + (95 + 80 * exp(-t * 18)) / SR
    local s = sin(TWO_PI * ph) * exp(-t * 8)
    if t < 0.003 then s = s + rnd() * 0.2 end
    b[i] = s
  end
  return finish(b, n)
end

function gen.rim()
  seed = 707
  local n = floor(0.07 * SR)
  local b = {}
  for i = 1, n do
    local t = (i - 1) / SR
    b[i] = (sin(TWO_PI * 1700 * t) * 0.6 + sin(TWO_PI * 820 * t) * 0.4) * exp(-t * 90)
         + rnd() * exp(-t * 300) * 0.3
  end
  return finish(b, n)
end

function gen.shaker()
  seed = 808
  local n = floor(0.16 * SR)
  local b = {}
  local a = hpCoef(5000)
  local x1, y1 = 0, 0
  for i = 1, n do
    local t = (i - 1) / SR
    local x = rnd()
    local h = a * (y1 + x - x1); x1 = x; y1 = h
    local env = t < 0.02 and t / 0.02 or exp(-(t - 0.02) * 30)
    b[i] = h * env
  end
  return finish(b, n)
end

-- kind = "sample": one-shot synthesized sample (pitch = playback rate).
-- kind = "synth" : real-time voice; see engine.lua for parameter meaning.
S.defs = {
  kick   = { label = "Kick",     kind = "sample", root = 60 },
  snare  = { label = "Snare",    kind = "sample", root = 60 },
  clap   = { label = "Clap",     kind = "sample", root = 60 },
  hat    = { label = "Hat",      kind = "sample", root = 60, choke = 1 },
  ohat   = { label = "Open Hat", kind = "sample", root = 60, choke = 1 },
  tom    = { label = "Tom",      kind = "sample", root = 60 },
  rim    = { label = "Rim",      kind = "sample", root = 60 },
  shaker = { label = "Shaker",   kind = "sample", root = 60 },
  bass   = { label = "Bass",  kind = "synth", osc = "saw", sub = 0.45, cutoff = 260, envAmt = 2200,
             res = 0.35, fdecay = 0.16, a = 0.003, d = 0.3, s = 0.55, r = 0.06, gain = 0.5, root = 36 },
  sub808 = { label = "808",   kind = "synth", osc = "sine", glide = 1.0, pdecay = 0.05, drive = 1.8,
             a = 0.001, d = 2.4, s = 0.0, r = 0.08, gain = 0.8, root = 36 },
  pluck  = { label = "Pluck", kind = "synth", osc = "supersaw", detune = 0.12, cutoff = 700, envAmt = 5200,
             res = 0.2, fdecay = 0.14, a = 0.001, d = 0.4, s = 0.0, r = 0.15, gain = 1.0, root = 60 },
  lead   = { label = "Lead",  kind = "synth", osc = "square", cutoff = 1800, envAmt = 2500,
             res = 0.3, fdecay = 0.25, a = 0.004, d = 0.25, s = 0.7, r = 0.1, gain = 0.5, root = 72 },
  keys   = { label = "Keys",  kind = "synth", osc = "fm", ratio = 1.0, index = 3.0, idecay = 0.6,
             a = 0.002, d = 1.5, s = 0.2, r = 0.3, gain = 0.6, root = 60 },
  pad    = { label = "Pad",   kind = "synth", osc = "supersaw", detune = 0.18, cutoff = 1400, envAmt = 400,
             res = 0.1, fdecay = 1.0, a = 0.35, d = 0.8, s = 0.8, r = 0.9, gain = 0.45, root = 60 },
}

-- Order used by the "Add channel" menu.
S.order = { "kick", "snare", "clap", "hat", "ohat", "tom", "rim", "shaker",
            "bass", "sub808", "pluck", "lead", "keys", "pad" }

local cache = {}

function S.sample(name)
  local c = cache[name]
  if not c then
    c = gen[name]()
    cache[name] = c
  end
  return c
end

-- Build every drum sample up front so the first hit never stalls the audio.
function S.preload()
  for name, def in pairs(S.defs) do
    if def.kind == "sample" then S.sample(name) end
  end
end

return S
