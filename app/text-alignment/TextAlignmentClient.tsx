"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  Mic,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Upload,
} from "lucide-react";
import { useSettings } from "../providers/SettingsContext";
import AsrScriptBridge from "../components/AsrScriptBridge";
import {
  parseReferenceText,
} from "./alignment";
import {
  alignTranscriptWithTiming,
  INITIAL_TIMING_AWARE_ALIGNMENT_STATE,
} from "./timingAwareAlignment";
import type {
  AsrEventPayload,
  TranscriptBlock,
  TranscriptUpdateDetail,
} from "./types";
import { useAudioFileAlignmentController } from "./useAudioFileAlignmentController";

type SourceMode = "microphone" | "file";

interface BenchmarkPredictionRecord {
  timeSec: number;
  predictedWordIndex: number;
  confidence: number;
  matchedPhrase: string;
  asrText: string;
  transcriptText: string;
  asrType: AsrEventPayload["type"];
  utteranceId: string | null;
  asrSourceTimeSec: number | null;
  tokens: string[];
  tokenTimestamps: number[];
  tokenSourceTimestamps: number[];
  tokenLogProbabilities: number[];
  latestWordConfidence: number | null;
  latestTokenAgeSec: number | null;
  mode: string;
  sourceType: SourceMode;
  recordedAt: string;
  matcherWordIndex: number;
  paceEnabled: boolean;
  paceSecPerLetter: number | null;
}

const DEMO_TEXT = `Täna loen ma seda teksti rahulikult ja järjest. Süsteem kuulab mikrofoni, võrdleb öeldud sõnu etteantud tekstiga ning tõstab esile koha, kus ma parajasti olen.`;

