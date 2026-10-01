-- Channel Rack: instruments + 16-step sequencer for the current pattern.
local ui = require("lib.ui")
local U = require("lib.util")
local Project = require("lib.project")
local Sounds = require("lib.sounds")

local R = {}

local X, Y, W, H = 10, 56, 640, 376
local ROW_H = 30
local TOP = Y + 30
local VISIBLE = 10
local STEP_X = X + 190
local STEP_PITCH = 27
local STEP_SIZE = 24

R.scroll = 0
R.drag = nil

function R.channelColor(i)
  return { U.hsv(0.07 + (i - 1) * 0.083, 0.55, 0.95) }
end

local function fmtPct(v) return string.format("%d%%", U.round(v * 100)) end
local function fmtPan(v)
  if math.abs(v) < 0.01 then return "C" end
  return string.format("%d%% %s", U.round(math.abs(v) * 100), v < 0 and "L" or "R")
end

function R.ensureVisible(ci)
  if ci <= R.scroll then R.scroll = ci - 1 end
  if ci > R.scroll + VISIBLE then R.scroll = ci - VISIBLE end
end

local function instrumentMenu(st, title, onPick)
  local items = {}
  for _, inst in ipairs(Sounds.order) do
    local def = Sounds.defs[inst]
    items[#items + 1] = {
      label = def.label .. (def.kind == "synth" and "  (synth)" or ""),
      fn = function() onPick(inst) end,
    }
  end
  ui.openMenu(ui.mx, ui.my, items, title)
end

