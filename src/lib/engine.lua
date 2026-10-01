-- Audio engine: sample-accurate step sequencer + voice mixer.
-- The same code drives real-time playback and offline WAV export.
local Sounds = require("lib.sounds")
local Project = require("lib.project")

local E = {}
E.__index = E

local SR = Sounds.SR
local STEPS = Project.STEPS
local MAX_VOICES = 48
local sin, cos, exp, floor, pi = math.sin, math.cos, math.exp, math.floor, math.pi
local TWO_PI = 2 * pi
local FK = TWO_PI / SR
local tanh = Sounds.tanh

E.SR = SR

function E.new(project)
  local e = setmetatable({}, E)
  e.project = project
  e.voices = {}
  e.playing = false
  e.mode = "pattern"
  e.patternIndex = project.current or 1
  e.step = 0
  e.untilNext = 0
  e.frames = 0
  e.L, e.R = {}, {}
  e.log, e.logHead = {}, 0
  e.peakL, e.peakR = 0, 0
  return e
end

function E:framesPerStep()
  return SR * 60 / self.project.bpm / 4
end

----------------------------------------------------------------------------
-- Voices
----------------------------------------------------------------------------
local function panGains(pan)
  local a = (pan + 1) * pi / 4
  return cos(a), sin(a)
end

function E:choke(group)
  for _, v in ipairs(self.voices) do
    if v.sample and v.choke == group and not v.fade then v.fade = 1 end
  end
end