const translations = {
  en: {
    title: "Text alignment",
    subtitle:
      "Read a prepared text aloud and follow the current word in real time.",
    back: "Back to captions",
    referenceLabel: "Reference text",
    referenceHint: "Paste the text the speaker should read.",
    useDemo: "Use demo text",
    statusReady: "Model ready",
    statusLoading: "Loading ASR model...",
    statusRecording: "Listening",
    statusIdle: "Idle",
    start: "Start",
    stop: "Stop",
    clear: "Reset",
    currentWord: "Current word index",
    confidence: "Confidence",
    recentTranscript: "Recent ASR window",
    matchedPhrase: "Matched phrase",
    alignmentPlaceholder: "Paste a reference text to start alignment.",
    sourceLabel: "Input source",
    micMode: "Microphone",
    fileMode: "Uploaded audio",
    fileUpload: "Choose audio file",
    fileReady: "Ready to play",
    fileDecoding: "Decoding audio file...",
    filePreprocessing: "Preparing alignment...",
    filePlaying: "Playing",
    filePaused: "Paused",
    fileIdle: "Upload a local audio file.",
    fileError: "Audio processing failed.",
    filePlayer: "Audio playback",
    preprocessProgress: "Preprocess progress",
    selectedFile: "Selected file",
    playbackTime: "Playback time",
    play: "Play",
    pause: "Pause",
    noFile: "No file selected",
    pacePrediction: "Pace prediction",
    paceOn: "On",
    paceOff: "Off",
    paceHint: "A lighter highlight is a prediction the ASR has not confirmed yet.",
    readingPace: "Reading pace",
    msPerLetter: "ms per letter",
    paceMeasuring: "Measuring...",
    paceUnavailable: "Unavailable, reload the page",
    setupTitle: "Add the text that will be read",
    editText: "Edit text",
    hideEditor: "Done",
    wordProgress: "Word",
    legendRecognised: "Recognised",
    legendPredicted: "Predicted",
    legendRead: "Already read",
    devTools: "Developer tools",
    exportLog: "Export benchmark log",
    clearLog: "Clear log",
    records: "records",
    paceShort: "Pace",
    stepText: "Step 1",
    stepSource: "Step 2",
    setupLead: "Paste what the reader will read aloud. Each word lights up as it is read.",
    continueLabel: "Continue",
    changeText: "Change text",
    micHint: "Read aloud into the microphone.",
    fileHint: "Play a recording and follow along.",
    chooseFile: "Choose file",
    replaceFile: "Replace file",
    hintNeedFile: "Choose an audio file to begin.",
    hintNeedModel: "Loading the speech model, one moment.",
    hintReadyMic: "Press Start, then begin reading.",
    hintReadyFile: "Press Play to follow the recording.",
    hintRunning: "Following along. The lit word is where the reader is.",
    resetTitle: "Clear what has been recognised so far",
  },
  et: {
    title: "Teksti joondus",
    subtitle:
      "Loe ette etteantud tekst ja jälgi reaalajas, millise sõna juures kõneleja on.",
    back: "Tagasi subtiitrite juurde",
    referenceLabel: "Võrdlustekst",
    referenceHint: "Sisesta või kleebi tekst, mida kõneleja loeb.",
    useDemo: "Kasuta näidisteksti",
    statusReady: "Mudel valmis",
    statusLoading: "Laen ASR mudelit...",
    statusRecording: "Kuulan",
    statusIdle: "Ootel",
    start: "Alusta",
    stop: "Peata",
    clear: "Lähtesta",
    currentWord: "Praeguse sõna indeks",
    confidence: "Kindlus",
    recentTranscript: "Viimane ASR aken",
    matchedPhrase: "Leitud fraas",
    alignmentPlaceholder: "Kleebi võrdlustekst, et joondus alustada.",
    sourceLabel: "Sisendallikas",
    micMode: "Mikrofon",
    fileMode: "Helifail",
    fileUpload: "Vali helifail",
    fileReady: "Valmis esitamiseks",
    fileDecoding: "Dekodeerin helifaili...",
    filePreprocessing: "Valmistan joondust ette...",
    filePlaying: "Mängib",
    filePaused: "Paus",
    fileIdle: "Laadi üles kohalik helifail.",
    fileError: "Helifaili töötlemine ebaõnnestus.",
    filePlayer: "Heli esitamine",
    preprocessProgress: "Eeltöötluse edenemine",
    selectedFile: "Valitud fail",
    playbackTime: "Esituse aeg",
    play: "Esita",
    pause: "Paus",
    noFile: "Fail puudub",
    pacePrediction: "Tempo ennustus",
    paceOn: "Sees",
    paceOff: "Väljas",
    paceHint: "Heledam esiletõst on ennustus, mida ASR pole veel kinnitanud.",
    readingPace: "Lugemistempo",
    msPerLetter: "ms tähe kohta",
    paceMeasuring: "Mõõdan...",
    paceUnavailable: "Pole saadaval, laadi leht uuesti",
    setupTitle: "Lisa tekst, mida loetakse",
    editText: "Muuda teksti",
    hideEditor: "Valmis",
    wordProgress: "Sõna",
    legendRecognised: "Tuvastatud",
    legendPredicted: "Ennustatud",
    legendRead: "Juba loetud",
    devTools: "Arendaja tööriistad",
    exportLog: "Ekspordi logi",
    clearLog: "Tühjenda logi",
    records: "kirjet",
    paceShort: "Tempo",
    stepText: "1. samm",
    stepSource: "2. samm",
    setupLead: "Kleebi tekst, mida ette loetakse. Iga sõna süttib, kui see loetakse.",
    continueLabel: "Edasi",
    changeText: "Muuda teksti",
    micHint: "Loe mikrofoni ette.",
    fileHint: "Esita salvestus ja jälgi teksti.",
    chooseFile: "Vali fail",
    replaceFile: "Vaheta fail",
    hintNeedFile: "Alustamiseks vali helifail.",
    hintNeedModel: "Laen kõnemudelit, hetk aega.",
    hintReadyMic: "Vajuta Alusta ja hakka lugema.",
    hintReadyFile: "Vajuta Esita, et salvestust jälgida.",
    hintRunning: "Jälgin teksti. Esile tõstetud sõna on lugeja koht.",
    resetTitle: "Kustuta seni tuvastatu",
  },
} as const;

