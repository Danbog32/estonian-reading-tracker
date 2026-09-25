/**
 * Voice flags from VAD, one per window, placed on the audio source clock.
 * Answers how many seconds of voice were heard between two moments, counting
 * only windows that have been reported.
 */
export interface VoiceTimeline {
  /** Start over at a source time, for example after a seek. */
  reset(baseSourceSec: number): void;
  /** Add flags for windows starting at a sample offset from the last reset. */
  append(startSample: number, windowSize: number, flags: ArrayLike<number>): void;
  voicedSeconds(fromSec: number, toSec: number): number;
}

export function createVoiceTimeline(sampleRate = 16000): VoiceTimeline {
  let baseSourceSec = 0;
  let windowSec = 0;
  // voicedBefore[index] is the voiced time in all windows before that index.
  let voicedBefore: number[] = [0];

  return {
    reset(nextBaseSourceSec) {
      baseSourceSec = nextBaseSourceSec;
      windowSec = 0;
      voicedBefore = [0];
    },

    append(startSample, windowSize, flags) {
      windowSec = windowSize / sampleRate;
      const firstIndex = Math.round(startSample / windowSize);
      // Fill any gap with silence so later windows stay on the right clock.
      while (voicedBefore.length - 1 < firstIndex) {
        voicedBefore.push(voicedBefore[voicedBefore.length - 1]);
      }
      if (voicedBefore.length - 1 > firstIndex) return;
      for (let index = 0; index < flags.length; index += 1) {
        voicedBefore.push(voicedBefore[voicedBefore.length - 1] + (flags[index] ? windowSec : 0));
      }
    },

    voicedSeconds(fromSec, toSec) {
      if (windowSec === 0 || toSec <= fromSec) return 0;
      const knownWindows = voicedBefore.length - 1;
      const firstWindow = Math.max(0, Math.ceil((fromSec - baseSourceSec) / windowSec - 1e-9));
      const endWindow = Math.min(
        knownWindows,
        Math.floor((toSec - baseSourceSec) / windowSec + 1e-9),
      );
      if (endWindow <= firstWindow) return 0;
      return voicedBefore[endWindow] - voicedBefore[firstWindow];
    },
  };
}
