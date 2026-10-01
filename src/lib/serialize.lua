-- Plain-data (de)serialization of Lua tables. Files are Lua table literals
-- executed in an empty environment; bytecode is rejected.
local M = {}

local RESERVED = {}
for w in ([[and break do else elseif end false for function goto if in local nil not
            or repeat return then true until while]]):gmatch("%a+") do
  RESERVED[w] = true
end

local function write(v, out)
  local t = type(v)
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then
      out[#out + 1] = "0"
    else
      out[#out + 1] = string.format("%.10g", v)
    end
  elseif t == "string" then
    out[#out + 1] = string.format("%q", v)
  elseif t == "boolean" then
    out[#out + 1] = tostring(v)
  elseif t == "table" then
    out[#out + 1] = "{"
    local n = #v
    for i = 1, n do
      write(v[i], out)
      out[#out + 1] = ","
    end
    local keys = {}
    for k in pairs(v) do
      local isArray = type(k) == "number" and k >= 1 and k <= n and k % 1 == 0
      if not isArray and (type(k) == "number" or type(k) == "string") then
        keys[#keys + 1] = k
      end
    end
    table.sort(keys, function(a, b)
      if type(a) == type(b) then return a < b end
      return type(a) == "number"
    end)
    for _, k in ipairs(keys) do
      if type(k) == "string" and k:match("^[%a_][%w_]*$") and not RESERVED[k] then
        out[#out + 1] = k .. "="
      else
        out[#out + 1] = "["
        write(k, out)
        out[#out + 1] = "]="
      end
      write(v[k], out)
      out[#out + 1] = ","
    end
    out[#out + 1] = "}"
  else
    out[#out + 1] = "nil"
  end
end

function M.encode(v)
  local out = {}
  write(v, out)
  return table.concat(out)
end

function M.decode(s)
  if type(s) ~= "string" or #s == 0 then return nil, "empty file" end
  if s:byte(1) == 27 then return nil, "binary chunks are not allowed" end
  local f, err = loadstring("return " .. s, "=project")
  if not f then return nil, err end
  setfenv(f, {})
  local ok, res = pcall(f)
  if not ok then return nil, res end
  return res
end

return M
