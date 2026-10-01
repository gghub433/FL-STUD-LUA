-- Transport, tempo, pattern selector and file actions.
local ui = require("lib.ui")
local U = require("lib.util")
local Project = require("lib.project")
local Playlist = require("views.playlist")

local T = {}

local function fmtPct(v) return string.format("%d%%", U.round(v * 100)) end

local function small(s, cx, y)
  local f = ui.fonts.small
  ui.text(s, cx - f:getWidth(s) / 2, y, ui.colors.dim, f)
end

local function meter(x, y, w, v)
  ui.rect({ 0.07, 0.08, 0.09 }, x, y, w, 6, 2)
  local lv = U.clamp(v, 0, 1)
  local col = lv > 0.95 and ui.colors.red or (lv > 0.7 and ui.colors.yellow or ui.colors.green)
  ui.rect(col, x, y, w * lv, 6, 2)
end

function T.draw(st, actions)
  local p = st.project
  ui.rect(ui.colors.panel, 0, 0, ui.W, 48)
  ui.rect(ui.colors.line, 0, 48, ui.W, 1)
  ui.text("LuaLoops", 14, 12, ui.colors.accent, ui.fonts.title)

  -- transport
  local playing = st.engine.playing
  local c = ui.button(118, 8, 42, 32, nil, { on = playing, tip = "Play / Stop  (Space)" })
  love.graphics.setColor(playing and { 0.1, 0.1, 0.1 } or ui.colors.text)
  if playing then
    love.graphics.rectangle("fill", 132, 17, 14, 14)
  else
    love.graphics.polygon("fill", 133, 16, 133, 32, 147, 24)
  end
  if c then actions.togglePlay() end

  if ui.button(166, 8, 44, 32, "PAT", { on = st.mode == "pattern", tip = "Pattern mode: loop the current pattern  (L)" }) then
    actions.setMode("pattern")
  end
  if ui.button(212, 8, 52, 32, "SONG", { on = st.mode == "song", tip = "Song mode: play the Playlist  (L)" }) then
    actions.setMode("song")
  end

  -- tempo, swing, master
  p.bpm = ui.dragNumber("bpm", 274, 8, 64, 32, p.bpm, 40, 300, 128,
    function(v) return string.format("%d", v) end, "Tempo: drag up/down, wheel, RMB = 128  (Up/Down keys)")
  small("BPM", 352, 18)
  p.swing = ui.knob("swing", 386, 22, 13, p.swing, 0, 1, 0, "Swing", fmtPct)
  small("Swing", 386, 36)
  p.master = ui.knob("master", 426, 22, 13, p.master, 0, 1.2, 0.8, "Master volume", fmtPct)
  small("Master", 426, 36)
  meter(450, 15, 56, st.meterL)
  meter(450, 25, 56, st.meterR)

  -- pattern selector
  small("Pattern", 610, 1)
  if ui.button(522, 12, 22, 28, "<", { tip = "Previous pattern  (Left)" }) then actions.selectPattern(p.current - 1) end
  local col = Playlist.patternColor(p.current)
  local hov = ui.hover(548, 12, 124, 28)
  ui.rect(col, 548, 12, 124, 28, 3)
  ui.textCenter(p.current .. ": " .. ui.fit(p.patterns[p.current].name, 96), 548, 12, 124, 28, { 0.08, 0.08, 0.1 })
  if hov then
    ui.tooltip = "Current pattern (keys 1-9, wheel). Painted into the Playlist with LMB."
    if ui.wheel ~= 0 then actions.selectPattern(p.current - ui.wheel) end
    if ui.pressed[1] then actions.patternMenu() end
  end
  if ui.button(676, 12, 22, 28, ">", { tip = "Next pattern  (Right)" }) then actions.selectPattern(p.current + 1) end
  if ui.button(706, 12, 52, 28, "Clone", { tip = "Copy this pattern into the next empty one" }) then actions.clonePattern() end
  if ui.button(762, 12, 50, 28, "Clear", { tip = "Remove all notes from this pattern" }) then actions.clearPattern() end

  -- file actions
  local bx = 846
  local function btn(w, label, tip, fn)
    if ui.button(bx, 12, w, 28, label, { tip = tip }) then fn() end
    bx = bx + w + 4
  end
  btn(46, "New", "New empty project  (Ctrl+N)", actions.newProject)
  btn(50, "Load", "Open a saved project or the demo  (Ctrl+O)", actions.loadMenu)
  btn(50, "Save", "Save project  (Ctrl+S, Ctrl+Shift+S = save as new)", function() actions.save(false) end)
  btn(92, "Export WAV", "Render the song (or pattern in PAT mode) to WAV  (Ctrl+E)", actions.export)
  btn(58, "Folder", "Open the folder with projects and exports", actions.openFolder)
  btn(40, "Undo", "Undo  (Ctrl+Z)", actions.undo)
  btn(26, "?", "Help  (F1)", actions.help)
end

return T
