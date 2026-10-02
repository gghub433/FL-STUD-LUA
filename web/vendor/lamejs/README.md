# lamejs (vendored)

`lame.min.js` is [lamejs](https://github.com/zhuker/lamejs) 1.2.1, a JavaScript port of the LAME MP3 encoder
(<https://lame.sourceforge.net>), licensed under the **LGPL** (see `LICENSE`).

FL LUA loads it as a separate script, only when you export MP3, and does not modify it. To use another
version, replace this file with any build that exposes `lamejs.Mp3Encoder`.
