"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReferenceWord } from "./alignment";
import {
  ASR_TOKEN_LATENCY_SEC,
  INITIAL_PACE_PREDICTOR_STATE,
  predictReadingPosition,
} from "./pacePredictor";
import type { PacePredictorState } from "./pacePredictor";
import { createPaceVad } from "./paceVad";
import type { PaceVad } from "./paceVad";
import type { TimingAwareAlignmentState } from "./timingAwareAlignment";
import type { AsrEventPayload } from "./types";

interface MicAudioDetail {
  samples: Float32Array;
  /** End of the chunk on the microphone clock, which the ASR token times share. */
  sourceTimeSec: number;
}

interface UseMicPacePredictorArgs {
  referenceWords: ReferenceWord[];
  alignment: TimingAwareAlignmentState;
  asrEvent: AsrEventPayload;
  isRecording: boolean;
  enabled: boolean;
}

/** Pace prediction for live microphone input, fed by the `micAudio` events app-asr.js sends. */
export function useMicPacePredictor({
  referenceWords,
  alignment,
  asrEvent,
  isRecording,
  enabled,
}: UseMicPacePredictorArgs) {
  const paceVadRef = useRef<PaceVad | null>(null);
  const clockSecRef = useRef(0);
  const paceRef = useRef<PacePredictorState>(INITIAL_PACE_PREDICTOR_STATE);
  const [pace, setPace] = useState<PacePredictorState>(INITIAL_PACE_PREDICTOR_STATE);
  // null until the VAD worker reports in; false when it cannot send voice flags.
  const [isPaceAvailable, setIsPaceAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    const paceVad = createPaceVad(setIsPaceAvailable);
    paceVadRef.current = paceVad;
    const handleMicAudio = (event: Event) => {
      const { samples, sourceTimeSec } = (event as CustomEvent<MicAudioDetail>).detail;
      clockSecRef.current = sourceTimeSec;
      paceVad.feed(samples, sourceTimeSec);
    };
    window.addEventListener("micAudio", handleMicAudio);
    return () => {
      window.removeEventListener("micAudio", handleMicAudio);
      paceVad.dispose();
      paceVadRef.current = null;
    };
  }, []);

  const update = useCallback(() => {
    const nextPace = predictReadingPosition(paceRef.current, {
      referenceWords,
      matcherIndex: alignment.currentWordIndex,
      matcherHasLock: alignment.hasLock,
      nowSec: clockSecRef.current,
      evidence:
        asrEvent.type === "partial" || asrEvent.type === "final"
          ? {
              tokens: asrEvent.tokens,
              tokenTimestamps: asrEvent.tokenTimestamps,
              tokenSourceTimestamps: asrEvent.tokenSourceTimestamps,
              tokenLogProbabilities: asrEvent.tokenLogProbabilities,
            }
          : null,
      voicedSeconds: (fromSec, toSec) =>
        paceVadRef.current?.voicedSeconds(fromSec, toSec) ?? 0,
      tokenDelaySec: ASR_TOKEN_LATENCY_SEC,
    });
    paceRef.current = nextPace;
    setPace(nextPace);
  }, [alignment, asrEvent, referenceWords]);

  useEffect(() => {
    if (enabled) update();
  }, [enabled, update]);

  // Voiced time keeps growing between ASR events, so the projection advances on a tick.
  useEffect(() => {
    if (!enabled || !isRecording) return;
    const interval = window.setInterval(update, 100);
    return () => window.clearInterval(interval);
  }, [enabled, isRecording, update]);

  const reset = useCallback(() => {
    paceVadRef.current?.reset();
    clockSecRef.current = 0;
    paceRef.current = INITIAL_PACE_PREDICTOR_STATE;
    setPace(INITIAL_PACE_PREDICTOR_STATE);
  }, []);

  return { pace, isPaceAvailable, reset };
}
