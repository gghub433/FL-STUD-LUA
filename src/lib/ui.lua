-- Tiny immediate-mode GUI. Everything is drawn in a fixed virtual canvas
-- (ui.W x ui.H) that is scaled to fit the window.
local U = require("lib.util")

local ui = {
  W = 1280, H = 760,
  scale = 1, ox = 0, oy = 0,
  mx = 0, my = 0,
  down = {}, pressed = {}, released = {},
  wheel = 0,
  active = nil,      -- id of the widget currently dragged
  blocked = false,   -- input captured by an overlay this frame
  tooltip = nil,
  onEdit = nil,      -- callback fired before a widget changes project data
}

ui.colors = {
  bg       = { 0.11, 0.12, 0.14 },
  panel    = { 0.16, 0.18, 0.21 },
  header   = { 0.21, 0.23, 0.27 },
  line     = { 0.27, 0.30, 0.35 },
  text     = { 0.86, 0.88, 0.91 },
  dim      = { 0.55, 0.59, 0.65 },
  accent   = { 1.00, 0.62, 0.20 },
  green    = { 0.45, 0.85, 0.40 },
  red      = { 0.95, 0.35, 0.30 },
  yellow   = { 0.98, 0.85, 0.30 },
  stepOff1 = { 0.24, 0.27, 0.31 },
  stepOff2 = { 0.30, 0.33, 0.38 },
  button   = { 0.25, 0.28, 0.33 },
  buttonHi = { 0.32, 0.36, 0.42 },
}

function ui.load()
  local g = love.graphics
  ui.fonts = {
    small = g.newFont(10),
    normal = g.newFont(12),
    big = g.newFont(15),
    title = g.newFont(20),
  }
end

function ui.setColor(c, a)
  love.graphics.setColor(c[1], c[2], c[3], a or c[4] or 1)
end

function ui.resize(w, h)
  ui.scale = math.min(w / ui.W, h / ui.H)
  ui.ox = math.floor((w - ui.W * ui.scale) / 2)
  ui.oy = math.floor((h - ui.H * ui.scale) / 2)
end

function ui.toVirtual(x, y)
  return (x - ui.ox) / ui.scale, (y - ui.oy) / ui.scale
end

function ui.mousepressed(_, _, b)
  ui.pressed[b] = true
  ui.down[b] = true
end

function ui.mousereleased(_, _, b)
  ui.released[b] = true
  ui.down[b] = false
end

function ui.wheelmoved(_, dy)
  ui.wheel = ui.wheel + dy
end

function ui.beginFrame()
  ui.mx, ui.my = ui.toVirtual(love.mouse.getPosition())
  ui.tooltip = nil
end

function ui.endFrame()
  ui.pressed, ui.released = {}, {}
  ui.wheel = 0
  ui.blocked = false
  if not ui.down[1] and not ui.down[2] then ui.active = nil end
end

function ui.inside(x, y, w, h)
  return ui.mx >= x and ui.mx < x + w and ui.my >= y and ui.my < y + h
end

-- True when the widget at (x,y,w,h) may react to the mouse this frame.
function ui.hover(x, y, w, h)
  return not ui.blocked and ui.active == nil and ui.inside(x, y, w, h)
end

-- coalesce = true for continuous edits (mouse wheel) so undo is not flooded.
function ui.edit(coalesce)
  if ui.onEdit then ui.onEdit(coalesce) end
end

function ui.shift()
  return love.keyboard.isDown("lshift", "rshift")
end

function ui.ctrl()
  return love.keyboard.isDown("lctrl", "rctrl", "lgui", "rgui")
end

----------------------------------------------------------------------------
-- Drawing helpers
----------------------------------------------------------------------------
function ui.rect(c, x, y, w, h, r, a)
  ui.setColor(c, a)
  love.graphics.rectangle("fill", x, y, w, h, r or 0, r or 0)
end

function ui.frame(c, x, y, w, h, r, a)
  ui.setColor(c, a)
  love.graphics.rectangle("line", x + 0.5, y + 0.5, w - 1, h - 1, r or 0, r or 0)
end

