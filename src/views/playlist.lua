-- Playlist: arrange patterns on tracks, bar by bar.
local ui = require("lib.ui")
local U = require("lib.util")
local Project = require("lib.project")

local PL = {}

local X, Y, W, H = 10, 440, 1260, 312
local LABEL_W = 90
local GX = X + LABEL_W
local CW = 36
local RULER_Y = Y + 28
local RULER_H = 18
local GY = RULER_Y + RULER_H + 4
local TH = 31
local GW = Project.BARS * CW
local GH = Project.TRACKS * TH

PL.drag = nil

function PL.patternColor(pi)
  return { U.hsv(0.55 + pi * 0.11, 0.45, 0.82) }
end

local function cellAt(mx, my)
  local bar = math.floor((mx - GX) / CW)
  local tr = math.floor((my - GY) / TH) + 1
  if bar < 0 or bar >= Project.BARS or tr < 1 or tr > Project.TRACKS then return nil end
  return tr, bar
end

function PL.draw(st)
  local p = st.project
  ui.panel(X, Y, W, H, "Playlist  -  Arrangement",
    "LMB paint current pattern   RMB erase   Ctrl+LMB pick pattern   click ruler: start position   click track name: mute")
  local songLen = Project.songLength(p)

  -- ruler
  ui.rect({ 0.12, 0.13, 0.15 }, GX, RULER_Y, GW, RULER_H, 2)
  if songLen > 0 then ui.rect({ 0.2, 0.22, 0.26 }, GX, RULER_Y, songLen * CW, RULER_H, 2) end
  for bar = 0, Project.BARS - 1 do
    local x = GX + bar * CW
    ui.rect(ui.colors.line, x, RULER_Y, 1, RULER_H)
    ui.text(tostring(bar + 1), x + 4, RULER_Y + 3, bar % 4 == 0 and ui.colors.text or ui.colors.dim, ui.fonts.small)
  end
  local sx = GX + st.songStart * CW
  love.graphics.setColor(ui.colors.accent)
  love.graphics.polygon("fill", sx, RULER_Y, sx + 9, RULER_Y, sx, RULER_Y + 10)
  if ui.hover(GX, RULER_Y, GW, RULER_H) then
    local bar = U.clamp(math.floor((ui.mx - GX) / CW), 0, Project.BARS - 1)
    ui.tooltip = "Start playback from bar " .. (bar + 1)
    if ui.pressed[1] then
      st.songStart = bar
      if st.engine.playing and st.mode == "song" then st.engine:start("song", bar) end
    end
  end
  ui.text("Bar", X + 12, RULER_Y + 3, ui.colors.dim, ui.fonts.small)

  -- tracks
  for tr = 1, Project.TRACKS do
    local y = GY + (tr - 1) * TH
    local muted = p.trackMute[tr]
    local c = ui.button(X + 6, y + 1, LABEL_W - 12, TH - 3, nil, { tip = "Click to mute / unmute this track" })
    ui.text("Track " .. tr, X + 14, y + 8, muted and ui.colors.dim or ui.colors.text)
    ui.rect(muted and ui.colors.red or ui.colors.green, X + LABEL_W - 18, y + 11, 6, 6, 3)
    if c then ui.edit(); p.trackMute[tr] = not muted end

    for bar = 0, Project.BARS - 1 do
      local x = GX + bar * CW
      local shade = (math.floor(bar / 4) % 2 == 0) and { 0.17, 0.19, 0.22 } or { 0.15, 0.165, 0.19 }
      ui.rect(shade, x, y, CW - 1, TH - 1)
    end
    local row = p.playlist[tr]
    for bar = 0, Project.BARS - 1 do
      local pi = row[bar]
      if pi then
        local x = GX + bar * CW
        local startRun = row[bar - 1] ~= pi
        local endRun = row[bar + 1] ~= pi
        local col = PL.patternColor(pi)
        local x0 = x + (startRun and 1 or 0)
        local w = CW - (startRun and 1 or 0) - (endRun and 2 or 0)
        ui.rect(col, x0, y + 2, w, TH - 5, 2, muted and 0.35 or 0.9)
        if startRun then
          local runLen = 1
          while row[bar + runLen] == pi do runLen = runLen + 1 end
          ui.text(ui.fit(p.patterns[pi].name, runLen * CW - 8, ui.fonts.small), x + 4, y + 9,
            { 0.08, 0.08, 0.1 }, ui.fonts.small)
        end
      end
    end
  end

  -- editing
  if ui.hover(GX, GY, GW, GH) then
    local tr, bar = cellAt(ui.mx, ui.my)
    if tr then
      local cur = p.playlist[tr][bar]
      if cur then ui.tooltip = p.patterns[cur].name .. "  (bar " .. (bar + 1) .. ")" end
      if ui.pressed[1] and ui.ctrl() then
        if cur then p.current = cur end
      elseif ui.pressed[1] then
        ui.edit()
        p.playlist[tr][bar] = p.current
        PL.drag = { mode = "paint", track = tr, last = bar }
        ui.active = "pl"
      elseif ui.pressed[2] then
        ui.edit()
        p.playlist[tr][bar] = nil
        PL.drag = { mode = "erase", last = bar, lastTrack = tr }
        ui.active = "pl"
      end
    end
  end
  -- drags fill every bar between the previous and current mouse position
  local d = PL.drag
  if d and ui.active == "pl" and (ui.down[1] or ui.down[2]) then
    local bar = U.clamp(math.floor((ui.mx - GX) / CW), 0, Project.BARS - 1)
    if d.mode == "paint" then
      for b = math.min(d.last, bar), math.max(d.last, bar) do p.playlist[d.track][b] = p.current end
      d.last = bar
    else
      local tr = cellAt(ui.mx, ui.my)
      if tr then
        local from = tr == d.lastTrack and d.last or bar
        for b = math.min(from, bar), math.max(from, bar) do p.playlist[tr][b] = nil end
        d.last, d.lastTrack = bar, tr
      end
    end
  elseif d and ui.active ~= "pl" then
    PL.drag = nil
  end

  -- song playhead
  if st.songPos then
    local x = GX + st.songPos / Project.STEPS * CW
    ui.rect({ 1, 1, 1 }, x, RULER_Y, 2, GY + GH - RULER_Y, 0, 0.8)
  end
end

return PL