function R.addChannelMenu(st)
  local p = st.project
  if #p.channels >= Project.MAX_CHANNELS then
    st.toast("Channel limit reached (" .. Project.MAX_CHANNELS .. ")")
    return
  end
  instrumentMenu(st, "Add channel", function(inst)
    ui.edit()
    p.channels[#p.channels + 1] = Project.newChannel(p, inst)
    st.selected = #p.channels
    R.ensureVisible(st.selected)
    st.engine:preview(p.channels[st.selected])
  end)
end

function R.openChannelMenu(st, ci)
  local p = st.project
  local ch = p.channels[ci]
  ui.openMenu(ui.mx, ui.my, {
    { label = "Change instrument...", fn = function()
        instrumentMenu(st, "Instrument for " .. ch.name, function(inst)
          ui.edit()
          ch.inst = inst
          ch.name = Sounds.defs[inst].label
          st.engine:preview(ch)
        end)
      end },
    { label = "Duplicate channel", fn = function()
        if #p.channels >= Project.MAX_CHANNELS then return st.toast("Channel limit reached") end
        ui.edit()
        local c = Project.newChannel(p, ch.inst)
        c.name, c.vol, c.pan, c.pitch, c.tone = ch.name, ch.vol, ch.pan, ch.pitch, ch.tone
        table.insert(p.channels, ci + 1, c)
        for _, pat in ipairs(p.patterns) do
          if pat.notes[ch.id] then pat.notes[c.id] = U.deepcopy(pat.notes[ch.id]) end
        end
        st.selected = ci + 1
      end },
    { label = "Move up", fn = function()
        if ci > 1 then
          ui.edit()
          p.channels[ci], p.channels[ci - 1] = p.channels[ci - 1], p.channels[ci]
          st.selected = ci - 1
        end
      end },
    { label = "Move down", fn = function()
        if ci < #p.channels then
          ui.edit()
          p.channels[ci], p.channels[ci + 1] = p.channels[ci + 1], p.channels[ci]
          st.selected = ci + 1
        end
      end },
    { label = "Clear steps in this pattern", fn = function()
        ui.edit()
        p.patterns[p.current].notes[ch.id] = nil
      end },
    { label = "Delete channel", color = ui.colors.red, fn = function()
        ui.edit()
        Project.removeChannel(p, ci)
        st.selected = U.clamp(st.selected, 1, math.max(1, #p.channels))
        R.scroll = U.clamp(R.scroll, 0, math.max(0, #p.channels - VISIBLE))
      end },
  }, ch.name)
end

local function applyStep(st, ch, s, mode)
  local p = st.project
  local has = Project.hasStep(p, p.current, ch, s)
  if mode == "paint" and not has then
    Project.addNote(p, p.current, ch, s, Project.rootPitch(ch), 1, Project.DEFAULT_VEL)
  elseif mode == "erase" and has then
    Project.removeStep(p, p.current, ch, s)
  end
end

function R.draw(st)
  local p = st.project
  local pat = p.patterns[p.current]
  ui.panel(X, Y, W, H, "Channel Rack  -  " .. pat.name,
    "LMB paint/erase  RMB erase  wheel: velocity")
  local n = #p.channels
  R.scroll = U.clamp(R.scroll, 0, math.max(0, n - VISIBLE))

  -- continue a step drag along the row it started in; every step between
  -- the previous and the current mouse position is painted, so fast moves
  -- do not leave gaps
  local d = R.drag
  if d and ui.active == "rack" and (ui.down[1] or ui.down[2]) then
    local ch = p.channels[d.ci]
    if ch then
      local s = U.clamp(math.floor((ui.mx - STEP_X) / STEP_PITCH), 0, 15)
      for k = math.min(d.last, s), math.max(d.last, s) do
        if not d.seen[k] then
          d.seen[k] = true
          applyStep(st, ch, k, d.mode)
        end
      end
      d.last = s
    end
  elseif d and ui.active ~= "rack" then
    R.drag = nil
  end

  -- beat numbers over the steps
  for s = 0, 15 do
    if s % 4 == 0 then
      ui.text(tostring(s / 4 + 1), STEP_X + s * STEP_PITCH + 2, Y + 26, ui.colors.dim, ui.fonts.small)
    end
  end

  for row = 1, math.min(VISIBLE, n - R.scroll) do
    local ci = row + R.scroll
    local ch = p.channels[ci]
    local def = Sounds.defs[ch.inst]
    local y = TOP + (row - 1) * ROW_H + 8
    local col = R.channelColor(ci)
    local sel = st.selected == ci
    if sel then ui.rect(ui.colors.header, X + 4, y, W - 8, ROW_H - 2, 3) end

    -- mute / solo LED
    local c, rc = ui.button(X + 12, y + 9, 12, 12, nil, {
      on = not ch.mute, onColor = ch.solo and ui.colors.yellow or ui.colors.green,
      tip = "LMB: mute   RMB: solo",
    })
    if c then ui.edit(); ch.mute = not ch.mute end
    if rc then ui.edit(); ch.solo = not ch.solo end
    if ch.solo then ui.frame(ui.colors.yellow, X + 9, y + 6, 18, 18, 4) end

    ch.pan = ui.knob("pan" .. ch.id, X + 44, y + 15, 10, ch.pan, -1, 1, 0, "Pan", fmtPan, col)
    ch.vol = ui.knob("vol" .. ch.id, X + 70, y + 15, 10, ch.vol, 0, 1, 0.78, "Volume", fmtPct, col)

    -- channel name button
    local nx, nw = X + 86, 96
    local clicked, rclicked, hov = ui.button(nx, y + 3, nw, STEP_SIZE, nil, {
      tip = def.label .. (def.kind == "synth" and " synth" or " sample") .. "  -  LMB: select + preview, RMB: menu",
    })
    ui.rect(col, nx, y + 3, 4, STEP_SIZE, 2)
    ui.text(ui.fit(ch.name, nw - 12), nx + 9, y + 8, sel and ui.colors.accent or ui.colors.text)
    if clicked then
      st.selected = ci
      st.engine:preview(ch)
    end
    if rclicked then
      st.selected = ci
      R.openChannelMenu(st, ci)
    end
    if hov and ui.wheel ~= 0 then
      R.scroll = U.clamp(R.scroll - ui.wheel, 0, math.max(0, n - VISIBLE))
    end

    -- steps
    local root = def.root
    for s = 0, 15 do
      local sx = STEP_X + s * STEP_PITCH
      local sy = y + 3
      local base = (math.floor(s / 4) % 2 == 0) and ui.colors.stepOff2 or ui.colors.stepOff1
      local has, note = Project.hasStep(p, p.current, ch, s)
      if has then
        ui.rect(base, sx, sy, STEP_SIZE, STEP_SIZE, 3)
        ui.rect(col, sx, sy, STEP_SIZE, STEP_SIZE, 3, 0.35 + 0.65 * note.v)
        if note.l > 1 then
          ui.rect(col, sx + STEP_SIZE - 2, sy + 10, math.min(note.l - 1, 15 - s) * STEP_PITCH + 2, 4, 1, 0.6)
        end
        if note.p ~= root then
          ui.textCenter((U.noteName(note.p)), sx, sy, STEP_SIZE, STEP_SIZE, { 0.1, 0.1, 0.1 }, ui.fonts.small)
        end
      else
        ui.rect(base, sx, sy, STEP_SIZE, STEP_SIZE, 3)
      end
      if st.patPlayStep == s and not ch.mute then
        ui.frame({ 1, 1, 1 }, sx, sy, STEP_SIZE, STEP_SIZE, 3, 0.8)
      end

      if ui.hover(sx, sy, STEP_SIZE, STEP_SIZE) then
        if ui.pressed[1] or ui.pressed[2] then
          ui.edit()
          local mode = (ui.pressed[2] or has) and "erase" or "paint"
          applyStep(st, ch, s, mode)
          if mode == "paint" then st.engine:preview(ch) end
          st.selected = ci
          ui.active = "rack"
          R.drag = { ci = ci, mode = mode, seen = { [s] = true }, last = s }
        elseif ui.wheel ~= 0 and has then
          ui.edit(true)
          local list = Project.notes(p, p.current, ch)
          for _, nt in ipairs(list) do
            if nt.s == s then nt.v = U.clamp(nt.v + ui.wheel * 0.05, 0.05, 1) end
          end
        end
        if has then ui.tooltip = string.format("%s  vel %d%%  len %d", U.noteName(note.p), U.round(note.v * 100), note.l) end
      end
    end
  end

  -- scroll hint + add button
  local by = Y + H - 32
  if n > VISIBLE then
    ui.text(string.format("channels %d-%d of %d (wheel over names to scroll)",
      R.scroll + 1, math.min(n, R.scroll + VISIBLE), n), X + 150, by + 7, ui.colors.dim, ui.fonts.small)
  end
  if ui.button(X + 12, by, 128, 24, "+ Add channel", { tip = "Add an instrument channel" }) then
    R.addChannelMenu(st)
  end
end

return R