function ui.text(s, x, y, c, font, a)
  love.graphics.setFont(font or ui.fonts.normal)
  ui.setColor(c or ui.colors.text, a)
  love.graphics.print(s, math.floor(x), math.floor(y))
end

function ui.textCenter(s, x, y, w, h, c, font)
  font = font or ui.fonts.normal
  love.graphics.setFont(font)
  ui.setColor(c or ui.colors.text)
  local tw = font:getWidth(s)
  love.graphics.print(s, math.floor(x + (w - tw) / 2), math.floor(y + (h - font:getHeight()) / 2))
end

-- Clip text to a pixel width, adding "..".
function ui.fit(s, w, font)
  font = font or ui.fonts.normal
  if font:getWidth(s) <= w then return s end
  while #s > 1 and font:getWidth(s .. "..") > w do s = s:sub(1, -2) end
  return s .. ".."
end

function ui.panel(x, y, w, h, title, right)
  ui.rect(ui.colors.panel, x, y, w, h, 4)
  ui.rect(ui.colors.header, x, y, w, 24, 4)
  ui.rect(ui.colors.header, x, y + 12, w, 12)
  if title then ui.text(title, x + 10, y + 5, ui.colors.text, ui.fonts.normal) end
  if right then
    local f = ui.fonts.small
    ui.text(right, x + w - f:getWidth(right) - 10, y + 7, ui.colors.dim, f)
  end
end

----------------------------------------------------------------------------
-- Widgets
----------------------------------------------------------------------------

-- Returns clicked (LMB), rclicked (RMB), hovered.
function ui.button(x, y, w, h, label, opts)
  opts = opts or {}
  local hov = ui.hover(x, y, w, h)
  local bg = opts.on and (opts.onColor or ui.colors.accent) or (hov and ui.colors.buttonHi or ui.colors.button)
  ui.rect(bg, x, y, w, h, 3)
  if label then
    local tc = opts.on and { 0.1, 0.1, 0.1 } or (opts.textColor or ui.colors.text)
    ui.textCenter(label, x, y, w, h, tc, opts.font)
  end
  if hov and opts.tip then ui.tooltip = opts.tip end
  local clicked = hov and ui.pressed[1] or false
  local rclicked = hov and ui.pressed[2] or false
  return clicked, rclicked, hov
end

-- Rotary knob: vertical drag / wheel changes value, RMB resets.
function ui.knob(id, cx, cy, r, value, vmin, vmax, default, label, fmt, color)
  local range = vmax - vmin
  local hov = ui.hover(cx - r, cy - r, r * 2, r * 2)
  local changed = false
  if hov then
    if ui.pressed[1] then
      ui.edit()
      ui.active = id
      ui.dragY, ui.dragV = ui.my, value
    elseif ui.pressed[2] then
      ui.edit()
      value = default
      changed = true
    elseif ui.wheel ~= 0 then
      ui.edit(true)
      value = U.clamp(value + ui.wheel * range / 40, vmin, vmax)
      changed = true
    end
  end
  if ui.active == id and ui.down[1] then
    local fine = ui.shift() and 0.2 or 1
    value = U.clamp(ui.dragV + (ui.dragY - ui.my) * range / 160 * fine, vmin, vmax)
    changed = true
  end
  if hov or ui.active == id then
    ui.tooltip = label .. ": " .. (fmt and fmt(value) or string.format("%.2f", value))
  end

  local g = love.graphics
  ui.rect(ui.colors.stepOff1, cx - r, cy - r, r * 2, r * 2, r)
  local a0, a1 = math.pi * 0.75, math.pi * 2.25
  local t = (value - vmin) / range
  local bipolar = vmin < 0 and vmax > 0
  local startA = bipolar and math.pi * 1.5 or a0
  local endA = a0 + (a1 - a0) * t
  ui.setColor(color or ui.colors.accent)
  g.setLineWidth(2.5)
  if math.abs(endA - startA) > 0.01 then
    g.arc("line", "open", cx, cy, r - 2, math.min(startA, endA), math.max(startA, endA), 16)
  end
  g.setLineWidth(1.5)
  ui.setColor(ui.colors.text)
  g.line(cx, cy, cx + math.cos(endA) * (r - 3), cy + math.sin(endA) * (r - 3))
  g.setLineWidth(1)
  return value, changed
