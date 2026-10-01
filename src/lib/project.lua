-- Project data model: channels (instruments), patterns (notes per channel)
-- and the playlist (which pattern plays on which track at which bar).
local Sounds = require("lib.sounds")
local U = require("lib.util")

local P = {}

P.STEPS = 16       -- steps per pattern (one 4/4 bar of 1/16 notes)
P.PATTERNS = 9
P.TRACKS = 8
P.BARS = 32
P.MAX_CHANNELS = 24
P.DEFAULT_VEL = 0.78

function P.newChannel(p, inst)
  p.nextId = p.nextId + 1
  local def = Sounds.defs[inst]
  return {
    id = p.nextId, inst = inst, name = def.label,
    vol = 0.78, pan = 0, pitch = 0, tone = 0.5,
    mute = false, solo = false,
  }
end

function P.new()
  local p = {
    version = 1, bpm = 128, swing = 0, master = 0.8,
    nextId = 0, current = 1,
    channels = {}, patterns = {}, playlist = {}, trackMute = {},
  }
  for _, inst in ipairs({ "kick", "clap", "snare", "hat", "ohat", "tom", "bass", "pluck" }) do
    p.channels[#p.channels + 1] = P.newChannel(p, inst)
  end
  for i = 1, P.PATTERNS do
    p.patterns[i] = { name = "Pattern " .. i, notes = {} }
  end
  for t = 1, P.TRACKS do
    p.playlist[t] = {}
    p.trackMute[t] = false
  end
  return p
end

-- Notes of one channel in one pattern (created on demand).
function P.notes(p, pi, ch)
  local pat = p.patterns[pi]
  local list = pat.notes[ch.id]
  if not list then
    list = {}
    pat.notes[ch.id] = list
  end
  return list
end

function P.hasStep(p, pi, ch, s)
  local list = p.patterns[pi].notes[ch.id]
  if not list then return false end
  for _, n in ipairs(list) do
    if n.s == s then return true, n end
  end
  return false
end

function P.addNote(p, pi, ch, s, pitch, len, vel)
  local list = P.notes(p, pi, ch)
  local n = { s = s, p = pitch, l = len or 1, v = vel or P.DEFAULT_VEL }
  list[#list + 1] = n
  return n
end

function P.removeStep(p, pi, ch, s)
  local list = p.patterns[pi].notes[ch.id]
  if not list then return end
  for i = #list, 1, -1 do
    if list[i].s == s then table.remove(list, i) end
  end
end

function P.removeNote(p, pi, ch, note)
  local list = p.patterns[pi].notes[ch.id]
  if not list then return end
  for i = #list, 1, -1 do
    if list[i] == note then table.remove(list, i) end
  end
end

function P.rootPitch(ch)
  return Sounds.defs[ch.inst].root
end

function P.patternIsEmpty(p, pi)
  for _, list in pairs(p.patterns[pi].notes) do
    if #list > 0 then return false end
  end
  return true
end

function P.clearPattern(p, pi)
  p.patterns[pi].notes = {}
end

-- Copy pattern `pi` into the first empty pattern. Returns its index or nil.
function P.clonePattern(p, pi)
  for j = 1, P.PATTERNS do
    if j ~= pi and P.patternIsEmpty(p, j) then
      p.patterns[j].notes = U.deepcopy(p.patterns[pi].notes)
      p.patterns[j].name = p.patterns[pi].name .. " copy"
      return j
    end
  end
  return nil
end

function P.removeChannel(p, idx)
  local ch = p.channels[idx]
  if not ch then return end
  for _, pat in ipairs(p.patterns) do pat.notes[ch.id] = nil end
  table.remove(p.channels, idx)
end

-- Number of bars up to the last used playlist cell (0 if the playlist is empty).
function P.songLength(p)
  local last = -1
  for t = 1, P.TRACKS do
    for bar in pairs(p.playlist[t]) do
      if bar > last then last = bar end
    end
  end
  return last + 1
end

function P.anySolo(p)
  for _, ch in ipairs(p.channels) do
    if ch.solo then return true end
  end
  return false
end

----------------------------------------------------------------------------
-- Demo song: 16 bars, house groove in A minor.
----------------------------------------------------------------------------
function P.demo()
  local p = P.new()
  p.bpm = 124
  p.swing = 0.12
  local ch = {}
  for _, c in ipairs(p.channels) do ch[c.inst] = c end
  ch.ohat.vol = 0.55
  ch.hat.vol = 0.6
  ch.tom.vol = 0.7
  ch.bass.vol = 0.8
  ch.pluck.vol = 0.62
  ch.pluck.pan = 0.12
  ch.hat.pan = -0.15

  local function steps(pi, c, list, vel)
    for _, s in ipairs(list) do P.addNote(p, pi, c, s, P.rootPitch(c), 1, vel) end
  end

  -- 1: main drums
  p.patterns[1].name = "Drums"
  steps(1, ch.kick, { 0, 4, 8, 12 }, 0.9)
  steps(1, ch.clap, { 4, 12 }, 0.8)
  steps(1, ch.ohat, { 2, 6, 10, 14 }, 0.7)
  steps(1, ch.hat, { 0, 4, 8, 12 }, 0.45)
  steps(1, ch.hat, { 1, 5, 9, 13, 15 }, 0.3)

  -- 2: bass riff
  p.patterns[2].name = "Bass"
  local bassLine = { { 0, 33, 2 }, { 3, 33, 1 }, { 6, 36, 2 }, { 8, 33, 2 }, { 11, 31, 1 }, { 14, 28, 2 } }
  for _, n in ipairs(bassLine) do P.addNote(p, 2, ch.bass, n[1], n[2], n[3], 0.85) end

  -- 3: pluck arpeggio
  p.patterns[3].name = "Pluck"
  local arp = { 69, 72, 76, 72, 69, 72, 76, 79, 67, 71, 74, 71, 67, 71, 74, 76 }
  for s = 0, 15 do P.addNote(p, 3, ch.pluck, s, arp[s + 1], 1, (s % 4 == 0) and 0.85 or 0.62) end

  -- 4: drum fill
  p.patterns[4].name = "Fill"
  steps(4, ch.kick, { 0, 4, 8 }, 0.9)
  steps(4, ch.clap, { 4 }, 0.8)
  steps(4, ch.hat, { 0, 2, 4, 6, 8, 10 }, 0.4)
  steps(4, ch.tom, { 8, 10 }, 0.75)
  for i, s in ipairs({ 12, 13, 14, 15 }) do P.addNote(p, 4, ch.snare, s, 60, 1, 0.45 + i * 0.12) end

  -- arrangement
  for bar = 0, 15 do
    p.playlist[1][bar] = (bar == 7 or bar == 15) and 4 or 1
  end
  for bar = 4, 15 do p.playlist[2][bar] = 2 end
  for bar = 8, 15 do p.playlist[3][bar] = 3 end
  p.current = 1
  return p
end

----------------------------------------------------------------------------
-- Validation of loaded data: never trust a file, rebuild a clean project.
----------------------------------------------------------------------------
local function num(v, lo, hi, def)
  if type(v) ~= "number" or v ~= v then return def end
  return U.clamp(v, lo, hi)
end

local function int(v, lo, hi, def)
  local n = num(v, lo, hi, nil)
  if n == nil then return def end
  return math.floor(n + 0.5)
end

function P.sanitize(t)
  if type(t) ~= "table" then return nil, "not a project file" end
  local p = P.new()
  p.channels = {}
  p.bpm = num(t.bpm, 40, 300, 128)
  p.swing = num(t.swing, 0, 1, 0)
  p.master = num(t.master, 0, 1.2, 0.8)
  p.current = int(t.current, 1, P.PATTERNS, 1)

  local ids = {}
  if type(t.channels) == "table" then
    for _, c in ipairs(t.channels) do
      if #p.channels >= P.MAX_CHANNELS then break end
      if type(c) == "table" and type(c.inst) == "string" and Sounds.defs[c.inst] then
        local id = int(c.id, 1, 1e6, nil)
        if id and not ids[id] then
          ids[id] = true
          p.channels[#p.channels + 1] = {
            id = id, inst = c.inst,
            name = type(c.name) == "string" and c.name:sub(1, 24) or Sounds.defs[c.inst].label,
            vol = num(c.vol, 0, 1, 0.78), pan = num(c.pan, -1, 1, 0),
            pitch = int(c.pitch, -24, 24, 0), tone = num(c.tone, 0, 1, 0.5),
            mute = c.mute == true, solo = c.solo == true,
          }
          if id > p.nextId then p.nextId = id end
        end
      end
    end
  end

  if type(t.patterns) == "table" then
    for i = 1, P.PATTERNS do
      local src = t.patterns[i]
      if type(src) == "table" then
        if type(src.name) == "string" then p.patterns[i].name = src.name:sub(1, 24) end
        if type(src.notes) == "table" then
          for id, list in pairs(src.notes) do
            if type(id) == "number" and ids[id] and type(list) == "table" then
              local out = {}
              for _, n in ipairs(list) do
                if type(n) == "table" and #out < 256 then
                  -- out-of-range positions are dropped, not clamped onto the last step
                  local s = type(n.s) == "number" and n.s >= 0 and n.s < P.STEPS and math.floor(n.s) or nil
                  local pitch = type(n.p) == "number" and n.p >= 0 and n.p <= 127 and math.floor(n.p) or nil
                  if s and pitch then
                    out[#out + 1] = { s = s, p = pitch, l = int(n.l, 1, P.STEPS - s, 1),
                                      v = num(n.v, 0.05, 1, P.DEFAULT_VEL) }
                  end
                end
              end
              p.patterns[i].notes[id] = out
            end
          end
        end
      end
    end
  end

  if type(t.playlist) == "table" then
    for tr = 1, P.TRACKS do
      local row = t.playlist[tr]
      if type(row) == "table" then
        for bar, pi in pairs(row) do
          local b = int(bar, 0, P.BARS - 1, nil)
          local v = int(pi, 1, P.PATTERNS, nil)
          if b and v and b == bar then p.playlist[tr][b] = v end
        end
      end
    end
  end
  if type(t.trackMute) == "table" then
    for tr = 1, P.TRACKS do p.trackMute[tr] = t.trackMute[tr] == true end
  end
  return p
end

return P
