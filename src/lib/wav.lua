-- Minimal RIFF/WAVE writer for 16-bit PCM SoundData.
local W = {}

-- Returns the complete .wav file as a string. `frames` may trim the output.
function W.encode(sd, frames)
  local ch = sd:getChannelCount()
  local sr = sd:getSampleRate()
  local bits = sd:getBitDepth()
  local blockAlign = ch * bits / 8
  frames = math.min(frames or sd:getSampleCount(), sd:getSampleCount())
  local pcm = sd:getString():sub(1, frames * blockAlign)
  local header = love.data.pack("string", "<c4I4c4c4I4I2I2I4I4I2I2c4I4",
    "RIFF", 36 + #pcm, "WAVE",
    "fmt ", 16, 1, ch, sr, sr * blockAlign, blockAlign, bits,
    "data", #pcm)
  return header .. pcm
end

return W