end

-- Numeric field dragged vertically (e.g. tempo).
function ui.dragNumber(id, x, y, w, h, value, vmin, vmax, default, fmt, tip)
  local hov = ui.hover(x, y, w, h)
  if hov then
    if ui.pressed[1] then
      ui.edit()
      ui.active = id
      ui.dragY, ui.dragV = ui.my, value
    elseif ui.pressed[2] then
      ui.edit()
      value = default
    elseif ui.wheel ~= 0 then
      ui.edit(true)
      value = U.clamp(value + ui.wheel, vmin, vmax)
    end
    ui.tooltip = tip
  end
  if ui.active == id and ui.down[1] then
    local speed = ui.shift() and 0.05 or 0.25
    value = U.clamp(U.round(ui.dragV + (ui.dragY - ui.my) * speed), vmin, vmax)
  end
  ui.rect({ 0.07, 0.08, 0.09 }, x, y, w, h, 3)
  ui.frame((hov or ui.active == id) and ui.colors.accent or ui.colors.line, x, y, w, h, 3)
  ui.textCenter(fmt(value), x, y, w, h, ui.colors.accent, ui.fonts.big)
  return value
end

function ui.drawTooltip()
  if not ui.tooltip then return end
  local f = ui.fonts.small
  local w = f:getWidth(ui.tooltip) + 10
  local x = math.min(ui.mx + 14, ui.W - w - 4)
  local y = math.min(ui.my + 16, ui.H - 22)
  ui.rect({ 0.05, 0.05, 0.06 }, x, y, w, 18, 3, 0.92)
  ui.text(ui.tooltip, x + 5, y + 3, ui.colors.text, f)
end

----------------------------------------------------------------------------
-- Popup menu (context menus, load list, instrument picker)
----------------------------------------------------------------------------
ui.menu = nil

-- items: { {label=..., fn=function() end, color=...}, ... }
function ui.openMenu(x, y, items, title)
  local f = ui.fonts.normal
  local w = 150
  for _, it in ipairs(items) do w = math.max(w, f:getWidth(it.label) + 24) end
  if title then w = math.max(w, f:getWidth(title) + 24) end
  local h = #items * 22 + (title and 24 or 4)
  ui.menu = {
    x = math.min(x, ui.W - w - 4), y = math.min(y, ui.H - h - 4),
    w = w, h = h, items = items, title = title,
  }
end

-- Must run before the regular widgets so the menu captures the click.
function ui.menuInput()
  local m = ui.menu
  if not m then return end
  if ui.pressed[1] or ui.pressed[2] then
    if ui.inside(m.x, m.y, m.w, m.h) then
      local top = m.y + (m.title and 22 or 2)
      local i = math.floor((ui.my - top) / 22) + 1
      local it = m.items[i]
      if it and ui.pressed[1] then
        ui.menu = nil
        if it.fn then it.fn() end
      end
    else
      ui.menu = nil
    end
    ui.blocked = true
  end
end

function ui.drawMenu()
  local m = ui.menu
  if not m then return end
  ui.rect({ 0, 0, 0 }, m.x + 3, m.y + 3, m.w, m.h, 4, 0.35)
  ui.rect({ 0.19, 0.21, 0.25 }, m.x, m.y, m.w, m.h, 4)
  ui.frame(ui.colors.line, m.x, m.y, m.w, m.h, 4)
  local top = m.y + 2
  if m.title then
    ui.text(m.title, m.x + 10, m.y + 4, ui.colors.dim, ui.fonts.small)
    top = m.y + 22
  end
  for i, it in ipairs(m.items) do
    local iy = top + (i - 1) * 22
    if ui.inside(m.x, iy, m.w, 22) then ui.rect(ui.colors.buttonHi, m.x + 2, iy, m.w - 4, 22, 3) end
    ui.text(it.label, m.x + 12, iy + 4, it.color or ui.colors.text)
  end
end

return ui