-- gate: note length in frames (synths only), delay: frames before the voice starts
function E:noteOn(ch, pitch, vel, gate, delay)
  local def = Sounds.defs[ch.inst]
  if not def then return end
  local gl, gr = panGains(ch.pan)
  local amp = vel * ch.vol * ch.vol * 1.6
  local v
  if def.kind == "sample" then
    local smp = Sounds.sample(ch.inst)
    if def.choke then self:choke(def.choke) end
    v = {
      sample = true, data = smp.data, len = smp.len, pos = 1,
      rate = 2 ^ ((pitch - def.root + ch.pitch) / 12),
      gl = gl * amp, gr = gr * amp, delay = delay or 0, choke = def.choke,
    }
  else
    local inc = 440 * 2 ^ ((pitch + ch.pitch - 69) / 12) / SR
    local tone = 2 ^ ((ch.tone - 0.5) * 4)
    v = {
      sample = false, osc = def.osc,
      p1 = 0, p2 = 0, p3 = 0, inc1 = inc, inc2 = inc, inc3 = inc,
      env = 0, stage = 1,
      aInc = 1 / math.max(1, def.a * SR),
      dCo = exp(-3 / math.max(1, def.d * SR)),
      sus = def.s,
      rCo = exp(-3 / math.max(1, def.r * SR)),
      gate = math.max(1, floor(gate or SR * 0.3)),
      gl = gl * amp * def.gain, gr = gr * amp * def.gain,
      delay = delay or 0,
      sub = 0, idx = 0, iCo = 1, pe = 0, peCo = 1, drive = 1,
    }
    if def.osc == "saw" then
      v.inc2 = inc * 0.5
      v.sub = def.sub or 0
    elseif def.osc == "supersaw" then
      local d = def.detune or 0.1
      v.inc2, v.inc3 = inc * 2 ^ (d / 12), inc * 2 ^ (-d / 12)
      v.p2, v.p3 = 0.33, 0.67
    elseif def.osc == "fm" then
      v.inc2 = inc * def.ratio
      v.idx = def.index * tone
      v.iCo = exp(-3 / (def.idecay * SR))
    elseif def.osc == "sine" then
      v.pe = def.glide
      v.peCo = exp(-3 / (def.pdecay * SR))
      v.drive = def.drive * tone
    end
    if def.cutoff then
      v.cutoff = def.cutoff * tone
      v.envAmt = def.envAmt * tone
      v.fenv = 1
      v.fCo = exp(-3 / (def.fdecay * SR))
      v.q = 1 - def.res * 0.85
      v.low, v.band = 0, 0
    end
  end
  local vs = self.voices
  vs[#vs + 1] = v
  if #vs > MAX_VOICES then table.remove(vs, 1) end
  return v
end

function E:preview(ch, pitch, vel)
  self:noteOn(ch, pitch or Project.rootPitch(ch), vel or 0.8, SR * 0.3, 0)
end

-- hard = also fade out one-shot samples (used by Stop)
function E:releaseAll(hard)
  for _, v in ipairs(self.voices) do
    if v.sample then
      if hard and not v.fade then v.fade = 1 end
    else
      v.stage = 3
    end
  end
end

local function renderSample(v, L, R, i0, last)
  local data, len, pos, rate = v.data, v.len, v.pos, v.rate
  local gl, gr, fade = v.gl, v.gr, v.fade
  for i = i0, last do
    local ip = floor(pos)
    if ip > len then v.dead = true; break end
    local a = data[ip]
    local s = a + (data[ip + 1] - a) * (pos - ip)
    if fade then
      fade = fade * 0.992
      if fade < 0.0005 then v.dead = true; break end
      s = s * fade
    end
    L[i] = L[i] + s * gl
    R[i] = R[i] + s * gr
    pos = pos + rate
  end
  v.pos, v.fade = pos, fade
end

-- PolyBLEP residual for band-limited saw/square edges.
local function blep(t, dt)
  if t < dt then
    t = t / dt
    return t + t - t * t - 1
  elseif t > 1 - dt then
    t = (t - 1) / dt
    return t * t + t + t + 1
  end
  return 0
end

local function renderSynth(v, L, R, i0, last)
  local osc = v.osc
  local env, stage, gate = v.env, v.stage, v.gate
  local aInc, dCo, sus, rCo = v.aInc, v.dCo, v.sus, v.rCo
  local p1, p2, p3 = v.p1, v.p2, v.p3
  local inc1, inc2, inc3 = v.inc1, v.inc2, v.inc3
  local sub, idx, iCo, pe, peCo, drive = v.sub, v.idx, v.iCo, v.pe, v.peCo, v.drive
  local cutoff, envAmt, fenv, fCo, q, low, band = v.cutoff, v.envAmt, v.fenv, v.fCo, v.q, v.low, v.band
  local gl, gr = v.gl, v.gr
  for i = i0, last do
    if stage == 1 then
      env = env + aInc
      if env >= 1 then env = 1; stage = 2 end
    elseif stage == 2 then
      env = sus + (env - sus) * dCo
      if env < 0.0001 then v.dead = true; break end
    else
      env = env * rCo
      if env < 0.0001 then v.dead = true; break end
    end
    if stage < 3 then
      gate = gate - 1
      if gate <= 0 then stage = 3 end
    end

    local s
    if osc == "saw" then
      p1 = p1 + inc1; if p1 >= 1 then p1 = p1 - 1 end
      p2 = p2 + inc2; if p2 >= 1 then p2 = p2 - 1 end
      s = 2 * p1 - 1 - blep(p1, inc1) + sub * sin(TWO_PI * p2)
    elseif osc == "supersaw" then
      p1 = p1 + inc1; if p1 >= 1 then p1 = p1 - 1 end
      p2 = p2 + inc2; if p2 >= 1 then p2 = p2 - 1 end
      p3 = p3 + inc3; if p3 >= 1 then p3 = p3 - 1 end
      s = (2 * p1 - 1 - blep(p1, inc1)) * 0.5
        + (2 * p2 - 1 - blep(p2, inc2)) * 0.35
        + (2 * p3 - 1 - blep(p3, inc3)) * 0.35
    elseif osc == "square" then
      p1 = p1 + inc1; if p1 >= 1 then p1 = p1 - 1 end
      local ph = p1 + 0.5
      if ph >= 1 then ph = ph - 1 end
      s = ((p1 < 0.5) and 0.8 or -0.8) + 0.8 * (blep(p1, inc1) - blep(ph, inc1))
    elseif osc == "fm" then
      p1 = p1 + inc1; if p1 >= 1 then p1 = p1 - 1 end
      p2 = p2 + inc2; if p2 >= 1 then p2 = p2 - 1 end
      s = sin(TWO_PI * p1 + idx * sin(TWO_PI * p2))
      idx = idx * iCo
    else -- "sine": 808 with pitch drop and saturation
      p1 = p1 + inc1 * (1 + pe); if p1 >= 1 then p1 = p1 - 1 end
      pe = pe * peCo
      s = tanh(sin(TWO_PI * p1) * drive)
    end

    if cutoff then
      local f = (cutoff + envAmt * fenv) * FK
      if f > 0.9 then f = 0.9 end
      fenv = fenv * fCo
      low = low + f * band
      local high = s - low - q * band
      band = band + f * high
      s = low
    end

    s = s * env
    L[i] = L[i] + s * gl
    R[i] = R[i] + s * gr
  end
  v.env, v.stage, v.gate = env, stage, gate
  v.p1, v.p2, v.p3 = p1, p2, p3
  v.idx, v.pe = idx, pe
  v.fenv, v.low, v.band = fenv, low, band
end

function E:renderVoices(off, n)
  local L, R, vs = self.L, self.R, self.voices
  local last = off + n - 1
  for k = #vs, 1, -1 do
    local v = vs[k]
    local i0 = off
    if v.delay > 0 then
      if v.delay >= n then
        v.delay = v.delay - n
        i0 = nil
      else
        i0 = off + v.delay
        v.delay = 0
      end
    end
    if i0 then
      if v.sample then renderSample(v, L, R, i0, last) else renderSynth(v, L, R, i0, last) end
    end
    if v.dead then table.remove(vs, k) end
  end
end

----------------------------------------------------------------------------
-- Sequencer
----------------------------------------------------------------------------
function E:start(mode, fromBar)
  self.mode = mode
  self.step = (mode == "song") and (fromBar or 0) * STEPS or 0
  self.untilNext = 0
  self.log, self.logHead = {}, 0
  self:releaseAll(true)
  self.playing = true
end

function E:stop()
  self.playing = false
  self:releaseAll(true)
  self.log, self.logHead = {}, 0
end

function E:triggerPattern(pi, st, fps, delay)
  local p = self.project
  local pat = p.patterns[pi]
  if not pat then return end
  local solo = Project.anySolo(p)
  local gateCut = 0.002 * SR
  for _, ch in ipairs(p.channels) do
    if not ch.mute and (not solo or ch.solo) then
      local list = pat.notes[ch.id]
      if list then
        for _, n in ipairs(list) do
          if n.s == st then self:noteOn(ch, n.p, n.v, n.l * fps - gateCut, delay) end
        end
      end
    end
  end
end

function E:logStep(frame, step)
  self.logHead = self.logHead % 64 + 1
  self.log[self.logHead] = { frame, step }
end

-- Step currently audible given the output latency (in frames), plus the
-- fractional position inside that step. Returns nil when nothing played yet.
function E:heardStep(latency)
  local target = self.frames - latency
  local best, bestFrame = nil, -1
  for _, e in pairs(self.log) do
    if e[1] <= target and e[1] > bestFrame then best, bestFrame = e[2], e[1] end
  end
  if not best then return nil, 0 end
  local frac = (target - bestFrame) / self:framesPerStep()
  if frac > 1 then frac = 1 end
  return best, frac
end

function E:onStep(absFrame)
  local p = self.project
  local fps = self:framesPerStep()
  local s = self.step
  local delay = 0
  if s % 2 == 1 then delay = floor(p.swing * fps * 0.5) end
  if self.mode == "song" then
    local total = Project.songLength(p) * STEPS
    if total == 0 then total = STEPS end
    if s >= total then s = 0 end
    local bar, st = floor(s / STEPS), s % STEPS
    for t = 1, Project.TRACKS do
      if not p.trackMute[t] then
        local pi = p.playlist[t][bar]
        if pi then self:triggerPattern(pi, st, fps, delay) end
      end
    end
    self:logStep(absFrame, s)
    self.step = s + 1
  else
    local st = s % STEPS
    self:triggerPattern(self.patternIndex, st, fps, delay)
    self:logStep(absFrame, st)
    self.step = (st + 1) % STEPS
  end
end

local function soft(x)
  if x > 0.9 then return 0.9 + 0.1 * tanh((x - 0.9) * 10) end
  if x < -0.9 then return -0.9 + 0.1 * tanh((x + 0.9) * 10) end
  return x
end

-- Render n stereo frames into self.L / self.R (1-based).
function E:render(n)
  local L, R = self.L, self.R
  for i = 1, n do L[i] = 0; R[i] = 0 end
  local off, remaining = 1, n
  while remaining > 0 do
    local seg = remaining
    if self.playing then
      if self.untilNext <= 0 then
        self:onStep(self.frames + off - 1)
        self.untilNext = self.untilNext + self:framesPerStep()
      end
      local k = math.ceil(self.untilNext)
      if k < 1 then k = 1 end
      if k < seg then seg = k end
    end
    self:renderVoices(off, seg)
    off = off + seg
    remaining = remaining - seg
    if self.playing then self.untilNext = self.untilNext - seg end
  end
  self.frames = self.frames + n

  local m = self.project.master
  local pl, pr = self.peakL, self.peakR
  for i = 1, n do
    local l, r = soft(L[i] * m), soft(R[i] * m)
    L[i], R[i] = l, r
    if l > pl then pl = l elseif -l > pl then pl = -l end
    if r > pr then pr = r elseif -r > pr then pr = -r end
  end
  self.peakL, self.peakR = pl, pr
end

----------------------------------------------------------------------------
-- Offline render (WAV export). Returns SoundData and the number of frames
-- worth keeping (song body + audible tail).
----------------------------------------------------------------------------
function E.renderOffline(project, mode, patternIndex)
  local e = E.new(project)
  e.patternIndex = patternIndex or project.current
  local steps
  if mode == "song" then
    local bars = Project.songLength(project)
    if bars == 0 then return nil, "Playlist is empty" end
    steps = bars * STEPS
    e:start("song", 0)
  else
    steps = STEPS
    e:start("pattern")
  end
  local body = floor(steps * e:framesPerStep() + 0.5)
  local total = body + 3 * SR
  local sd = love.sound.newSoundData(total, SR, 16, 2)
  local L, R = e.L, e.R
  local written, lastLoud = 0, 0
  while written < total do
    local n = math.min(2048, total - written)
    if e.playing and written + n >= body then
      n = body - written
      if n <= 0 then
        e.playing = false
        e:releaseAll(false)
        n = math.min(2048, total - written)
      end
    end
    e:render(n)
    for i = 1, n do
      local l, r = L[i], R[i]
      sd:setSample(written + i - 1, 1, l)
      sd:setSample(written + i - 1, 2, r)
      if l > 1e-4 or l < -1e-4 or r > 1e-4 or r < -1e-4 then lastLoud = written + i end
    end
    written = written + n
  end
  local keep = math.max(body, math.min(total, lastLoud + floor(0.05 * SR)))
  return sd, keep
end

return E
