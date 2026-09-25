import { getWordSimilarity, type ReferenceWord } from "./alignment";
import { buildAsrWordEvidence, type AsrTokenEvidenceInput } from "./asrEvidence";

/**
 * Pace predictor, a layer on top of the matcher.
 *
 * The matcher confirms words late, because ASR reports a word only some time
 * after the child starts it. The predictor anchors on the last confirmed word,
 * measures the child's pace in voiced seconds per letter, and spends the voiced
 * time since the anchor started on the expected durations of the following
 * words. Pauses do not count, so the highlight waits while the child is silent.
 *
 * By default the prediction only moves ahead of the matcher, because onsets
 * recovered from ASR tokens are imprecise.
 */

export interface PacePredictorOptions {
  /** Every word costs this many letters on top of its length. */
  overheadLetters: number;
  /** Pace is the median of this many recent words. */
  historySize: number;
  /** Words slower than this multiple of the pace are held words and ignored. */
  heldFactor: number;
  /** Until this many pace samples exist, the matcher position is used. */
  minHistory: number;
  /** The prediction never runs more than this many words past the anchor. */
  maxLeadWords: number;
  /** Voiced time assumed to remain after the last ASR token of the anchor word, in word units. */
  heldTailUnits: number;
  /** Minimum similarity for an ASR word to count as evidence for a reference word. */
  minEvidenceSimilarity: number;
  /** When false, the prediction never sits behind the matcher and only runs ahead of it. */
  allowBehindMatcher: boolean;
}

/**
 * How long the bundled Estonian streaming ASR model takes to emit a token after
 * the sound starts. Re-measure if the model or its chunk size changes.
 */
export const ASR_TOKEN_LATENCY_SEC = 0.51;

export const DEFAULT_PACE_PREDICTOR_OPTIONS: PacePredictorOptions = {
  overheadLetters: 0,
  historySize: 8,
  heldFactor: 2.5,
  minHistory: 2,
  maxLeadWords: 2,
  heldTailUnits: 1,
  minEvidenceSimilarity: 0.56,
  allowBehindMatcher: false,
};

export interface PacePredictorState {
  anchorIndex: number;
  anchorOnsetSec: number | null;
  anchorEvidenceEndSec: number | null;
  paceHistory: number[];
  predictedIndex: number;
  paceSecPerUnit: number | null;
  onsetFallbacks: number;
}

export const INITIAL_PACE_PREDICTOR_STATE: PacePredictorState = {
  anchorIndex: -1,
  anchorOnsetSec: null,
  anchorEvidenceEndSec: null,
  paceHistory: [],
  predictedIndex: 0,
  paceSecPerUnit: null,
  onsetFallbacks: 0,
};

/** Voiced seconds between two points in time, as heard by VAD. */
export type VoicedSecondsFn = (fromSec: number, toSec: number) => number;

export interface PacePredictorInput {
  referenceWords: ReferenceWord[];
  /** Production matcher position: the word after the last matched word. */
  matcherIndex: number;
  matcherHasLock: boolean;
  nowSec: number;
  evidence: AsrTokenEvidenceInput | null;
  voicedSeconds: VoicedSecondsFn;
  /**
   * Streaming ASR stamps a token when it is emitted, which trails the sound.
   * This systematic delay is subtracted from every token time.
   */
  tokenDelaySec?: number;
  /** Optional refinement of a delay-corrected onset, for example snapping to a VAD speech onset. */
  refineOnsetSec?: (anchorIndex: number, onsetSec: number, nowSec: number) => number;
}

export function getWordUnits(word: ReferenceWord | undefined, options: PacePredictorOptions): number {
  return (word?.normalized.length ?? 0) + options.overheadLetters;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function getPace(history: number[], options: PacePredictorOptions): number | null {
  if (history.length < options.minHistory) return null;
  return median(history.slice(-options.historySize));
}

interface LocatedWord {
  similarity: number;
  nextSimilarity: number;
  startSec: number;
  lastTokenSec: number;
}

/** Most recent ASR word that plausibly belongs to the given reference word. */
function locateEvidence(
  evidence: AsrTokenEvidenceInput | null,
  referenceWords: ReferenceWord[],
  referenceIndex: number,
  options: PacePredictorOptions,
): LocatedWord | null {
  if (!evidence) return null;
  const tokenTimes = evidence.tokenSourceTimestamps ?? evidence.tokenTimestamps ?? [];
  const words = buildAsrWordEvidence(evidence);
  const target = referenceWords[referenceIndex]?.normalized ?? "";
  const next = referenceWords[referenceIndex + 1]?.normalized ?? "";

  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index];
    if (word.startSec === null) continue;
    const similarity = getWordSimilarity(word.word, target);
    if (similarity < options.minEvidenceSimilarity) continue;
    return {
      similarity,
      nextSimilarity: next ? getWordSimilarity(word.word, next) : 0,
      startSec: word.startSec,
      lastTokenSec: tokenTimes[word.tokenEndIndex] ?? word.startSec,
    };
  }
  return null;
}

