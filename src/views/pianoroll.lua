-- Piano Roll for the selected channel in the current pattern.
local ui = require("lib.ui")
local U = require("lib.util")
local Project = require("lib.project")
local Sounds = require("lib.sounds")
local Rack = require("views.rack")

local PR = {}

local X, Y, W, H = 660, 56, 610, 376
local KX, KW = X + 6, 44
local GX = X + 52
local CW = 34
local GY = Y + 70
local RH = 12
local ROWS = 22
local VY, VH = Y + 338, 32
local GW, GH = 16 * CW, ROWS * RH

PR.lastLen = 1
PR.drag = nil

local function fmtPct(v) return string.format("%d%%", U.round(v * 100)) end
local function fmtPan(v)
  if math.abs(v) < 0.01 then return "C" end
  return string.format("%d%% %s", U.round(math.abs(v) * 100), v < 0 and "L" or "R")
end
local function fmtSemi(v) return string.format("%+d st", U.round(v)) end

local function topFor(st, ch)
  local t = st.prTop[ch.id]
  if not t then
    t = U.clamp(Project.rootPitch(ch) + 14, ROWS - 1, 127)
    st.prTop[ch.id] = t
  end
  return t
end

local function noteAt(list, s, pitch)
  for i = #list, 1, -1 do
    local n = list[i]
    if n.p == pitch and s >= n.s and s < n.s + n.l then return n end
  end
end

local function label(s, cx, y)
  local f = ui.fonts.small
  ui.text(s, cx - f:getWidth(s) / 2, y, ui.colors.dim, f)
end

