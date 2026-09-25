# Estonian Reading Tracker

A web application that follows a child reading Estonian aloud and highlights the
word being read. Speech recognition and voice activity detection both run as
WebAssembly inside the browser, so no audio leaves the device.

The tracker combines a dynamic-programming matcher over the streaming ASR
transcript with a pace-prediction layer that estimates the reader's speed and
carries the highlight forward, which removes most of the delay inherent in
waiting for the recogniser.

## Running

```bash
npm install
npm run dev
```

The tracker is at `/text-alignment`.

## Algorithms

| File | What it does |
| --- | --- |
| `app/text-alignment/alignment.ts` | local DP matcher with phonetic word similarity and confidence gating |
| `app/text-alignment/timingAwareAlignment.ts` | matcher: local DP with a probabilistic guard |
| `app/text-alignment/pacePredictor.ts` | pace-based prediction layer |
| `app/text-alignment/voiceTimeline.ts` | voice activity flags placed on the audio clock |
| `app/text-alignment/probabilisticAlignment.ts` | distribution over positions, used as a guard |

## Tests

```bash
npm run typecheck
npm run test:pace
npm run test:timing
npm run test:probabilistic
```
