-- LuaLoops: a small free pattern-based beat maker (Channel Rack -> Playlist).
local ui = require("lib.ui")
local U = require("lib.util")
local Project = require("lib.project")
local Engine = require("lib.engine")
local Sounds = require("lib.sounds")
local Ser = require("lib.serialize")
local Wav = require("lib.wav")
local Rack = require("views.rack")
local PianoRoll = require("views.pianoroll")
local Playlist = require("views.playlist")
local TopBar = require("views.topbar")

local VERSION = "0.1.0"
local BLOCK = 1024
local NBUF = 4
local AUTOSAVE = "autosave.llp"

local st = {
  mode = "pattern", selected = 1, songStart = 0, prTop = {},
  meterL = 0, meterR = 0, heardFrac = 0,
}
local history = { undo = {}, redo = {}, last = 0 }
local toastMsg, toastTime = nil, 0
local actions = {}

function st.toast(msg)
  toastMsg, toastTime = msg, love.timer.getTime()
end

----------------------------------------------------------------------------
-- Project management
----------------------------------------------------------------------------
local function setProject(p, keepHistory)
  st.project = p
  st.engine.project = p
  st.engine.patternIndex = p.current
  st.selected = U.clamp(st.selected, 1, math.max(1, #p.channels))
  if not keepHistory then history.undo, history.redo = {}, {} end
end

local function pushHistory(coalesce)
  local now = love.timer.getTime()
  if coalesce and history.coalescing and now - history.last < 0.8 then
    history.last = now
    return
  end
  history.coalescing = coalesce
  history.last = now
  local u = history.undo
  u[#u + 1] = Ser.encode(st.project)
  if #u > 100 then table.remove(u, 1) end
  history.redo = {}
end

local function restore(stackFrom, stackTo)
  local s = table.remove(stackFrom)
  if not s then return false end
  stackTo[#stackTo + 1] = Ser.encode(st.project)
  local p = Project.sanitize(Ser.decode(s))
  if p then setProject(p, true) end
  history.coalescing = false
  return true
end

function actions.undo()
  if restore(history.undo, history.redo) then st.toast("Undo") else st.toast("Nothing to undo") end
end

function actions.redo()
  if restore(history.redo, history.undo) then st.toast("Redo") else st.toast("Nothing to redo") end
end

local function loadString(data, name)
  local t, err = Ser.decode(data)
  local p
  if t then p, err = Project.sanitize(t) end
  if not p then
    st.toast("Cannot load " .. (name or "file") .. ": " .. tostring(err))
    return false
  end
  if st.engine.playing then st.engine:stop() end
  setProject(p)
  st.songStart = 0
  return true
end

function actions.newProject()
  pushHistory()
  if st.engine.playing then st.engine:stop() end
  setProject(Project.new(), true)
  st.filename = nil
  st.songStart = 0
  st.toast("New project (Ctrl+Z to undo)")
end

function actions.loadDemo()
  pushHistory()
  if st.engine.playing then st.engine:stop() end
  setProject(Project.demo(), true)
  st.filename = nil
  st.songStart = 0
  st.toast("Demo project loaded - press Space to play")
end

function actions.save(asNew)
  love.filesystem.createDirectory("projects")
  local name = (not asNew and st.filename) or ("projects/beat_" .. U.timestamp() .. ".llp")
  local ok, err = love.filesystem.write(name, Ser.encode(st.project))
  if ok then
    st.filename = name
    st.toast("Saved " .. name .. "   (Folder button opens it)")
  else
    st.toast("Save failed: " .. tostring(err))
  end
end

function actions.loadMenu()
  local items = {
    { label = "Demo project", fn = actions.loadDemo },
    { label = "Empty project", fn = actions.newProject },
  }
  local files = {}
  for _, f in ipairs(love.filesystem.getDirectoryItems("projects")) do
    if f:match("%.llp$") then
      local info = love.filesystem.getInfo("projects/" .. f)
      files[#files + 1] = { name = f, time = info and info.modtime or 0 }
    end
  end
  table.sort(files, function(a, b) return a.time > b.time end)
  for i = 1, math.min(#files, 18) do
    local path = "projects/" .. files[i].name
    items[#items + 1] = {
      label = files[i].name,
      fn = function()
        local data = love.filesystem.read(path)
        pushHistory()
        if data and loadString(data, files[i].name) then
          history.undo, history.redo = {}, {}
          st.filename = path
          st.toast("Loaded " .. path)
        end
      end,
    }
  end
  ui.openMenu(846, 44, items, #files > 0 and "Open project (drag & drop .llp works too)" or "No saved projects yet")
end

function actions.export()
  local mode = st.mode
  local t0 = love.timer.getTime()
  local sd, keep = Engine.renderOffline(st.project, mode, st.project.current)
  if not sd then
    st.toast("Export failed: " .. tostring(keep) .. " - paint patterns into the Playlist or use PAT mode")
    return
  end
  love.filesystem.createDirectory("exports")
  local base = st.filename and st.filename:match("([^/]+)%.llp$") or "lualoops"
  local name = "exports/" .. base .. "_" .. (mode == "song" and "song" or "pattern") .. "_" .. U.timestamp() .. ".wav"
  local ok, err = love.filesystem.write(name, Wav.encode(sd, keep))
  if ok then
    st.toast(string.format("Exported %s  (%.1f s audio, rendered in %.1f s)", name, keep / Engine.SR, love.timer.getTime() - t0))
  else
    st.toast("Export failed: " .. tostring(err))
  end
end

function actions.openFolder()
  local dir = love.filesystem.getSaveDirectory()
  love.filesystem.createDirectory("projects")
  if not love.system.openURL("file://" .. dir) then st.toast(dir) end
end

function actions.help()
  st.help = true
end

----------------------------------------------------------------------------
-- Transport & patterns
----------------------------------------------------------------------------
function actions.togglePlay()
  local e = st.engine
  if e.playing then
    e:stop()
  else
    if st.mode == "song" and Project.songLength(st.project) == 0 then
      st.mode = "pattern"
      st.toast("Playlist is empty - playing the current pattern")
    end
    e:start(st.mode, st.songStart)
  end
end

function actions.setMode(m)
  if st.mode == m then return end
  st.mode = m
  if st.engine.playing then
    st.engine:stop()
    actions.togglePlay()
  end
end

function actions.selectPattern(i)
  st.project.current = U.clamp(i, 1, Project.PATTERNS)
end

function actions.clonePattern()
  pushHistory()
  local j = Project.clonePattern(st.project, st.project.current)
  if j then
    st.project.current = j
    st.toast("Cloned into pattern " .. j)
  else
    st.toast("No empty pattern left to clone into")
  end
end

function actions.clearPattern()
  pushHistory()
  Project.clearPattern(st.project, st.project.current)
  st.toast("Pattern cleared (Ctrl+Z to undo)")
end

local function startRename(label, get, set)
  st.renaming = { label = label, text = get(), set = set }
  love.keyboard.setTextInput(true)
end

function actions.patternMenu()
  local p = st.project
  local items = {}
  for i = 1, Project.PATTERNS do
    local empty = Project.patternIsEmpty(p, i)
    items[#items + 1] = {
      label = i .. ": " .. p.patterns[i].name .. (empty and "  (empty)" or ""),
      color = empty and ui.colors.dim or nil,
      fn = function() p.current = i end,
    }
  end
  items[#items + 1] = { label = "Rename current pattern...", color = ui.colors.accent, fn = function()
    startRename("Pattern name", function() return p.patterns[p.current].name end,
      function(v) pushHistory(); p.patterns[p.current].name = v end)
  end }
  items[#items + 1] = { label = "Rename selected channel...", color = ui.colors.accent, fn = function()
    local ch = p.channels[st.selected]
    if ch then
      startRename("Channel name", function() return ch.name end, function(v) pushHistory(); ch.name = v end)
    end
  end }
  ui.openMenu(548, 44, items, "Patterns")
end

----------------------------------------------------------------------------
-- Headless modes: --selftest, --export <file.wav>
----------------------------------------------------------------------------
local function argValue(args, flag)
  for i, a in ipairs(args) do
    if a == flag then return args[i + 1] or true end
  end
end

local function headlessExport(args)
  local out = argValue(args, "--export")
  local p = Project.demo()
  local src = argValue(args, "--project")
  if type(src) == "string" then
    local f = assert(io.open(src, "rb"))
    local t = assert(Ser.decode(f:read("*a")))
    f:close()
    p = assert(Project.sanitize(t))
  end
  local sd, keep = Engine.renderOffline(p, "song")
  if not sd then
    print("export failed: " .. tostring(keep))
    return 1
  end
  local f = assert(io.open(out, "wb"))
  f:write(Wav.encode(sd, keep))
  f:close()
  print(string.format("wrote %s (%.2f s)", out, keep / Engine.SR))
  return 0
end

----------------------------------------------------------------------------
-- LÖVE callbacks
----------------------------------------------------------------------------
function love.load(args)
  args = args or {}
  Sounds.preload()
  if argValue(args, "--selftest") then
    love.event.quit(require("lib.selftest").run())
    st.headless = true
    return
  end
  if argValue(args, "--export") then
    love.event.quit(headlessExport(args))
    st.headless = true
    return
  end

  ui.load()
  ui.resize(love.graphics.getDimensions())
  ui.onEdit = pushHistory
  love.keyboard.setKeyRepeat(true)
  love.keyboard.setTextInput(false)

  local p
  if not argValue(args, "--demo") and love.filesystem.getInfo(AUTOSAVE) then
    local t = Ser.decode(love.filesystem.read(AUTOSAVE) or "")
    p = t and Project.sanitize(t)
  end
  p = p or Project.demo()
  st.project = p
  st.engine = Engine.new(p)
  st.engine.patternIndex = p.current

  local ok, src = pcall(love.audio.newQueueableSource, Engine.SR, 16, 2, NBUF)
  if ok and src then
    st.source = src
    st.buffer = love.sound.newSoundData(BLOCK, Engine.SR, 16, 2)
  else
    st.audioError = tostring(src)
    st.toast("No audio output available - running silently")
  end

  local shot = argValue(args, "--screenshot")
  if type(shot) == "string" then
    st.screenshot = { path = shot, frames = 0 }
    if argValue(args, "--play") then
      st.mode = "song"
      actions.togglePlay()
    end
  end
  if not love.filesystem.getInfo(AUTOSAVE) then
    st.toast("Welcome! Press Space to play the demo, F1 for help.")
  end
end

function love.update(dt)
  if st.headless then return end
  local e = st.engine
  e.patternIndex = st.project.current
  local latency = 0
  if st.source then
    local src, sd = st.source, st.buffer
    local guard = 0
    while src:getFreeBufferCount() > 0 and guard < NBUF do
      e:render(BLOCK)
      local L, R = e.L, e.R
      for i = 1, BLOCK do
        sd:setSample(i - 1, 1, L[i])
        sd:setSample(i - 1, 2, R[i])
      end
      src:queue(sd)
      guard = guard + 1
    end
    if not src:isPlaying() then src:play() end
    latency = (NBUF - src:getFreeBufferCount()) * BLOCK
  else
    st.silent = (st.silent or 0) + math.min(dt, 0.1) * Engine.SR
    while st.silent >= BLOCK do
      e:render(BLOCK)
      st.silent = st.silent - BLOCK
    end
  end

  -- meters
  st.meterL = math.max(e.peakL, st.meterL - dt * 1.8)
  st.meterR = math.max(e.peakR, st.meterR - dt * 1.8)
  e.peakL, e.peakR = 0, 0

  -- playheads
  st.patPlayStep, st.songPos = nil, nil
  if e.playing then
    local step, frac = e:heardStep(latency)
    if step then
      st.heardFrac = frac
      if e.mode == "song" then
        st.songPos = step + frac
        local bar, s = math.floor(step / Project.STEPS), step % Project.STEPS
        for t = 1, Project.TRACKS do
          if st.project.playlist[t][bar] == st.project.current and not st.project.trackMute[t] then
            st.patPlayStep = s
          end
        end
      else
        st.patPlayStep = step
      end
    end
  end
end

local function drawHelp()
  ui.rect({ 0, 0, 0 }, 0, 0, ui.W, ui.H, 0, 0.6)
  local x, y, w, h = 240, 70, 800, 620
  ui.rect(ui.colors.panel, x, y, w, h, 6)
  ui.frame(ui.colors.accent, x, y, w, h, 6)
  ui.text("LuaLoops " .. VERSION .. "  -  how it works", x + 24, y + 18, ui.colors.accent, ui.fonts.title)
  local lines = {
    "1. Channel Rack (left): instruments. Click steps to program a 16-step beat for the CURRENT pattern.",
    "2. Piano Roll (right): melody/notes of the selected channel in the current pattern.",
    "3. Playlist (bottom): paint the current pattern into bars. SONG mode plays the arrangement.",
    "",
    "Space  play / stop                     L  switch PAT / SONG mode",
    "1..9, Left/Right  select pattern        Up/Down  tempo +-1 (Shift = 10)",
    "Z S X D C V G B H N J M  play notes on the selected channel (computer keyboard)",
    "Ctrl+S save   Ctrl+Shift+S save as new   Ctrl+O open   Ctrl+N new   Ctrl+E export WAV",
    "Ctrl+Z undo   Ctrl+Y redo   F1 this help   Esc close menus",
    "",
    "Channel Rack: LMB paint / erase steps (drag), RMB erase, wheel on a step = velocity,",
    "  LED: LMB mute / RMB solo, knobs: drag up/down, wheel, RMB = reset; RMB on name = menu.",
    "Piano Roll: LMB add/move note, drag right edge to resize, RMB delete, wheel scroll pitch.",
    "Playlist: LMB paint current pattern, RMB erase, Ctrl+LMB pick pattern, ruler = start bar.",
    "Pattern box (top): click for pattern list and renaming. Clone copies to an empty pattern.",
    "",
    "Files live in: " .. love.filesystem.getSaveDirectory(),
    "Drag & drop a .llp project onto the window to open it. Autosave on exit.",
    "",
    "All sounds are synthesized in code. Free & open source (MIT). Not affiliated with Image-Line.",
    "",
    "Click anywhere or press Esc to close.",
  }
  for i, l in ipairs(lines) do
    ui.text(l, x + 24, y + 60 + (i - 1) * 24, i <= 3 and ui.colors.text or ui.colors.dim)
  end
end

local function drawRename()
  local r = st.renaming
  ui.rect({ 0, 0, 0 }, 0, 0, ui.W, ui.H, 0, 0.5)
  local x, y, w, h = 440, 300, 400, 110
  ui.rect(ui.colors.panel, x, y, w, h, 6)
  ui.frame(ui.colors.accent, x, y, w, h, 6)
  ui.text(r.label, x + 16, y + 12, ui.colors.dim)
  ui.rect({ 0.07, 0.08, 0.09 }, x + 16, y + 36, w - 32, 30, 3)
  local caret = (math.floor(love.timer.getTime() * 2) % 2 == 0) and "|" or ""
  ui.text(r.text .. caret, x + 24, y + 42, ui.colors.text, ui.fonts.big)
  ui.text("Enter = OK, Esc = cancel", x + 16, y + 80, ui.colors.dim, ui.fonts.small)
end

function love.draw()
  if st.headless then return end
  local g = love.graphics
  g.clear(ui.colors.bg)
  g.push()
  g.translate(ui.ox, ui.oy)
  g.scale(ui.scale)

  ui.beginFrame()
  ui.menuInput()
  if st.help or st.renaming then
    if st.help and (ui.pressed[1] or ui.pressed[2]) then st.help = false end
    ui.blocked = true
  end

  TopBar.draw(st, actions)
  Rack.draw(st)
  PianoRoll.draw(st)
  Playlist.draw(st)

  if st.audioError then
    ui.text("audio: off", ui.W - 70, 50, ui.colors.red, ui.fonts.small)
  end
  if toastMsg and love.timer.getTime() - toastTime < 4 then
    local f = ui.fonts.normal
    local w = f:getWidth(toastMsg) + 30
    local x = (ui.W - w) / 2
    ui.rect({ 0.05, 0.05, 0.06 }, x, ui.H - 44, w, 30, 5, 0.92)
    ui.frame(ui.colors.accent, x, ui.H - 44, w, 30, 5)
    ui.text(toastMsg, x + 15, ui.H - 36, ui.colors.text)
  end
  ui.drawMenu()
  if st.help then drawHelp() end
  if st.renaming then drawRename() end
  if not st.help and not st.renaming then ui.drawTooltip() end

  g.pop()
  ui.endFrame()

  if st.screenshot then
    local s = st.screenshot
    s.frames = s.frames + 1
    if s.frames == 45 then
      g.captureScreenshot(function(img)
        local f = io.open(s.path, "wb")
        if f then
          f:write(img:encode("png"):getString())
          f:close()
        end
        love.event.quit(0)
      end)
    end
  end
end

-- Computer keyboard as a piano (two rows, like most DAWs).
local KEYMAP = { z = 0, s = 1, x = 2, d = 3, c = 4, v = 5, g = 6, b = 7, h = 8, n = 9, j = 10, m = 11,
                 [","] = 12 }

function love.keypressed(key, _, isrepeat)
  if st.headless then return end
  if st.renaming then
    local r = st.renaming
    if key == "return" or key == "kpenter" then
      if #r.text > 0 then r.set(r.text) end
      st.renaming = nil
      love.keyboard.setTextInput(false)
    elseif key == "escape" then
      st.renaming = nil
      love.keyboard.setTextInput(false)
    elseif key == "backspace" then
      r.text = r.text:gsub("[%z\1-\127\194-\244][\128-\191]*$", "")
    end
    return
  end
  if st.help then
    if key == "escape" or key == "f1" or key == "return" then st.help = false end
    return
  end
  if key == "escape" then
    ui.menu = nil
    return
  end
  local ctrl, shift = ui.ctrl(), ui.shift()
  local p = st.project
  if ctrl then
    if key == "s" then actions.save(shift)
    elseif key == "o" then actions.loadMenu()
    elseif key == "e" then actions.export()
    elseif key == "n" then actions.newProject()
    elseif key == "z" then if shift then actions.redo() else actions.undo() end
    elseif key == "y" then actions.redo()
    end
    return
  end
  if key == "space" then
    if not isrepeat then actions.togglePlay() end
  elseif key == "f1" then
    st.help = true
  elseif key == "left" then
    actions.selectPattern(p.current - 1)
  elseif key == "right" then
    actions.selectPattern(p.current + 1)
  elseif key == "up" or key == "down" then
    pushHistory(true)
    p.bpm = U.clamp(p.bpm + (key == "up" and 1 or -1) * (shift and 10 or 1), 40, 300)
  elseif key:match("^[1-9]$") then
    actions.selectPattern(tonumber(key))
  elseif key == "l" then
    actions.setMode(st.mode == "song" and "pattern" or "song")
  elseif KEYMAP[key] and not isrepeat then
    local ch = p.channels[st.selected]
    if ch then st.engine:preview(ch, Project.rootPitch(ch) + KEYMAP[key]) end
  end
end

function love.textinput(t)
  if st.renaming and #st.renaming.text < 24 then
    st.renaming.text = st.renaming.text .. t
  end
end

function love.mousepressed(x, y, b)
  if st.headless then return end
  ui.mousepressed(x, y, b)
end

function love.mousereleased(x, y, b)
  if st.headless then return end
  ui.mousereleased(x, y, b)
end

function love.wheelmoved(x, y)
  if st.headless then return end
  ui.wheelmoved(x, y)
end

function love.resize(w, h)
  ui.resize(w, h)
end

function love.filedropped(file)
  if st.headless then return end
  file:open("r")
  local data = file:read()
  file:close()
  pushHistory()
  local name = file:getFilename():match("([^/\\]+)$")
  if loadString(data, name) then
    st.filename = nil
    st.toast("Loaded " .. name)
  end
end

function love.quit()
  if st.headless or not st.project then return end
  love.filesystem.write(AUTOSAVE, Ser.encode(st.project))
end