function PR.draw(st)
  local p = st.project
  local ch = p.channels[st.selected]
  ui.panel(X, Y, W, H, "Piano Roll  -  " .. (ch and ch.name or "no channel"),
    "LMB draw/move/resize  RMB delete  wheel: scroll")
  if not ch then
    ui.text("Add a channel in the Channel Rack.", X + 20, Y + 60, ui.colors.dim)
    return
  end
  local def = Sounds.defs[ch.inst]
  local col = Rack.channelColor(st.selected)
  local list = Project.notes(p, p.current, ch)
  local top = topFor(st, ch)

  -- channel settings strip
  ch.vol = ui.knob("prvol" .. ch.id, X + 26, Y + 42, 11, ch.vol, 0, 1, 0.78, "Volume", fmtPct, col)
  label("Vol", X + 26, Y + 55)
  ch.pan = ui.knob("prpan" .. ch.id, X + 62, Y + 42, 11, ch.pan, -1, 1, 0, "Pan", fmtPan, col)
  label("Pan", X + 62, Y + 55)
  ch.pitch = U.round(ui.knob("prpitch" .. ch.id, X + 98, Y + 42, 11, ch.pitch, -24, 24, 0, "Pitch", fmtSemi, col))
  label("Pitch", X + 98, Y + 55)
  local infoX = X + 124
  if def.kind == "synth" then
    ch.tone = ui.knob("prtone" .. ch.id, X + 134, Y + 42, 11, ch.tone, 0, 1, 0.5, "Tone (brightness)", fmtPct, col)
    label("Tone", X + 134, Y + 55)
    infoX = X + 160
  end
  ui.text(def.label .. (def.kind == "synth" and "  synth" or "  drum sample"), infoX, Y + 30, ui.colors.text)
  ui.text("pattern: " .. p.patterns[p.current].name, infoX, Y + 46, ui.colors.dim, ui.fonts.small)

  ui.text("Note", X + 326, Y + 30, ui.colors.dim, ui.fonts.small)
  ui.text("length", X + 326, Y + 42, ui.colors.dim, ui.fonts.small)
  if ui.button(X + 364, Y + 32, 22, 22, "-", { tip = "Shorter default note" }) then
    PR.lastLen = math.max(1, PR.lastLen - 1)
  end
  ui.textCenter(PR.lastLen .. "/16", X + 388, Y + 32, 42, 22, ui.colors.accent)
  if ui.button(X + 432, Y + 32, 22, 22, "+", { tip = "Longer default note" }) then
    PR.lastLen = math.min(16, PR.lastLen + 1)
  end
  if ui.button(X + 470, Y + 32, 60, 22, "Oct -", { tip = "Scroll down one octave" }) then
    top = U.clamp(top - 12, ROWS - 1, 127)
  end
  if ui.button(X + 536, Y + 32, 60, 22, "Oct +", { tip = "Scroll up one octave" }) then
    top = U.clamp(top + 12, ROWS - 1, 127)
  end

  -- scrolling
  if ui.hover(KX, GY, GX + GW - KX, GH) and ui.wheel ~= 0 then
    top = U.clamp(top + ui.wheel * (ui.shift() and 12 or 2), ROWS - 1, 127)
  end
  st.prTop[ch.id] = top

  -- keyboard + grid rows
  for r = 0, ROWS - 1 do
    local pitch = top - r
    local y = GY + r * RH
    local black = U.isBlack(pitch)
    local hovKey = ui.hover(KX, y, KW, RH)
    local keyCol = black and { 0.12, 0.12, 0.14 } or { 0.85, 0.86, 0.88 }
    if hovKey then keyCol = ui.colors.accent end
    ui.rect(keyCol, KX, y, KW, RH - 1)
    if pitch % 12 == 0 then
      ui.text(U.noteName(pitch), KX + 3, y - 1, { 0.25, 0.25, 0.28 }, ui.fonts.small)
    end
    if pitch == def.root then ui.rect(col, KX + KW - 5, y + 2, 3, RH - 5) end
    if hovKey then
      ui.tooltip = U.noteName(pitch)
      if ui.pressed[1] then st.engine:preview(ch, pitch) end
    end
    ui.rect(black and { 0.13, 0.145, 0.165 } or { 0.175, 0.195, 0.225 }, GX, y, GW, RH - 1)
  end
  for s = 0, 16 do
    ui.rect(s % 4 == 0 and ui.colors.line or { 0.21, 0.23, 0.27 }, GX + s * CW, GY, 1, GH)
  end

  -- notes
  for _, n in ipairs(list) do
    local r = top - n.p
    local x, w = GX + n.s * CW + 1, n.l * CW - 2
    if r < 0 then
      ui.rect(col, x, GY - 4, w, 3)
    elseif r >= ROWS then
      ui.rect(col, x, GY + GH + 1, w, 3)
    else
      local y = GY + r * RH
      ui.rect(col, x, y, w, RH - 1, 2, 0.45 + 0.55 * n.v)
      ui.frame({ 0, 0, 0 }, x, y, w, RH - 1, 2, 0.4)
      if w > 30 then ui.text(U.noteName(n.p), x + 3, y - 1, { 0.08, 0.08, 0.08 }, ui.fonts.small) end
    end
  end

  -- note editing
  local function cell()
    local s = U.clamp(math.floor((ui.mx - GX) / CW), 0, 15)
    local pitch = U.clamp(top - math.floor((ui.my - GY) / RH), 0, 127)
    return s, pitch
  end
  if ui.hover(GX, GY, GW, GH) then
    local s, pitch = cell()
    local n = noteAt(list, s, pitch)
    if ui.pressed[1] then
      ui.edit()
      if n then
        if ui.mx > GX + (n.s + n.l) * CW - 8 then
          PR.drag = { mode = "resize", note = n, lastS = s }
        else
          PR.drag = { mode = "move", note = n, off = s - n.s }
        end
        st.engine:preview(ch, n.p, n.v)
      else
        n = Project.addNote(p, p.current, ch, s, pitch, math.min(PR.lastLen, 16 - s), Project.DEFAULT_VEL)
        PR.drag = { mode = "resize", note = n, lastS = s }
        st.engine:preview(ch, pitch)
      end
      ui.active = "pr"
    elseif ui.pressed[2] then
      ui.edit()
      if n then Project.removeNote(p, p.current, ch, n) end
      PR.drag = { mode = "erase" }
      ui.active = "pr"
    elseif n then
      ui.tooltip = string.format("%s  vel %d%%  len %d/16", U.noteName(n.p), U.round(n.v * 100), n.l)
    else
      ui.tooltip = U.noteName(pitch)
    end
  end
  local d = PR.drag
  if d and ui.active == "pr" and (ui.down[1] or ui.down[2]) then
    local s, pitch = cell()
    if d.mode == "move" then
      local n = d.note
      if pitch ~= n.p then
        n.p = pitch
        st.engine:preview(ch, pitch, n.v)
      end
      n.s = U.clamp(s - d.off, 0, 16 - n.l)
    elseif d.mode == "resize" then
      if s ~= d.lastS then
        local n = d.note
        d.lastS = s
        n.l = U.clamp(s - n.s + 1, 1, 16 - n.s)
        PR.lastLen = n.l
      end
    elseif d.mode == "erase" and ui.inside(GX, GY, GW, GH) then
      local n = noteAt(list, s, pitch)
      if n then Project.removeNote(p, p.current, ch, n) end
    end
  elseif d and ui.active ~= "pr" then
    PR.drag = nil
  end

  -- playhead
  if st.patPlayStep then
    ui.rect({ 1, 1, 1 }, GX + (st.patPlayStep + st.heardFrac) * CW, GY, 2, GH, 0, 0.7)
  end

  -- velocity lane
  ui.rect({ 0.1, 0.11, 0.13 }, GX, VY, GW, VH, 2)
  ui.text("VEL", KX + 10, VY + 10, ui.colors.dim, ui.fonts.small)
  for _, n in ipairs(list) do
    local bh = n.v * (VH - 4)
    ui.rect(col, GX + n.s * CW + CW / 2 - 3, VY + VH - 2 - bh, 6, bh, 1, 0.9)
  end
  if ui.hover(GX, VY, GW, VH) and ui.pressed[1] then
    ui.edit()
    ui.active = "vel"
  end
  if ui.active == "vel" and ui.down[1] then
    local s = U.clamp(math.floor((ui.mx - GX) / CW), 0, 15)
    local v = U.clamp(1 - (ui.my - VY - 2) / (VH - 4), 0.05, 1)
    for _, n in ipairs(list) do
      if n.s == s then n.v = v end
    end
    ui.tooltip = string.format("Velocity %d%%", U.round(v * 100))
  end
end

return PR
