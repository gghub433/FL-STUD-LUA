-- UI smoke test: drives the real app with scripted mouse/keyboard input and
-- fails on any Lua error. Run (needs a display, e.g. xvfb-run):
--   love tests/ui_smoke [screenshot.png]
local SRC = love.filesystem.getSource():gsub("[/\\]tests[/\\]ui_smoke[/\\]?$", "") .. "/src"
package.path = SRC .. "/?.lua;" .. package.path
dofile(SRC .. "/main.lua")

local ui = require("lib.ui")
local app = { load = love.load, draw = love.draw }
local frame, shotPath = 0, nil
local steps, stepIndex, wait = {}, 1, 0
local checks = 0

local function fail(msg)
  print("UI SMOKE FAIL: " .. tostring(msg))
  love.event.quit(1)
end

function love.errorhandler(msg)
  print("UI SMOKE ERROR: " .. tostring(msg))
  print(debug.traceback())
  os.exit(1)
end

local function add(fn) steps[#steps + 1] = fn end
local function moveTo(x, y) add(function() love.mouse.setPosition(x, y) end) end
local function press(b) add(function() love.mousepressed(love.mouse.getX(), love.mouse.getY(), b or 1) end) end
local function release(b) add(function() love.mousereleased(love.mouse.getX(), love.mouse.getY(), b or 1) end) end
local function click(x, y, b) moveTo(x, y); press(b); release(b) end
local function key(k) add(function() love.keypressed(k, k, false) end) end
local function wheel(dy) add(function() love.wheelmoved(0, dy) end) end
local function check(desc, fn)
  add(function()
    checks = checks + 1
    if not fn() then fail(desc) end
  end)
end
local function clickMenuItem(label)
  add(function()
    local m = ui.menu
    if not m then return fail("menu not open for " .. label) end
    for i, it in ipairs(m.items) do
      if it.label:find(label, 1, true) then
        love.mouse.setPosition(m.x + 20, m.y + 22 + (i - 1) * 22 + 10)
        return
      end
    end
    fail("menu item not found: " .. label)
  end)
  press(1)
  release(1)
end

-- helpers to peek at app state through the shared modules
local Project = require("lib.project")
local project
local function P() return project() end

function love.load(args)
  shotPath = args and args[1]
  app.load({ "--demo" })
  -- find the app state table (first upvalue named "st" of love.draw)
  local i = 1
  while true do
    local name, val = debug.getupvalue(app.draw, i)
    if not name then break end
    if name == "st" then project = function() return val.project end; app.st = val end
    i = i + 1
  end
  if not project then error("cannot reach app state") end
end

-- The script ---------------------------------------------------------------
-- Channel Rack: toggle kick step 2, paint snare steps 1..5 by dragging
click(239, 109)
check("kick step 2 added", function() return Project.hasStep(P(), 1, P().channels[1], 1) end)
moveTo(212, 169); press(1)
moveTo(260, 169); moveTo(290, 169); moveTo(320, 169)
release(1)
check("snare drag painted", function()
  local n = 0
  for s = 0, 4 do if Project.hasStep(P(), 1, P().channels[3], s) then n = n + 1 end end
  return n == 5
end)
moveTo(212, 169); wheel(-3)
check("velocity changed", function()
  local _, note = Project.hasStep(P(), 1, P().channels[3], 0)
  return note and note.v < Project.DEFAULT_VEL
end)
-- mute / solo LED, knob drag
click(28, 109)
check("kick muted", function() return P().channels[1].mute end)
click(28, 109)
click(28, 139, 2)
check("clap solo", function() return P().channels[2].solo end)
click(28, 139, 2)
moveTo(80, 109); press(1); moveTo(80, 80); release(1)
check("kick volume knob", function() return P().channels[1].vol > 0.78 end)

-- Piano Roll: select Bass, draw a long note, move it, delete it
click(140, 289)
check("bass selected", function() return app.st.selected == 7 end)
moveTo(824, 191); press(1); moveTo(870, 191); moveTo(900, 191); release(1)
check("bass note drawn with length", function()
  local list = P().patterns[1].notes[P().channels[7].id]
  return list and #list == 1 and list[1].l >= 3
end)
moveTo(830, 191); press(1); moveTo(830, 167); moveTo(870, 167); release(1)
check("note moved", function()
  local n = P().patterns[1].notes[P().channels[7].id][1]
  return n.s == 4 and n.p ~= nil
end)
moveTo(880, 410); press(1); moveTo(880, 416); release(1)
moveTo(870, 167); press(2); release(2)
check("note deleted", function() return #P().patterns[1].notes[P().channels[7].id] == 0 end)
moveTo(900, 250); wheel(2)
click(1226, 99)      -- Oct +
click(1103, 99)      -- length +

-- channel context menu: change instrument, then add a channel
click(140, 259, 2)
clickMenuItem("Change instrument")
clickMenuItem("808")
check("tom became 808", function() return P().channels[6].inst == "sub808" end)
click(76, 412)
clickMenuItem("Pad")
check("pad channel added", function() return P().channels[#P().channels].inst == "pad" end)
key("z")             -- computer keyboard piano

-- pattern menu + rename
click(610, 26)
clickMenuItem("Rename current pattern")
add(function() love.textinput("!") end)
key("return")
check("pattern renamed", function() return P().patterns[1].name == "Drums!" end)
key("right"); key("3"); key("up")
check("pattern 3 selected", function() return P().current == 3 end)
click(731, 26)       -- Clone
check("cloned into 5", function() return P().current == 5 end)
click(787, 26)       -- Clear

-- Playlist: paint pattern on track 4, erase one bar, mute a track, set start
moveTo(118, 598); press(1); moveTo(190, 598); moveTo(262, 598); release(1)
check("playlist painted without gaps", function()
  for b = 0, 4 do if P().playlist[4][b] ~= 5 then return false end end
  return true
end)
click(190, 598, 2)
check("playlist erased", function() return P().playlist[4][2] == nil end)
click(50, 598)
check("track muted", function() return P().trackMute[4] end)
click(262, 476)
check("start bar set", function() return app.st.songStart == 4 end)

-- transport, tempo, modes
key("space"); key("l"); key("l"); key("space")
moveTo(306, 24); press(1); moveTo(306, 4); release(1)
click(1182, 26)      -- Undo
key("f1"); click(640, 400)
check("help closed", function() return not app.st.help end)

-- files: save, load menu -> demo, export
click(974, 26)
check("saved", function() return app.st.filename ~= nil end)
click(920, 26)
clickMenuItem("Demo project")
check("demo loaded", function() return P().patterns[1].name == "Drums" end)
click(1050, 26)
key("space")
for _ = 1, 20 do add(function() end) end

function love.draw()
  app.draw()
  frame = frame + 1
  if frame < 10 then return end
  if wait > 0 then wait = wait - 1 return end
  local fn = steps[stepIndex]
  if fn then
    fn()
    stepIndex = stepIndex + 1
    wait = 1
  elseif not app.done then
    app.done = true
    print(string.format("UI SMOKE PASS: %d steps, %d checks", #steps, checks))
    if shotPath then
      love.graphics.captureScreenshot(function(img)
        local f = io.open(shotPath, "wb")
        if f then f:write(img:encode("png"):getString()); f:close() end
        love.event.quit(0)
      end)
    else
      love.event.quit(0)
    end
  end
end
