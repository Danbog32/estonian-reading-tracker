export interface TranscriptBlock {
  text: string;
  previewSuffix?: string;
}

export interface AsrTokenTiming {
  token: string;
  startSec: number;
  confidence: number | null;
}

export interface AsrEventPayload {
  type?: "idle" | "partial" | "final" | "reset";
  utteranceId?: string | null;
  partialText?: string;
  finalText?: string;
  normalizedText?: string;
  isFinal?: boolean;
  sequence?: number;
  timestamp?: string | null;
  tokens?: string[];
  tokenTimestamps?: number[] | null;
  tokenSourceTimestamps?: number[] | null;
  tokenLogProbabilities?: number[] | null;
  wordTimestamps?: unknown;
  sourceType?: "microphone" | "file";
  sourceTimeSec?: number | null;
  sourceDurationSec?: number | null;
}

export interface TranscriptUpdateDetail {
  blocks?: TranscriptBlock[];
  completedText?: string;
  activeText?: string;
  combinedText?: string;
  activeUtteranceId?: string | null;
  asr?: AsrEventPayload;
  sourceType?: "microphone" | "file";
  sourceTimeSec?: number | null;
  sourceDurationSec?: number | null;
}
