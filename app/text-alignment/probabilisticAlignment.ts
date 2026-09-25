import {
  getTranscriptWords,
  getWordSimilarity,
  type AlignmentMode,
  type ReferenceWord,
} from "./alignment";

export interface PositionHypothesis {
  index: number;
  probability: number;
}

export interface ProbabilisticAlignmentState {
  currentWordIndex: number;
  confidence: number;
  margin: number;
  hasLock: boolean;
  mode: AlignmentMode;
  recentTranscript: string;
  matchedPhrase: string;
  activeUtteranceId: string | null;
  activeTranscript: string;
  activeWords: string[];
  probabilities: number[];
  utterancePrior: number[];
  tokenPosteriors: number[][];
  hypotheses: PositionHypothesis[];
}

export interface ProbabilisticAlignmentSignal {
  type?: "idle" | "partial" | "final" | "reset";
  utteranceId?: string | null;
}

export interface ProbabilisticAlignmentOptions {
  beamWidth: number;
  observationTemperature: number;
  insertionProbability: number;
  stayProbability: number;
  advanceProbability: number;
  skipProbability: number;
  skipDecay: number;
  maximumSkipWords: number;
  initialUniformMass: number;
  initialAdvanceProbability: number;
  exactCompletionProbability: number;
  fuzzyCompletionProbability: number;
  partialCompletionProbability: number;
  finalCompletionBonus: number;
  minimumEvidenceSimilarity: number;
  lockProbability: number;
  lockMargin: number;
}

export const DEFAULT_PROBABILISTIC_ALIGNMENT_OPTIONS: ProbabilisticAlignmentOptions = {
  beamWidth: 7,
  observationTemperature: 5.5,
  insertionProbability: 0.18,
  stayProbability: 0.34,
  advanceProbability: 0.58,
  skipProbability: 0.08,
  skipDecay: 0.28,
  maximumSkipWords: 6,
  initialUniformMass: 0.15,
  initialAdvanceProbability: 0.2,
  exactCompletionProbability: 0.82,
  fuzzyCompletionProbability: 0.58,
  partialCompletionProbability: 0.03,
  finalCompletionBonus: 0.12,
  minimumEvidenceSimilarity: 0.5,
  lockProbability: 0.48,
  lockMargin: 0.12,
};

export const INITIAL_PROBABILISTIC_ALIGNMENT_STATE: ProbabilisticAlignmentState = {
  currentWordIndex: 0,
  confidence: 0,
  margin: 0,
  hasLock: false,
  mode: "lost",
  recentTranscript: "",
  matchedPhrase: "",
  activeUtteranceId: null,
  activeTranscript: "",
  activeWords: [],
  probabilities: [],
  utterancePrior: [],
  tokenPosteriors: [],
  hypotheses: [],
};

function normalizeDistribution(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || !Number.isFinite(total)) {
    return values.map(() => 0);
  }
  return values.map((value) => value / total);
}

function initialDistribution(
  length: number,
  options: ProbabilisticAlignmentOptions,
): number[] {
  if (length <= 0) return [];
  const uniform = options.initialUniformMass / Math.min(length, 80);
  const values = Array.from({ length }, (_, index) =>
    index < 80
      ? (1 - options.initialUniformMass) * Math.pow(0.22, index) + uniform
      : 0,
  );
  return normalizeDistribution(values);
}

function pruneDistribution(values: number[], beamWidth: number): number[] {
  if (values.length <= beamWidth) return normalizeDistribution(values);
  const retained = new Set(
    values
      .map((probability, index) => ({ probability, index }))
      .sort((left, right) => right.probability - left.probability)
      .slice(0, beamWidth)
      .map(({ index }) => index),
  );
  return normalizeDistribution(values.map((value, index) => (retained.has(index) ? value : 0)));
}

function predictNextUtterance(
  values: number[],
  options: ProbabilisticAlignmentOptions,
): number[] {
  const predicted = values.map(() => 0);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    predicted[index] += value * (1 - options.initialAdvanceProbability);
    if (index + 1 < values.length) {
      predicted[index + 1] += value * options.initialAdvanceProbability;
    } else {
      predicted[index] += value * options.initialAdvanceProbability;
    }
  }
  return pruneDistribution(predicted, options.beamWidth);
}

