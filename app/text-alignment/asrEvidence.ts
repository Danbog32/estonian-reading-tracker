import { normalizeWord } from "./alignment";

export interface AsrWordEvidence {
  word: string;
  startSec: number | null;
  confidence: number | null;
  tokenStartIndex: number;
  tokenEndIndex: number;
}

export interface AsrTokenEvidenceInput {
  tokens?: string[] | null;
  tokenTimestamps?: number[] | null;
  tokenSourceTimestamps?: number[] | null;
  tokenLogProbabilities?: number[] | null;
}

function isWordStartToken(token: string): boolean {
  return /^\s/.test(token) || token.startsWith("▁") || token.startsWith("Ġ");
}

function getTokenSurface(token: string): string {
  return token.replace(/^[▁Ġ]/, " ").trim();
}

function getWordConfidence(logProbabilities: number[]): number | null {
  if (logProbabilities.length === 0) return null;
  const averageLogProbability =
    logProbabilities.reduce((sum, value) => sum + value, 0) /
    logProbabilities.length;
  return Math.min(1, Math.max(0, Math.exp(averageLogProbability)));
}

export function buildAsrWordEvidence({
  tokens,
  tokenTimestamps,
  tokenSourceTimestamps,
  tokenLogProbabilities,
}: AsrTokenEvidenceInput): AsrWordEvidence[] {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];

  const timestamps =
    Array.isArray(tokenSourceTimestamps) &&
    tokenSourceTimestamps.length === tokens.length
      ? tokenSourceTimestamps
      : Array.isArray(tokenTimestamps) && tokenTimestamps.length === tokens.length
        ? tokenTimestamps
        : [];
  const logProbabilities =
    Array.isArray(tokenLogProbabilities) &&
    tokenLogProbabilities.length === tokens.length
      ? tokenLogProbabilities
      : [];
  const words: AsrWordEvidence[] = [];
  let currentSurface = "";
  let currentStartIndex = 0;
  let currentLogProbabilities: number[] = [];

  const commitCurrentWord = (endIndex: number) => {
    const word = normalizeWord(currentSurface);
    if (word) {
      words.push({
        word,
        startSec: timestamps[currentStartIndex] ?? null,
        confidence: getWordConfidence(currentLogProbabilities),
        tokenStartIndex: currentStartIndex,
        tokenEndIndex: endIndex,
      });
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (index > 0 && isWordStartToken(token)) {
      commitCurrentWord(index - 1);
      currentSurface = "";
      currentStartIndex = index;
      currentLogProbabilities = [];
    }

    currentSurface += getTokenSurface(token);
    if (Number.isFinite(logProbabilities[index])) {
      currentLogProbabilities.push(logProbabilities[index]);
    }
  }

  commitCurrentWord(tokens.length - 1);
  return words;
}
