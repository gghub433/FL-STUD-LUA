-- Headless modes (--selftest, --export) run without window, graphics and audio.
local headless = false
if arg then
  for _, a in pairs(arg) do
    if a == "--selftest" or a == "--export" then headless = true end
  end
end

function love.conf(t)
  t.identity = "LuaLoops"
  t.version = "11.5"
  t.console = false
  t.window.title = "LuaLoops - free pattern beat maker"
  t.window.width = 1280
  t.window.height = 760
  t.window.minwidth = 800
  t.window.minheight = 475
  t.window.resizable = true
  t.window.vsync = 1
  t.modules.joystick = false
  t.modules.physics = false
  t.modules.video = false
  t.modules.touch = false
  if headless then
    t.window = false
    t.modules.window = false
    t.modules.graphics = false
    t.modules.audio = false
    t.modules.font = false
    t.modules.image = false
  end
end