function getCombinedTranscript(blocks: TranscriptBlock[]): string {
  return blocks
    .map((block) => `${block.text}${block.previewSuffix ?? ""}`.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const totalSeconds = Math.floor(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function downloadJson(fileName: string, value: unknown) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export default function TextAlignmentClient() {
  const { backgroundColor, textColor, language } = useSettings();
  const t = translations[language] ?? translations.en;

  const [sourceMode, setSourceMode] = useState<SourceMode>("microphone");
  const [paceEnabled, setPaceEnabled] = useState(true);
  const [isModelReady, setIsModelReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(true);
  const currentWordRef = useRef<HTMLSpanElement | null>(null);
  const [referenceText, setReferenceText] = useState("");
  const [micTranscriptBlocks, setMicTranscriptBlocks] = useState<
    TranscriptBlock[]
  >([]);
  const [micAsrEvent, setMicAsrEvent] = useState<AsrEventPayload>({
    type: "idle",
  });
  const [micCombinedTranscriptText, setMicCombinedTranscriptText] =
    useState("");
  const [micAlignment, setMicAlignment] = useState(
    INITIAL_TIMING_AWARE_ALIGNMENT_STATE,
  );
  const [benchmarkRecords, setBenchmarkRecords] = useState<
    BenchmarkPredictionRecord[]
  >([]);
  const lastBenchmarkRecordKeyRef = useRef("");
  const latestAlignmentRef = useRef(INITIAL_TIMING_AWARE_ALIGNMENT_STATE);
  const latestHighlightRef = useRef({
    wordIndex: 0,
    paceEnabled: false,
    paceSecPerLetter: null as number | null,
  });
  const micAsrReceivedAtRef = useRef(Date.now());
  const latestAsrTextRef = useRef("");
  const latestBenchmarkInputRef = useRef({
    transcriptText: "",
    asrType: undefined as AsrEventPayload["type"],
    utteranceId: null as string | null,
    asrSourceTimeSec: null as number | null,
  });

  const referenceWords = useMemo(
    () => parseReferenceText(referenceText),
    [referenceText],
  );
  const fileController = useAudioFileAlignmentController({ referenceWords });
  const pauseFilePlayback = fileController.pause;
  const seekFilePlayback = fileController.seek;

  useEffect(() => {
    const handleModelInitialized = () => setIsModelReady(true);
    const handleTranscriptUpdate = (event: Event) => {
      const customEvent = event as CustomEvent<TranscriptUpdateDetail>;
      setMicTranscriptBlocks(customEvent.detail?.blocks ?? []);
      setMicCombinedTranscriptText(customEvent.detail?.combinedText ?? "");
      setMicAsrEvent(customEvent.detail?.asr ?? { type: "idle" });
      micAsrReceivedAtRef.current = Date.now();
    };

    window.addEventListener("modelInitialized", handleModelInitialized);
    window.addEventListener(
      "transcriptUpdate",
      handleTranscriptUpdate as EventListener,
    );

    return () => {
      window.removeEventListener("modelInitialized", handleModelInitialized);
      window.removeEventListener(
        "transcriptUpdate",
        handleTranscriptUpdate as EventListener,
      );
    };
  }, []);

  useEffect(() => {
    const micTranscriptText =
      micCombinedTranscriptText || getCombinedTranscript(micTranscriptBlocks);

    setMicAlignment((previousState) =>
      alignTranscriptWithTiming(
        referenceWords,
        micAsrEvent.normalizedText ||
          micAsrEvent.partialText ||
          micAsrEvent.finalText ||
          "",
        previousState,
        {
          type: micAsrEvent.type,
          utteranceId: micAsrEvent.utteranceId,
          sourceTimeSec: micAsrEvent.sourceTimeSec,
          tokens: micAsrEvent.tokens,
          tokenTimestamps: micAsrEvent.tokenTimestamps,
          tokenSourceTimestamps: micAsrEvent.tokenSourceTimestamps,
          tokenLogProbabilities: micAsrEvent.tokenLogProbabilities,
          combinedTranscriptText: micTranscriptText,
        },
      ),
    );
  }, [
    micAsrEvent,
    micCombinedTranscriptText,
    micTranscriptBlocks,
    referenceWords,
  ]);

  useEffect(() => {
    if (!isRecording || micAsrEvent.type !== "partial") return;

    const interval = window.setInterval(() => {
      const elapsedSec = (Date.now() - micAsrReceivedAtRef.current) / 1000;
      const micTranscriptText =
        micCombinedTranscriptText || getCombinedTranscript(micTranscriptBlocks);
      setMicAlignment((previousState) =>
        alignTranscriptWithTiming(
          referenceWords,
          micAsrEvent.normalizedText || micAsrEvent.partialText || "",
          previousState,
          {
            type: micAsrEvent.type,
            utteranceId: micAsrEvent.utteranceId,
            sourceTimeSec: (micAsrEvent.sourceTimeSec ?? 0) + elapsedSec,
            tokens: micAsrEvent.tokens,
            tokenTimestamps: micAsrEvent.tokenTimestamps,
            tokenSourceTimestamps: micAsrEvent.tokenSourceTimestamps,
            tokenLogProbabilities: micAsrEvent.tokenLogProbabilities,
            combinedTranscriptText: micTranscriptText,
          },
        ),
      );
    }, 100);

    return () => window.clearInterval(interval);
  }, [
    isRecording,
    micAsrEvent,
    micCombinedTranscriptText,
    micTranscriptBlocks,
    referenceWords,
  ]);

  useEffect(() => {
    if (sourceMode === "file" && isRecording) {
      document.getElementById("stopBtn")?.click();
      setIsRecording(false);
    }

    if (sourceMode === "microphone") {
      pauseFilePlayback();
      seekFilePlayback(0);
    }
  }, [isRecording, pauseFilePlayback, seekFilePlayback, sourceMode]);

  const activeAlignment =
    sourceMode === "file" ? fileController.alignment : micAlignment;
  const activeAsrEvent =
    sourceMode === "file"
      ? (fileController.detail.asr ?? { type: "idle" })
      : micAsrEvent;

  const activeAsrText =
    activeAsrEvent.normalizedText ||
    activeAsrEvent.partialText ||
    activeAsrEvent.finalText ||
    "";

  // Pace prediction runs on uploaded audio only; the microphone path has no source clock yet.
  const isPaceActive = sourceMode === "file" && paceEnabled;
  // The matcher points past the text once the last word matches; keep that word lit.
  const highlightedWordIndex = Math.min(
    isPaceActive ? fileController.pace.predictedIndex : activeAlignment.currentWordIndex,
    Math.max(referenceWords.length - 1, 0),
  );
  const isPredictedAhead =
    isPaceActive && highlightedWordIndex > activeAlignment.currentWordIndex;

  // Keep the word being read in view without the reader chasing it.
  useEffect(() => {
    const node = currentWordRef.current;
    if (!node) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({
      block: "center",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [highlightedWordIndex]);

  latestAlignmentRef.current = activeAlignment;
  latestHighlightRef.current = {
    wordIndex: highlightedWordIndex,
    paceEnabled: isPaceActive,
    paceSecPerLetter: fileController.pace.paceSecPerUnit,
  };
  latestAsrTextRef.current = activeAsrText;
  latestBenchmarkInputRef.current = {
    transcriptText:
      sourceMode === "file"
        ? (fileController.detail.combinedText ?? "")
        : micCombinedTranscriptText,
    asrType: activeAsrEvent.type,
    utteranceId: activeAsrEvent.utteranceId ?? null,
    asrSourceTimeSec: activeAsrEvent.sourceTimeSec ?? null,
  };

  const appendBenchmarkRecord = () => {
    if (sourceMode !== "file" || referenceWords.length === 0) {
      return;
    }

    const timeSec =
      fileController.audioRef.current?.currentTime ??
      fileController.modeState.currentTimeSec;
    const roundedTime = Math.round(timeSec * 10) / 10;

    const latestAlignment = latestAlignmentRef.current;
    const latestHighlight = latestHighlightRef.current;
    const latestAsrText = latestAsrTextRef.current;
    const latestBenchmarkInput = latestBenchmarkInputRef.current;

    if (roundedTime === 0 && !latestAsrText && !latestAlignment.hasLock) {
      return;
    }

    const recordKey = [
      roundedTime,
      latestHighlight.wordIndex,
      latestAlignment.confidence.toFixed(3),
      latestAsrText,
      latestBenchmarkInput.asrSourceTimeSec,
    ].join("|");

    if (recordKey === lastBenchmarkRecordKeyRef.current) {
      return;
    }

    lastBenchmarkRecordKeyRef.current = recordKey;
    setBenchmarkRecords((previousRecords) => [
      ...previousRecords,
      {
        timeSec: roundedTime,
        predictedWordIndex: latestHighlight.wordIndex,
        confidence: latestAlignment.confidence,
        matchedPhrase: latestAlignment.matchedPhrase,
        asrText: latestAsrText,
        transcriptText: latestBenchmarkInput.transcriptText,
        asrType: latestBenchmarkInput.asrType,
        utteranceId: latestBenchmarkInput.utteranceId,
        asrSourceTimeSec: latestBenchmarkInput.asrSourceTimeSec,
        tokens: activeAsrEvent.tokens ?? [],
        tokenTimestamps: activeAsrEvent.tokenTimestamps ?? [],
        tokenSourceTimestamps: activeAsrEvent.tokenSourceTimestamps ?? [],
        tokenLogProbabilities: activeAsrEvent.tokenLogProbabilities ?? [],
        latestWordConfidence: latestAlignment.latestWordConfidence,
        latestTokenAgeSec: latestAlignment.latestTokenAgeSec,
        mode: latestAlignment.mode,
        sourceType: sourceMode,
        recordedAt: new Date().toISOString(),
        matcherWordIndex: latestAlignment.currentWordIndex,
        paceEnabled: latestHighlight.paceEnabled,
        paceSecPerLetter: latestHighlight.paceSecPerLetter,
      },
    ]);
  };

  useEffect(() => {
    appendBenchmarkRecord();
    // This intentionally samples alignment updates, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    highlightedWordIndex,
    activeAlignment.currentWordIndex,
    activeAlignment.confidence,
    activeAlignment.matchedPhrase,
    activeAlignment.mode,
    activeAsrText,
    sourceMode,
  ]);

  useEffect(() => {
    if (sourceMode !== "file" || fileController.modeState.status !== "playing") {
      return;
    }

    const interval = window.setInterval(() => {
      appendBenchmarkRecord();
    }, 100);

    return () => window.clearInterval(interval);
    // This intentionally samples playback every 100ms while the file is playing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceMode, fileController.modeState.status]);

  const handleClearBenchmarkLog = () => {
    lastBenchmarkRecordKeyRef.current = "";
    setBenchmarkRecords([]);
  };

  const handleExportBenchmarkLog = () => {
    const fileName = fileController.modeState.fileName || "text-alignment";
    const id = fileName.replace(/\.[^.]+$/, "");
    downloadJson(`${id}.json`, {
      id,
      audioFileName: fileController.modeState.fileName,
      referenceText,
      exportedAt: new Date().toISOString(),
      records: benchmarkRecords,
    });
  };

  const fileStatusLabel =
    fileController.modeState.status === "decoding"
      ? t.fileDecoding
      : fileController.modeState.status === "ready"
        ? t.fileReady
        : fileController.modeState.status === "playing"
          ? t.filePlaying
          : fileController.modeState.status === "paused"
            ? t.filePaused
            : fileController.modeState.status === "error"
              ? fileController.modeState.errorMessage || t.fileError
              : t.fileIdle;

  const statusLabel =
    sourceMode === "microphone"
      ? !isModelReady
        ? t.statusLoading
        : isRecording
          ? t.statusRecording
          : t.statusIdle
      : fileStatusLabel;

  const handleToggleRecording = () => {
    const nextRecordingState = !isRecording;

    if (nextRecordingState) {
      document.getElementById("startBtn")?.click();
    } else {
      document.getElementById("stopBtn")?.click();
    }

    setIsRecording(nextRecordingState);
  };

  const handleReset = () => {
    if (sourceMode === "file") {
      fileController.reset();
      handleClearBenchmarkLog();
      return;
    }

    document.getElementById("clearBtn")?.click();
    setMicTranscriptBlocks([]);
    setMicCombinedTranscriptText("");
    setMicAsrEvent({ type: "reset" });
    setMicAlignment(INITIAL_TIMING_AWARE_ALIGNMENT_STATE);
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    handleClearBenchmarkLog();
    await fileController.loadFile(file);
    event.target.value = "";
  };

  const totalWords = referenceWords.length;
  const needsSetup = totalWords === 0;
  // The editor stays open until Continue is pressed, so it cannot vanish mid-typing.
  const showEditor = isEditorOpen;
  const isFileMode = sourceMode === "file";
  const isPlaying = fileController.modeState.status === "playing";
  const canPlay = fileController.modeState.isReady;

  const primaryAction = isFileMode
    ? {
        onClick: () => (isPlaying ? fileController.pause() : fileController.play()),
        disabled: !canPlay,
        icon: isPlaying ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4" />
        ),
        label: isPlaying ? t.pause : t.play,
        danger: false,
      }
    : {
        onClick: handleToggleRecording,
        disabled: !isModelReady,
        icon: isRecording ? (
          <Square className="h-4 w-4" />
        ) : (
          <Mic className="h-4 w-4" />
        ),
        label: isRecording ? t.stop : t.start,
        danger: isRecording,
      };

  const hasSession =
    activeAlignment.recentTranscript.length > 0 ||
    benchmarkRecords.length > 0 ||
    isRecording ||
    fileController.modeState.status === "playing" ||
    fileController.modeState.status === "paused";

  const actionHint = isFileMode
    ? !canPlay
      ? t.hintNeedFile
      : isPlaying
        ? t.hintRunning
        : t.hintReadyFile
    : !isModelReady
      ? t.hintNeedModel
      : isRecording
        ? t.hintRunning
        : t.hintReadyMic;

  return (
    <div
      className="flex min-h-dvh w-full flex-col"
      style={{ backgroundColor, color: textColor }}
    >
      <AsrScriptBridge />

      <header className="sticky top-0 z-30 border-b border-white/10 bg-black/75 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5 sm:px-6">
          <div className="mr-auto min-w-0">
            <h1 className="truncate text-[0.95rem] font-semibold tracking-[-0.01em]">
              {t.title}
            </h1>
            <p
              aria-live="polite"
              className="flex items-center gap-1.5 truncate text-xs text-white/50"
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  isRecording || isPlaying
                    ? "bg-emerald-400"
                    : isModelReady || canPlay
                      ? "bg-white/40"
                      : "bg-amber-400/80"
                }`}
              />
              {statusLabel}
            </p>
          </div>

          {!needsSetup && !showEditor && (
            <>
              <button
                type="button"
                onClick={() => setIsEditorOpen(true)}
                aria-label={t.changeText}
                className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3.5 text-xs font-medium text-white/70 transition duration-200 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
              >
                <Pencil className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t.changeText}</span>
              </button>

              {hasSession && (
                <button
                  type="button"
                  onClick={handleReset}
                  aria-label={t.clear}
                  title={t.resetTitle}
                  className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3.5 text-xs font-medium text-white/70 transition duration-200 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t.clear}</span>
                </button>
              )}
            </>
          )}
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pb-6 pt-5 sm:px-6">
        {showEditor && (
          <section className="mx-auto my-auto w-full max-w-2xl rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <p className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-emerald-300/80">
              {t.stepText}
            </p>
            <h2 className="mt-1.5 text-lg font-semibold">{t.setupTitle}</h2>
            <p className="mt-1 text-sm text-white/55">{t.setupLead}</p>

            <label htmlFor="reference-text" className="sr-only">
              {t.referenceLabel}
            </label>
            <textarea
              id="reference-text"
              autoFocus
              value={referenceText}
              onChange={(event) => setReferenceText(event.target.value)}
              placeholder={t.alignmentPlaceholder}
              className="mt-3 min-h-[128px] w-full resize-y rounded-xl border border-white/10 bg-black/30 p-3.5 text-[0.95rem] leading-relaxed outline-none transition duration-200 placeholder:text-white/30 focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/25"
            />

            <div className="mt-3 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setReferenceText(DEMO_TEXT)}
                className="cursor-pointer rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-white/70 transition duration-200 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
              >
                {t.useDemo}
              </button>
              <button
                type="button"
                disabled={totalWords === 0}
                onClick={() => setIsEditorOpen(false)}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-emerald-400 px-4 py-2 text-xs font-semibold text-black transition duration-200 hover:bg-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/35"
              >
                {t.continueLabel}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </section>
        )}

        {!needsSetup && !showEditor && (
          <>
            <section
              aria-label={t.sourceLabel}
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div
                  role="group"
                  aria-label={t.sourceLabel}
                  className="flex shrink-0 rounded-full border border-white/10 bg-black/30 p-1"
                >
                  {(
                    [
                      { key: "microphone", label: t.micMode, Icon: Mic },
                      { key: "file", label: t.fileMode, Icon: Upload },
                    ] as const
                  ).map(({ key, label, Icon }) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={sourceMode === key}
                      onClick={() => setSourceMode(key)}
                      className={`inline-flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 ${
                        sourceMode === key
                          ? "bg-white text-black"
                          : "text-white/60 hover:text-white"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </button>
                  ))}
                </div>

                {isFileMode && (
                  <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm text-white/80 transition duration-200 hover:bg-white/[0.08] hover:text-white focus-within:ring-2 focus-within:ring-emerald-400/70">
                    <Upload className="h-4 w-4" />
                    {canPlay ? t.replaceFile : t.chooseFile}
                    <input
                      type="file"
                      accept="audio/*"
                      className="sr-only"
                      onChange={handleFileChange}
                    />
                  </label>
                )}

                <p className="order-last w-full text-xs text-white/50 sm:order-none sm:ml-auto sm:w-auto sm:text-right">
                  {actionHint}
                </p>

                <button
                  type="button"
                  onClick={primaryAction.onClick}
                  disabled={primaryAction.disabled}
                  className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-full px-5 text-sm font-semibold transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black ${
                    primaryAction.danger
                      ? "bg-red-500 text-white hover:bg-red-400 focus-visible:ring-red-400"
                      : "bg-emerald-400 text-black hover:bg-emerald-300 focus-visible:ring-emerald-400"
                  } disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/35`}
                >
                  {primaryAction.icon}
                  {primaryAction.label}
                </button>
              </div>

              {isFileMode && canPlay && (
                <div className="mt-3 flex items-center gap-3 border-t border-white/10 pt-3">
                  <span className="min-w-0 flex-1 truncate text-xs text-white/50">
                    {fileController.modeState.fileName || t.noFile}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(fileController.modeState.durationSec || 0, 0.01)}
                    step={0.01}
                    value={fileController.modeState.currentTimeSec || 0}
                    onChange={(event) =>
                      fileController.seek(Number(event.target.value))
                    }
                    aria-label={t.playbackTime}
                    className="h-1.5 w-full max-w-md cursor-pointer appearance-none rounded-full bg-white/15 accent-emerald-400 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
                  />
                  <span className="shrink-0 tabular-nums text-xs text-white/50">
                    {formatSeconds(fileController.modeState.currentTimeSec)} /{" "}
                    {formatSeconds(fileController.modeState.durationSec)}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={paceEnabled}
                    onClick={() => setPaceEnabled((value) => !value)}
                    className={`inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 ${
                      paceEnabled
                        ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-200"
                        : "border-white/10 bg-white/[0.04] text-white/55 hover:text-white/85"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 rounded-full ${
                        paceEnabled ? "bg-emerald-300" : "bg-white/30"
                      }`}
                    />
                    <span className="hidden sm:inline">{t.pacePrediction}</span>
                  </button>
                </div>
              )}

              {fileController.modeState.errorMessage && (
                <p role="alert" className="mt-2 text-sm text-red-300">
                  {fileController.modeState.errorMessage}
                </p>
              )}

              <audio
                ref={fileController.audioRef}
                preload="metadata"
                src={fileController.modeState.objectUrl || undefined}
                className="hidden"
              />
            </section>

            <section
              aria-label={t.title}
              className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.02]"
            >
              <div className="flex min-h-[38vh] flex-1 items-center overflow-y-auto px-5 py-8 sm:px-10 sm:py-10">
                <p className="mx-auto max-w-[56ch] text-[clamp(1.35rem,2.4vw,1.9rem)] font-medium leading-[1.8] tracking-[-0.01em]">
                  {referenceWords.map((word) => {
                    const isCurrent = word.index === highlightedWordIndex;
                    const isPast = word.index < highlightedWordIndex;
                    const trimmed = word.display.trimEnd();
                    const trailing = word.display.slice(trimmed.length);

                    return (
                      <Fragment key={`${word.index}-${word.normalized}`}>
                        <span
                          ref={isCurrent ? currentWordRef : undefined}
                          className={`-mx-0.5 rounded-lg px-1 py-0.5 transition-colors duration-200 ${
                            isCurrent && isPredictedAhead
                              ? "bg-emerald-400/20 text-white ring-1 ring-emerald-300/60"
                              : isCurrent
                                ? "bg-emerald-400 text-black"
                                : isPast
                                  ? "text-white/35"
                                  : "text-white/90"
                          }`}
                        >
                          {trimmed}
                        </span>
                        {trailing}
                      </Fragment>
                    );
                  })}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/10 bg-black/30 px-5 py-2.5 text-xs sm:px-10">
                <span className="tabular-nums text-white/50">
                  {t.wordProgress}{" "}
                  <span className="font-semibold text-white/85">
                    {Math.min(highlightedWordIndex + 1, totalWords)}
                  </span>
                  <span className="text-white/35"> / {totalWords}</span>
                </span>
                <span className="inline-flex items-center gap-2 text-white/55">
                  <span
                    aria-hidden="true"
                    className="h-3 w-5 rounded-md bg-emerald-400"
                  />
                  {t.legendRecognised}
                </span>
                {isPaceActive && (
                  <span className="inline-flex items-center gap-2 text-white/55">
                    <span
                      aria-hidden="true"
                      className="h-3 w-5 rounded-md bg-emerald-400/20 ring-1 ring-emerald-300/60"
                    />
                    {t.legendPredicted}
                  </span>
                )}

                {isPaceActive && (
                  <span className="ml-auto inline-flex items-center gap-2 tabular-nums text-white/55">
                    {t.paceShort}
                    {fileController.isPaceAvailable === false ? (
                      <span className="font-medium text-amber-200/90">
                        {t.paceUnavailable}
                      </span>
                    ) : fileController.pace.paceSecPerUnit === null ? (
                      <span className="text-white/45">{t.paceMeasuring}</span>
                    ) : (
                      <span className="font-semibold text-white/90">
                        {Math.round(fileController.pace.paceSecPerUnit * 1000)}
                        <span className="ml-1 font-normal text-white/50">
                          {t.msPerLetter}
                        </span>
                      </span>
                    )}
                  </span>
                )}
              </div>
            </section>

            <details className="group mt-3 rounded-2xl border border-white/10 bg-white/[0.02]">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-xs font-medium text-white/45 transition duration-200 hover:text-white/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70">
                <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 group-open:rotate-180" />
                {t.devTools}
              </summary>

              <div className="grid gap-3 border-t border-white/10 px-5 py-4 sm:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-black/25 p-3">
                  <dt className="text-xs text-white/45">{t.recentTranscript}</dt>
                  <dd className="mt-1 break-words text-sm text-white/80">
                    {activeAlignment.recentTranscript || "—"}
                  </dd>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/25 p-3">
                  <dt className="text-xs text-white/45">{t.matchedPhrase}</dt>
                  <dd className="mt-1 break-words text-sm text-white/80">
                    {activeAlignment.matchedPhrase || "—"}
                  </dd>
                </div>

                {isFileMode && (
                  <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                    <button
                      type="button"
                      onClick={handleExportBenchmarkLog}
                      disabled={benchmarkRecords.length === 0}
                      className="cursor-pointer rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-white/70 transition duration-200 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 disabled:cursor-not-allowed disabled:text-white/30"
                    >
                      {t.exportLog}
                    </button>
                    <button
                      type="button"
                      onClick={handleClearBenchmarkLog}
                      className="cursor-pointer rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-white/70 transition duration-200 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
                    >
                      {t.clearLog}
                    </button>
                    <span className="tabular-nums text-xs text-white/45">
                      {benchmarkRecords.length} {t.records}
                    </span>
                  </div>
                )}
              </div>
            </details>
          </>
        )}
      </main>
    </div>
  );
}
