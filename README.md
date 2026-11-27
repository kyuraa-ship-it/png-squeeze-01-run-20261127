# png-squeeze — smallest lossless PNG for screenshots

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/kyuraa-ship-it/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/kyuraa-ship-it/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

One program that re-encodes 1280x720 RGBA screenshots as the smallest lossless PNG it can: it screens every lossless form the image admits (palette by count / by luminance, grey, grey+alpha, RGB, RGBA, plus a tRNS key instead of an alpha channel when every transparent pixel shares one value), each under several per-row filter choices (fixed filters, minimum-sum-of-signed-bytes, fewest-distinct-byte-pairs, and brute-force per-row deflate trials), and writes the winner with the smallest of two zlib level-9 streams. Deterministic: two runs write identical bytes.

## Run it

```
node main.ts
```

Reads `/input/<id>/image.png` and writes `/output/<id>/image.png` for every instance. `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override the paths locally.

Entered on [make.fun](https://make.fun/?ref=g0wb6g14&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