function isPartialMatch(transcriptWord: string, referenceWord: string): boolean {
  const isLiteralPrefix =
    transcriptWord.length >= 2 &&
    transcriptWord.length < referenceWord.length &&
    referenceWord.startsWith(transcriptWord);
  const isShortFuzzyFragment =
    transcriptWord.length >= 2 &&
    transcriptWord.length < referenceWord.length &&
    getWordSimilarity(transcriptWord, referenceWord) >= 0.5;
  return isLiteralPrefix || isShortFuzzyFragment;
}

function observationLikelihood(
  transcriptWord: string,
  referenceWord: string,
  options: ProbabilisticAlignmentOptions,
): { likelihood: number; similarity: number } {
  const similarity = getWordSimilarity(transcriptWord, referenceWord);
  const centered = similarity - options.minimumEvidenceSimilarity;
  return {
    similarity,
    likelihood: Math.exp(centered * options.observationTemperature),
  };
}

function consumeWord(
  previous: number[],
  transcriptWord: string,
  referenceWords: ReferenceWord[],
  options: ProbabilisticAlignmentOptions,
  isFirstWord: boolean,
): { probabilities: number[]; similarities: number[] } {
  const next = previous.map(() => 0);
  const similarities = previous.map(() => 0);

  for (let target = 0; target < previous.length; target += 1) {
    const observation = observationLikelihood(
      transcriptWord,
      referenceWords[target].normalized,
      options,
    );
    similarities[target] = observation.similarity;

    let transitionMass = previous[target] * options.stayProbability;
    if (isFirstWord) {
      transitionMass = previous[target];
    } else {
      if (target > 0) {
        transitionMass += previous[target - 1] * options.advanceProbability;
      }
      if (target > 1) {
        transitionMass += previous[target - 2] * options.skipProbability;
      }
      for (
        let distance = 3;
        distance <= options.maximumSkipWords + 1 && target >= distance;
        distance += 1
      ) {
        transitionMass +=
          previous[target - distance] *
          options.skipProbability *
          Math.pow(options.skipDecay, distance - 2);
      }
    }

    const insertedNoise = previous[target] * options.insertionProbability;
    next[target] = insertedNoise + transitionMass * observation.likelihood;
  }

  return {
    probabilities: pruneDistribution(next, options.beamWidth),
    similarities,
  };
}

function projectReadingPosition(
  matched: number[],
  transcriptWord: string,
  referenceWords: ReferenceWord[],
  similarities: number[],
  signalType: ProbabilisticAlignmentSignal["type"],
  options: ProbabilisticAlignmentOptions,
): number[] {
  const projected = matched.map(() => 0);

  for (let index = 0; index < matched.length; index += 1) {
    const similarity = similarities[index] ?? 0;
    const referenceWord = referenceWords[index].normalized;
    let completionProbability = options.fuzzyCompletionProbability;

    if (
      isPartialMatch(transcriptWord, referenceWord) ||
      similarity < 0.68
    ) {
      completionProbability = options.partialCompletionProbability;
    } else if (similarity >= 0.97) {
      completionProbability = options.exactCompletionProbability;
    }

    if (signalType === "final") {
      completionProbability = Math.min(
        0.9,
        completionProbability + options.finalCompletionBonus,
      );
    }

    projected[index] += matched[index] * (1 - completionProbability);
    if (index + 1 < matched.length) {
      projected[index + 1] += matched[index] * completionProbability;
    } else {
      projected[index] += matched[index] * completionProbability;
    }
  }

  return pruneDistribution(projected, options.beamWidth);
}

function topHypotheses(values: number[], limit = 5): PositionHypothesis[] {
  return values
    .map((probability, index) => ({ probability, index }))
    .filter(({ probability }) => probability > 0)
    .sort((left, right) => right.probability - left.probability)
    .slice(0, limit);
}

