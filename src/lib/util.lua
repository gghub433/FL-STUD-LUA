-- Small helpers shared by the engine and the UI.
local U = {}

function U.clamp(x, a, b)
  if x < a then return a elseif x > b then return b end
  return x
end

function U.round(x)
  return math.floor(x + 0.5)
end

local NAMES = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" }

-- MIDI note number -> "C4" style name (MIDI 60 = C4).
function U.noteName(p)
  return NAMES[p % 12 + 1] .. tostring(math.floor(p / 12) - 1)
end

function U.isBlack(p)
  local n = p % 12
  return n == 1 or n == 3 or n == 6 or n == 8 or n == 10
end

-- h, s, v in 0..1 -> r, g, b in 0..1
function U.hsv(h, s, v)
  h = (h % 1) * 6
  local i = math.floor(h)
  local f = h - i
  local p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
  if i == 0 then return v, t, p
  elseif i == 1 then return q, v, p
  elseif i == 2 then return p, v, t
  elseif i == 3 then return p, q, v
  elseif i == 4 then return t, p, v
  end
  return v, p, q
end

function U.deepcopy(t)
  if type(t) ~= "table" then return t end
  local r = {}
  for k, v in pairs(t) do r[U.deepcopy(k)] = U.deepcopy(v) end
  return r
end

function U.timestamp()
  return os.date("%Y%m%d_%H%M%S")
end

return U
