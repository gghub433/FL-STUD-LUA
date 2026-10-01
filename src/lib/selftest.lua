-- Headless checks: `love src --selftest` (exit code 0 = all passed).
local Project = require("lib.project")
local Engine = require("lib.engine")
local Sounds = require("lib.sounds")
local Ser = require("lib.serialize")
local Wav = require("lib.wav")

local T = {}

local function firstSound(sd, from)
  for i = from or 0, sd:getSampleCount() - 1 do
    if math.abs(sd:getSample(i, 1)) > 1e-3 or math.abs(sd:getSample(i, 2)) > 1e-3 then return i end
  end
end

local function singleNoteProject(inst, step, swing)
  local p = Project.new()
  p.channels = {}
  p.bpm = 120
  p.swing = swing or 0
  local ch = Project.newChannel(p, inst)
  p.channels[1] = ch
  Project.addNote(p, 1, ch, step, Project.rootPitch(ch), 1, 0.8)
  return p
end

local tests = {}

tests[#tests + 1] = { "serialize round trip", function()
  local p = Project.demo()
  local s = Ser.encode(p)
  local p2 = assert(Project.sanitize(assert(Ser.decode(s))))
  assert(Ser.encode(p2) == s, "re-encoded project differs")
end }

tests[#tests + 1] = { "decode rejects code and bytecode", function()
  assert(Ser.decode("os.exit(1)") == nil, "code was executed")
  assert(Ser.decode("\27LuaJ") == nil, "bytecode accepted")
  assert(Ser.decode("{") == nil, "syntax error accepted")
end }

tests[#tests + 1] = { "sanitize drops bad data", function()
  local p = assert(Project.sanitize({
    bpm = 1e9, swing = -3,
    channels = { { id = 1, inst = "nope" }, { id = 2, inst = "kick", vol = 99 }, { id = 2, inst = "snare" } },
    patterns = { { notes = { [2] = { { s = 99, p = 60 }, { s = 3, p = 60, l = 40, v = 5 } }, [7] = { { s = 1, p = 1 } } } } },
    playlist = { { [0] = 1, [5] = 99, [-1] = 2, [2.5] = 1 } },
  }))
  assert(p.bpm == 300 and p.swing == 0, "tempo/swing not clamped")
  assert(#p.channels == 1 and p.channels[1].vol == 1, "channels not filtered")
  local notes = p.patterns[1].notes[2]
  assert(#notes == 1 and notes[1].s == 3 and notes[1].l == 13 and notes[1].v == 1, "notes not clamped")
  assert(p.patterns[1].notes[7] == nil, "orphan notes kept")
  assert(p.playlist[1][0] == 1 and p.playlist[1][5] == 9 and p.playlist[1][-1] == nil, "playlist not clamped")
  assert(Project.sanitize("x") == nil, "string accepted as project")
end }

tests[#tests + 1] = { "demo song length", function()
  assert(Project.songLength(Project.demo()) == 16)
end }

tests[#tests + 1] = { "every instrument makes sound", function()
  for _, inst in ipairs(Sounds.order) do
    local sd, keep = Engine.renderOffline(singleNoteProject(inst, 0), "pattern", 1)
    assert(firstSound(sd), inst .. " is silent")
    assert(keep > 0, inst .. " has no length")
  end
end }

tests[#tests + 1] = { "step timing is sample accurate", function()
  local p = singleNoteProject("kick", 4)
  local sd = Engine.renderOffline(p, "pattern", 1)
  local expected = 4 * Engine.SR * 60 / 120 / 4
  local got = firstSound(sd)
  assert(got and math.abs(got - expected) <= 2, "kick at frame " .. tostring(got) .. ", expected " .. expected)
end }

tests[#tests + 1] = { "swing delays odd steps", function()
  local straight = firstSound((Engine.renderOffline(singleNoteProject("hat", 1, 0), "pattern", 1)))
  local swung = firstSound((Engine.renderOffline(singleNoteProject("hat", 1, 1), "pattern", 1)))
  local fps = Engine.SR * 60 / 120 / 4
  assert(math.abs((swung - straight) - fps * 0.5) <= 2, "swing offset " .. (swung - straight))
end }

tests[#tests + 1] = { "mute and solo", function()
  local p = Project.demo()
  for _, ch in ipairs(p.channels) do ch.mute = true end
  local sd = Engine.renderOffline(p, "song")
  assert(firstSound(sd) == nil, "muted song is not silent")
  p.channels[1].mute = false
  p.channels[2].solo = true
  p.channels[2].mute = false
  sd = Engine.renderOffline(p, "pattern", 1)
  assert(firstSound(sd), "solo channel is silent")
end }

tests[#tests + 1] = { "song export and wav header", function()
  local p = Project.demo()
  local sd, keep = Engine.renderOffline(p, "song")
  local body = 16 * 16 * Engine.SR * 60 / p.bpm / 4
  assert(keep >= body and keep <= body + 3 * Engine.SR, "unexpected length " .. keep)
  local peak = 0
  for i = 0, keep - 1, 7 do peak = math.max(peak, math.abs(sd:getSample(i, 1))) end
  assert(peak > 0.2 and peak <= 1, "peak out of range: " .. peak)
  local wav = Wav.encode(sd, keep)
  assert(wav:sub(1, 4) == "RIFF" and wav:sub(9, 12) == "WAVE", "bad RIFF header")
  local dataSize = love.data.unpack("<I4", wav, 41)
  assert(dataSize == keep * 4 and #wav == 44 + dataSize, "bad data chunk size")
  assert(Engine.renderOffline(Project.new(), "song") == nil, "empty playlist exported")
end }

tests[#tests + 1] = { "clone, clear and remove channel", function()
  local p = Project.demo()
  local j = assert(Project.clonePattern(p, 1))
  assert(j == 5 and not Project.patternIsEmpty(p, j), "clone failed")
  Project.clearPattern(p, j)
  assert(Project.patternIsEmpty(p, j), "clear failed")
  local id = p.channels[1].id
  Project.removeChannel(p, 1)
  assert(p.patterns[1].notes[id] == nil, "notes of removed channel kept")
end }

function T.run()
  local failed = 0
  for _, t in ipairs(tests) do
    local ok, err = pcall(t[2])
    print((ok and "PASS  " or "FAIL  ") .. t[1] .. (ok and "" or ("  ->  " .. tostring(err))))
    if not ok then failed = failed + 1 end
  end
  print(string.format("%d/%d tests passed", #tests - failed, #tests))
  return failed == 0 and 0 or 1
end

return T
