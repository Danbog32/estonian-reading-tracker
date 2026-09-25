import {
  INITIAL_ALIGNMENT_STATE,
  alignTranscriptToReference,
  getTranscriptWords,
  getWordSimilarity,
} from "./alignment";
import type { AlignmentMode, AlignmentState, ReferenceWord } from "./alignment";
import { buildAsrWordEvidence } from "./asrEvidence";
import {
  INITIAL_PROBABILISTIC_ALIGNMENT_STATE,
  alignTranscriptProbabilistically,
} from "./probabilisticAlignment";
import type {
  ProbabilisticAlignmentSignal,
  ProbabilisticAlignmentState,
} from "./probabilisticAlignment";

export interface TimingAwareAlignmentSignal extends ProbabilisticAlignmentSignal {
  sourceTimeSec?: number | null;
  tokens?: string[] | null;
  tokenTimestamps?: number[] | null;
  tokenSourceTimestamps?: number[] | null;
  tokenLogProbabilities?: number[] | null;
  combinedTranscriptText?: string;
}

export interface TimingAwareAlignmentState
  extends ProbabilisticAlignmentState {
  latestWordConfidence: number | null;
  latestTokenAgeSec: number | null;
  localState: AlignmentState;
  lastLocalTranscript: string;
  lastLocalUtteranceId: string | null;
  lastLocalSignalType: ProbabilisticAlignmentSignal["type"];
  lastReferenceSignature: string;
}

export const INITIAL_TIMING_AWARE_ALIGNMENT_STATE: TimingAwareAlignmentState = {
  ...INITIAL_PROBABILISTIC_ALIGNMENT_STATE,
  latestWordConfidence: null,
  latestTokenAgeSec: null,
  localState: INITIAL_ALIGNMENT_STATE,
  lastLocalTranscript: "",
  lastLocalUtteranceId: null,
  lastLocalSignalType: "idle",
  lastReferenceSignature: "",
};

function getCompletionProbabilities(
  signal: TimingAwareAlignmentSignal,
  latestWordConfidence: number | null,
  latestTokenAgeSec: number | null,
) {
  if (signal.type === "final") {
    return {
      exactCompletionProbability: 0.88,
      fuzzyCompletionProbability: 0.72,
      partialCompletionProbability: 0.16,
      finalCompletionBonus: 0.08,
    };
  }

  if (latestTokenAgeSec === null) {
    return {};
  }

  const confidence = latestWordConfidence ?? 0;
  if (latestTokenAgeSec <= 0.32) {
    return {
      exactCompletionProbability: 0.12,
      fuzzyCompletionProbability: 0.05,
      partialCompletionProbability: 0.01,
      finalCompletionBonus: 0,
    };
  }

  if (latestTokenAgeSec <= 0.68) {
    return {
      exactCompletionProbability: confidence >= 0.55 ? 0.48 : 0.24,
      fuzzyCompletionProbability: confidence >= 0.45 ? 0.24 : 0.1,
      partialCompletionProbability: 0.02,
      finalCompletionBonus: 0,
    };
  }

  return {
    exactCompletionProbability: confidence >= 0.55 ? 0.76 : 0.52,
    fuzzyCompletionProbability: confidence >= 0.4 ? 0.52 : 0.3,
    partialCompletionProbability: 0.04,
    finalCompletionBonus: 0,
  };
}

export function alignTranscriptWithTiming(
  referenceWords: ReferenceWord[],
  transcriptText: string,
  previousState: TimingAwareAlignmentState,
  signal: TimingAwareAlignmentSignal = {},
): TimingAwareAlignmentState {
  const wordEvidence = buildAsrWordEvidence(signal);
  const latestWord = wordEvidence.at(-1);
  const tokenSourceTimestamps = signal.tokenSourceTimestamps ?? [];
  const latestTokenTimestamp = tokenSourceTimestamps.at(-1);
  const latestTokenAgeSec =
    typeof signal.sourceTimeSec === "number" &&
    typeof latestTokenTimestamp === "number"
      ? Math.max(0, signal.sourceTimeSec - latestTokenTimestamp)
      : null;
  const latestWordConfidence = latestWord?.confidence ?? null;
  const nextState = alignTranscriptProbabilistically(
    referenceWords,
    transcriptText,
    previousState,
    signal,
    getCompletionProbabilities(
      signal,
      latestWordConfidence,
      latestTokenAgeSec,
    ),
  );
  const localTranscript = signal.combinedTranscriptText ?? transcriptText;
  const localUtteranceId = signal.utteranceId ?? null;
  const referenceSignature = referenceWords
    .map((word) => word.normalized)
    .join("\u0001");
  const shouldUpdateLocal =
    localTranscript !== previousState.lastLocalTranscript ||
    localUtteranceId !== previousState.lastLocalUtteranceId ||
    signal.type !== previousState.lastLocalSignalType ||
    referenceSignature !== previousState.lastReferenceSignature;
  const localState = shouldUpdateLocal
    ? alignTranscriptToReference(
        referenceWords,
        localTranscript,
        previousState.localState,
        signal,
      )
    : previousState.localState;
  const probableIndex = nextState.currentWordIndex;
  const localIndex = localState.currentWordIndex;
  const probableWord = referenceWords[probableIndex]?.normalized ?? "";
  const latestSimilarity = latestWord
    ? getWordSimilarity(latestWord.word, probableWord)
    : 1;
  const shouldGuardFuzzyAdvance =
    signal.type === "partial" &&
    getTranscriptWords(transcriptText).length >= 2 &&
    localIndex === probableIndex + 2 &&
    nextState.confidence >= 0.35 &&
    latestSimilarity < 0.9 &&
    (latestWordConfidence ?? 1) < 0.58;

  return {
    ...nextState,
    currentWordIndex: shouldGuardFuzzyAdvance ? probableIndex : localIndex,
    confidence: shouldGuardFuzzyAdvance
      ? Math.max(nextState.confidence, latestSimilarity)
      : localState.confidence,
    matchedPhrase: shouldGuardFuzzyAdvance
      ? referenceWords[probableIndex]?.display.trim() ?? nextState.matchedPhrase
      : localState.matchedPhrase,
    hasLock: shouldGuardFuzzyAdvance ? nextState.hasLock : localState.hasLock,
    mode: shouldGuardFuzzyAdvance ? nextState.mode : localState.mode,
    latestWordConfidence,
    latestTokenAgeSec,
    localState,
    lastLocalTranscript: localTranscript,
    lastLocalUtteranceId: localUtteranceId,
    lastLocalSignalType: signal.type,
    lastReferenceSignature: referenceSignature,
  };
}

export function getTimingAwareMode(
  state: TimingAwareAlignmentState,
): AlignmentMode {
  return state.mode;
}
