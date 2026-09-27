import { createVoiceTimeline } from "./voiceTimeline";

// Earlier builds served /onnx scripts as immutable, so browsers can hold stale
// workers for a year. A new query string forces a fresh copy.
export const ONNX_WORKER_VERSION = "2026-09-15";

const SAMPLE_RATE = 16000;
const VAD_INIT_TIMEOUT_MS = 20000;

// Short silence so pauses between words register; EestiASR segments on 1.0 s.
const PACE_VAD_CONFIG = {
  emitVoiceFlags: true,
  sileroVad: { minSilenceDuration: 0.15, minSpeechDuration: 0.1 },
};

interface VoiceFlagsMessage {
  type: "voice_flags";
  generation: number;
  startSample: number;
  windowSize: number;
  flags: Uint8Array;
}

type VadMessage = VoiceFlagsMessage | { type: string; voiceFlags?: boolean };

/**
 * A second VAD that feeds the pace predictor with voice flags on the audio
 * source clock. Alignment still works without it.
 */
export interface PaceVad {
  /** Feed 16 kHz samples that end at `endSec` on the source clock. */
  feed(samples: Float32Array, endSec: number): void;
  /** Start a new timeline with the next fed chunk, for example after a seek. */
  reset(): void;
  voicedSeconds(fromSec: number, toSec: number): number;
  dispose(): void;
}

export function createPaceVad(onAvailability: (available: boolean) => void): PaceVad {
  const worker = new Worker(`/onnx/vad-worker.js?v=${ONNX_WORKER_VERSION}`);
  const timeline = createVoiceTimeline(SAMPLE_RATE);
  let isReady = false;
  let generation = 0;
  let needsReset = true;

  // A worker that fails to load or never reports in leaves pace unavailable
  // instead of waiting for a measurement forever.
  const initTimeout = window.setTimeout(() => {
    if (!isReady) onAvailability(false);
  }, VAD_INIT_TIMEOUT_MS);

  worker.onerror = () => onAvailability(false);
  worker.onmessage = (event: MessageEvent<VadMessage>) => {
    const message = event.data;
    if (message.type === "initialized") {
      window.clearTimeout(initTimeout);
      isReady = "voiceFlags" in message && message.voiceFlags === true;
      onAvailability(isReady);
      return;
    }
    if (message.type === "error") {
      window.clearTimeout(initTimeout);
      onAvailability(false);
      return;
    }
    if (message.type !== "voice_flags") return;
    const flagsMessage = message as VoiceFlagsMessage;
    if (flagsMessage.generation !== generation) return;
    timeline.append(flagsMessage.startSample, flagsMessage.windowSize, flagsMessage.flags);
  };
  worker.postMessage({ type: "init", config: PACE_VAD_CONFIG });

  return {
    feed(samples, endSec) {
      if (!isReady || samples.length === 0) return;
      if (needsReset) {
        generation += 1;
        worker.postMessage({ type: "reset", generation });
        timeline.reset(endSec - samples.length / SAMPLE_RATE);
        needsReset = false;
      }
      const copy = new Float32Array(samples);
      worker.postMessage({ type: "audio", samples: copy }, [copy.buffer]);
    },
    reset() {
      needsReset = true;
    },
    voicedSeconds: (fromSec, toSec) => timeline.voicedSeconds(fromSec, toSec),
    dispose() {
      window.clearTimeout(initTimeout);
      try {
        worker.postMessage({ type: "free" });
        worker.terminate();
      } catch {
        // Ignore worker teardown errors.
      }
    },
  };
}