function commonPrefixLength(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function getMode(confidence: number, margin: number, similarity: number): AlignmentMode {
  if (confidence >= 0.78 && margin >= 0.25 && similarity >= 0.97) return "exact";
  if (confidence >= 0.58 && margin >= 0.14) return "fuzzy";
  if (confidence >= 0.38) return "uncertain";
  return "lost";
}

export function alignTranscriptProbabilistically(
  referenceWords: ReferenceWord[],
  transcriptText: string,
  previousState: ProbabilisticAlignmentState,
  signal: ProbabilisticAlignmentSignal = {},
  overrides: Partial<ProbabilisticAlignmentOptions> = {},
): ProbabilisticAlignmentState {
  const options = { ...DEFAULT_PROBABILISTIC_ALIGNMENT_OPTIONS, ...overrides };
  const signalType = signal.type ?? "partial";
  const utteranceId = signal.utteranceId ?? previousState.activeUtteranceId ?? "current";

  if (signalType === "reset" || referenceWords.length === 0) {
    return {
      ...INITIAL_PROBABILISTIC_ALIGNMENT_STATE,
      probabilities: initialDistribution(referenceWords.length, options),
      utterancePrior: initialDistribution(referenceWords.length, options),
    };
  }

  const transcriptWords = getTranscriptWords(transcriptText);
  const isNewUtterance =
    previousState.activeUtteranceId !== null &&
    utteranceId !== previousState.activeUtteranceId;
  const previousDistribution = previousState.probabilities.length === referenceWords.length
    ? previousState.probabilities
    : initialDistribution(referenceWords.length, options);
  const utterancePrior = isNewUtterance
    ? predictNextUtterance(previousDistribution, options)
    : previousState.utterancePrior.length === referenceWords.length
      ? previousState.utterancePrior
      : previousDistribution;

  if (transcriptWords.length === 0) {
    return {
      ...previousState,
      recentTranscript: "",
      activeTranscript: "",
      activeWords: [],
      activeUtteranceId: utteranceId,
      utterancePrior,
      tokenPosteriors: [],
      confidence: 0,
      margin: 0,
      mode: "lost",
    };
  }

  const reusablePrefixLength = isNewUtterance
    ? 0
    : commonPrefixLength(previousState.activeWords, transcriptWords);
  const tokenPosteriors = isNewUtterance
    ? []
    : previousState.tokenPosteriors.slice(0, reusablePrefixLength);
  let matched = reusablePrefixLength > 0
    ? tokenPosteriors[reusablePrefixLength - 1]
    : utterancePrior;
  let lastSimilarities = matched.map(() => 0);
  let maximumEvidence = 0;

  for (let index = reusablePrefixLength; index < transcriptWords.length; index += 1) {
    const consumed = consumeWord(
      matched,
      transcriptWords[index],
      referenceWords,
      options,
      index === 0,
    );
    matched = consumed.probabilities;
    lastSimilarities = consumed.similarities;
    tokenPosteriors[index] = matched;
    maximumEvidence = Math.max(maximumEvidence, ...consumed.similarities);
  }

  if (reusablePrefixLength === transcriptWords.length) {
    lastSimilarities = referenceWords.map((word) =>
      getWordSimilarity(transcriptWords.at(-1) ?? "", word.normalized),
    );
  }
  maximumEvidence = Math.max(maximumEvidence, ...lastSimilarities);

  const readingProbabilities = projectReadingPosition(
    matched,
    transcriptWords.at(-1) ?? "",
    referenceWords,
    lastSimilarities,
    signalType,
    options,
  );
  const hypotheses = topHypotheses(readingProbabilities);
  const best = hypotheses[0] ?? { index: previousState.currentWordIndex, probability: 0 };
  const second = hypotheses[1]?.probability ?? 0;
  const margin = Math.max(0, best.probability - second);
  const bestMatchedSimilarity = lastSimilarities[Math.max(0, best.index - 1)] ??
    lastSimilarities[best.index] ?? 0;
  const hasEnoughEvidence = maximumEvidence >= options.minimumEvidenceSimilarity;
  const canLock =
    hasEnoughEvidence &&
    best.probability >= options.lockProbability &&
    margin >= options.lockMargin;
  const hasLock = previousState.hasLock || canLock;
  const currentWordIndex = hasLock
    ? Math.max(previousState.hasLock ? previousState.currentWordIndex : 0, best.index)
    : previousState.currentWordIndex;
  const confidence = hasEnoughEvidence ? best.probability : 0;
  const mode = hasEnoughEvidence
    ? getMode(confidence, margin, bestMatchedSimilarity)
    : hasLock
      ? "uncertain"
      : "lost";

  return {
    currentWordIndex,
    confidence,
    margin,
    hasLock,
    mode: hasLock ? mode : "lost",
    recentTranscript: transcriptWords.join(" "),
    matchedPhrase: referenceWords[currentWordIndex]?.display.trim() ?? "",
    activeUtteranceId: utteranceId,
    activeTranscript: transcriptText,
    activeWords: transcriptWords,
    probabilities: readingProbabilities,
    utterancePrior,
    tokenPosteriors,
    hypotheses,
  };
}