function latestEvidenceStart(evidence: AsrTokenEvidenceInput | null): number | null {
  if (!evidence) return null;
  const words = buildAsrWordEvidence(evidence);
  return words.at(-1)?.startSec ?? null;
}

export function predictReadingPosition(
  previousState: PacePredictorState,
  input: PacePredictorInput,
  overrides: Partial<PacePredictorOptions> = {},
): PacePredictorState {
  const options = { ...DEFAULT_PACE_PREDICTOR_OPTIONS, ...overrides };
  const { referenceWords, matcherIndex, matcherHasLock, nowSec, evidence, voicedSeconds, refineOnsetSec } = input;
  const tokenDelaySec = input.tokenDelaySec ?? 0;
  const lastIndex = referenceWords.length - 1;

  if (!matcherHasLock || matcherIndex <= 0 || lastIndex < 0) {
    return { ...previousState, predictedIndex: matcherIndex };
  }

  const anchorIndex = Math.min(matcherIndex - 1, lastIndex);
  let state = previousState;

  if (anchorIndex > state.anchorIndex) {
    const located = locateEvidence(evidence, referenceWords, anchorIndex, options);
    const tokenOnsetSec = located?.startSec ?? latestEvidenceStart(evidence);
    let onsetSec = tokenOnsetSec === null ? null : tokenOnsetSec - tokenDelaySec;
    if (onsetSec !== null && refineOnsetSec) {
      onsetSec = refineOnsetSec(anchorIndex, onsetSec, nowSec);
    }
    if (onsetSec !== null) onsetSec = Math.min(nowSec, onsetSec);
    let onsetFallbacks = state.onsetFallbacks + (located ? 0 : 1);
    let paceHistory = state.paceHistory;

    if (
      state.anchorIndex >= 0 &&
      state.anchorOnsetSec !== null &&
      onsetSec !== null &&
      onsetSec > state.anchorOnsetSec
    ) {
      let units = 0;
      for (let index = state.anchorIndex; index < anchorIndex; index += 1) {
        units += getWordUnits(referenceWords[index], options);
      }
      const sample = voicedSeconds(state.anchorOnsetSec, onsetSec) / Math.max(units, 1e-6);
      const pace = getPace(paceHistory, options);
      const isHeldWord = pace !== null && sample > options.heldFactor * pace;
      if (sample > 0 && !isHeldWord) {
        paceHistory = [...paceHistory, sample].slice(-options.historySize);
      }
    }

    if (onsetSec === null || (state.anchorOnsetSec !== null && onsetSec < state.anchorOnsetSec)) {
      onsetSec = state.anchorOnsetSec ?? nowSec;
      onsetFallbacks = state.onsetFallbacks + 1;
    }

    state = {
      ...state,
      anchorIndex,
      anchorOnsetSec: onsetSec,
      anchorEvidenceEndSec: located ? located.lastTokenSec - tokenDelaySec : onsetSec,
      paceHistory,
      onsetFallbacks,
    };
  } else {
    // Same anchor: more ASR evidence for it means the child is holding the word.
    const located = locateEvidence(evidence, referenceWords, anchorIndex, options);
    if (
      located &&
      located.similarity >= located.nextSimilarity &&
      (state.anchorEvidenceEndSec === null ||
        located.lastTokenSec - tokenDelaySec > state.anchorEvidenceEndSec)
    ) {
      state = { ...state, anchorEvidenceEndSec: located.lastTokenSec - tokenDelaySec };
    }
  }

  const pace = getPace(state.paceHistory, options);
  if (pace === null || state.anchorOnsetSec === null) {
    return { ...state, predictedIndex: matcherIndex, paceSecPerUnit: pace };
  }

  let budget = voicedSeconds(state.anchorOnsetSec, nowSec);
  let predictedIndex = anchorIndex;
  const leadLimit = Math.min(lastIndex, anchorIndex + options.maxLeadWords);

  while (predictedIndex < leadLimit) {
    let needed = pace * getWordUnits(referenceWords[predictedIndex], options);
    if (
      predictedIndex === anchorIndex &&
      state.anchorEvidenceEndSec !== null &&
      state.anchorEvidenceEndSec > state.anchorOnsetSec
    ) {
      const heldNeeded =
        voicedSeconds(state.anchorOnsetSec, state.anchorEvidenceEndSec) +
        pace * options.heldTailUnits;
      needed = Math.max(needed, heldNeeded);
    }
    if (budget < needed) break;
    budget -= needed;
    predictedIndex += 1;
  }

  if (!options.allowBehindMatcher) predictedIndex = Math.max(predictedIndex, matcherIndex);
  return { ...state, predictedIndex, paceSecPerUnit: pace };
}
