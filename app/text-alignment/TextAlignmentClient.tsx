"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
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
import { parseReferenceText } from "./alignment";
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
import { useMicPacePredictor } from "./useMicPacePredictor";

type SourceMode = "microphone" | "file";

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
    paceHint:
      "A lighter highlight is a prediction the ASR has not confirmed yet.",
    wordsPerMinute: "words per minute",
    paceMeasuring: "Measuring...",
    paceUnavailable: "Unavailable, reload the page",
    setupTitle: "Text to read",
    editText: "Edit text",
    hideEditor: "Done",
    wordProgress: "Word",
    legendRecognised: "Recognised",
    legendPredicted: "Predicted",
    legendRead: "Already read",
    devTools: "Developer tools",
    paceShort: "Speed",
    setupLead:
      "Paste what the reader will read aloud. Each word lights up as it is read.",
    changeText: "Change text",
    chooseFile: "Choose file",
    replaceFile: "Replace file",
    hintNeedText: "Add the text that will be read",
    hintNeedFile: "Choose an audio file to begin",
    hintNeedModel: "Loading the speech model, one moment",
    hintReadyMic: "Press Start, then begin reading",
    hintReadyFile: "Press Play to follow the recording",
    hintRunning: "The lit word is where the reader is",
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
    wordsPerMinute: "sõna minutis",
    paceMeasuring: "Mõõdan...",
    paceUnavailable: "Pole saadaval, laadi leht uuesti",
    setupTitle: "Loetav tekst",
    editText: "Muuda teksti",
    hideEditor: "Valmis",
    wordProgress: "Sõna",
    legendRecognised: "Tuvastatud",
    legendPredicted: "Ennustatud",
    legendRead: "Juba loetud",
    devTools: "Arendaja tööriistad",
    paceShort: "Kiirus",
    setupLead:
      "Kleebi tekst, mida ette loetakse. Iga sõna süttib, kui see loetakse.",
    changeText: "Muuda teksti",
    chooseFile: "Vali fail",
    replaceFile: "Vaheta fail",
    hintNeedText: "Lisa tekst, mida loetakse",
    hintNeedFile: "Alustamiseks vali helifail",
    hintNeedModel: "Laen kõnemudelit, hetk aega",
    hintReadyMic: "Vajuta Alusta ja hakka lugema",
    hintReadyFile: "Vajuta Esita, et salvestust jälgida",
    hintRunning: "Esile tõstetud sõna on lugeja koht",
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

export default function TextAlignmentClient() {
  const { backgroundColor, textColor, language } = useSettings();
  const t = translations[language] ?? translations.en;

  const [sourceMode, setSourceMode] = useState<SourceMode>("microphone");
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
  const micAsrReceivedAtRef = useRef(Date.now());

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
  const micPace = useMicPacePredictor({
    referenceWords,
    alignment: micAlignment,
    asrEvent: micAsrEvent,
    isRecording,
    enabled: sourceMode === "microphone",
  });
  const activePace = sourceMode === "file" ? fileController.pace : micPace.pace;
  const isActivePaceAvailable =
    sourceMode === "file"
      ? fileController.isPaceAvailable
      : micPace.isPaceAvailable;
  // The matcher points past the text once the last word matches; keep that word lit.
  const highlightedWordIndex = Math.min(
    activePace.predictedIndex,
    Math.max(referenceWords.length - 1, 0),
  );
  const isPredictedAhead =
    highlightedWordIndex > activeAlignment.currentWordIndex;

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

  // Reading speed counts pauses too: confirmed words over the time since the
  // first confirmed word began, both on the audio clock.
  const readingStartRef = useRef<{ index: number; onsetSec: number } | null>(
    null,
  );
  if (activePace.anchorIndex < 0 || activePace.anchorOnsetSec === null) {
    readingStartRef.current = null;
  } else if (
    !readingStartRef.current ||
    activePace.anchorIndex < readingStartRef.current.index
  ) {
    readingStartRef.current = {
      index: activePace.anchorIndex,
      onsetSec: activePace.anchorOnsetSec,
    };
  }
  const readingStart = readingStartRef.current;
  const wordsRead = readingStart
    ? activePace.anchorIndex - readingStart.index
    : 0;
  const readingSec =
    readingStart && activePace.anchorOnsetSec !== null
      ? activePace.anchorOnsetSec - readingStart.onsetSec
      : 0;
  const wordsPerMinute =
    wordsRead >= 3 && readingSec >= 2
      ? Math.round((wordsRead * 60) / readingSec)
      : null;

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
      return;
    }

    document.getElementById("clearBtn")?.click();
    micPace.reset();
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
        onClick: () =>
          isPlaying ? fileController.pause() : fileController.play(),
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
    isRecording ||
    fileController.modeState.status === "playing" ||
    fileController.modeState.status === "paused";

  const startAction = () => {
    setIsEditorOpen(false);
    primaryAction.onClick();
  };

  const actionHint = needsSetup
    ? t.hintNeedText
    : isFileMode
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

  const ghostButton =
    "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium text-white/60 transition duration-200 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70";

  return (
    <div
      className="flex min-h-dvh w-full flex-col"
      style={{ backgroundColor, color: textColor }}
    >
      <AsrScriptBridge />

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-4 sm:px-6 sm:py-6">
        <header className="flex items-baseline justify-between gap-3 px-1 pb-3">
          <h1 className="truncate text-sm font-semibold tracking-[-0.01em] text-white/90">
            {t.title}
          </h1>
          <p
            aria-live="polite"
            className="flex shrink-0 items-center gap-1.5 text-xs text-white/50"
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                isRecording || isPlaying
                  ? "bg-emerald-400"
                  : isModelReady || canPlay
                    ? "bg-white/40"
                    : "bg-amber-400/80"
              }`}
            />
            {statusLabel}
          </p>
        </header>

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] transition duration-200 focus-within:border-white/20">
          <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs sm:px-4">
            {showEditor ? (
              <h2 className="pl-1 font-medium text-white/60">{t.setupTitle}</h2>
            ) : (
              <>
                <span className="pl-1 tabular-nums text-white/50">
                  {t.wordProgress}{" "}
                  <span className="font-semibold text-white/85">
                    {Math.min(highlightedWordIndex + 1, totalWords)}
                  </span>
                  <span className="text-white/35"> / {totalWords}</span>
                </span>
                <span className="inline-flex items-center gap-3 text-white/55">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-4 rounded bg-emerald-400"
                    />
                    {t.legendRecognised}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-4 rounded bg-emerald-400/20 ring-1 ring-emerald-300/60"
                    />
                    {t.legendPredicted}
                  </span>
                  <span className="tabular-nums">
                    {t.paceShort}{" "}
                    {isActivePaceAvailable === false ? (
                      <span className="text-amber-200/90">
                        {t.paceUnavailable}
                      </span>
                    ) : wordsPerMinute === null ? (
                      t.paceMeasuring
                    ) : (
                      <>
                        <span className="font-semibold text-white/90">
                          {wordsPerMinute}
                        </span>{" "}
                        {t.wordsPerMinute}
                      </>
                    )}
                  </span>
                </span>
              </>
            )}

            <div className="ml-auto flex items-center gap-1">
              {showEditor ? (
                <>
                  <button
                    type="button"
                    onClick={() => setReferenceText(DEMO_TEXT)}
                    className={ghostButton}
                  >
                    {t.useDemo}
                  </button>
                  {!needsSetup && hasSession && (
                    <button
                      type="button"
                      onClick={() => setIsEditorOpen(false)}
                      className={ghostButton}
                    >
                      {t.hideEditor}
                    </button>
                  )}
                </>
              ) : (
                <>
                  {hasSession && (
                    <button
                      type="button"
                      onClick={handleReset}
                      title={t.resetTitle}
                      className={ghostButton}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {t.clear}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setIsEditorOpen(true)}
                    disabled={isRecording || isPlaying}
                    className={`${ghostButton} disabled:pointer-events-none disabled:opacity-40`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    {t.editText}
                  </button>
                </>
              )}
            </div>
          </div>

          {showEditor ? (
            <>
              <label htmlFor="reference-text" className="sr-only">
                {t.referenceLabel}
              </label>
              <textarea
                id="reference-text"
                autoFocus
                value={referenceText}
                onChange={(event) => setReferenceText(event.target.value)}
                placeholder={t.setupLead}
                className="min-h-[40vh] w-full flex-1 resize-none bg-transparent px-4 pb-4 text-lg leading-relaxed outline-none placeholder:text-white/30 sm:px-5"
              />
            </>
          ) : (
            <div className="flex min-h-[40vh] flex-1 items-center overflow-y-auto px-5 py-6 sm:px-10">
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
          )}

          {isFileMode && canPlay && (
            <div className="flex items-center gap-3 border-t border-white/10 px-4 py-2.5">
              <span className="min-w-0 max-w-[30%] truncate text-xs text-white/50">
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
                className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/15 accent-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
              />
              <span className="shrink-0 tabular-nums text-xs text-white/50">
                {formatSeconds(fileController.modeState.currentTimeSec)} /{" "}
                {formatSeconds(fileController.modeState.durationSec)}
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-white/10 bg-black/20 p-2.5 sm:p-3">
            <div
              role="group"
              aria-label={t.sourceLabel}
              className="flex shrink-0 rounded-full bg-white/[0.05] p-1"
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
                  aria-label={label}
                  title={label}
                  onClick={() => setSourceMode(key)}
                  className={`inline-flex h-8 cursor-pointer items-center gap-2 rounded-full px-3 text-xs font-medium transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 ${
                    sourceMode === key
                      ? "bg-white text-black"
                      : "text-white/55 hover:text-white"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>

            {isFileMode && (
              <label
                className={`${ghostButton} focus-within:ring-2 focus-within:ring-emerald-400/70`}
              >
                <Upload className="h-3.5 w-3.5" />
                {canPlay ? t.replaceFile : t.chooseFile}
                <input
                  type="file"
                  accept="audio/*"
                  className="sr-only"
                  onChange={handleFileChange}
                />
              </label>
            )}

            <p className="ml-auto mr-3 hidden text-right text-xs text-white/45 md:block">
              {actionHint}
            </p>

            <button
              type="button"
              onClick={startAction}
              disabled={primaryAction.disabled || needsSetup}
              title={actionHint}
              className={`ml-auto inline-flex h-10 cursor-pointer items-center gap-2 rounded-full px-5 text-sm font-semibold transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 md:ml-0 ${
                primaryAction.danger
                  ? "bg-red-500 text-white hover:bg-red-400"
                  : "bg-emerald-400 text-black hover:bg-emerald-300"
              } disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/35`}
            >
              {primaryAction.icon}
              {primaryAction.label}
            </button>
          </div>

          {fileController.modeState.errorMessage && (
            <p
              role="alert"
              className="border-t border-white/10 px-4 py-2 text-sm text-red-300"
            >
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

        <details className="group mt-3">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 px-1 text-xs text-white/35 transition duration-200 hover:text-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70">
            <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 group-open:rotate-180" />
            {t.devTools}
          </summary>

          <dl className="mt-2 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <dt className="text-xs text-white/45">{t.recentTranscript}</dt>
              <dd className="mt-1 break-words text-sm text-white/80">
                {activeAlignment.recentTranscript || "—"}
              </dd>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <dt className="text-xs text-white/45">{t.matchedPhrase}</dt>
              <dd className="mt-1 break-words text-sm text-white/80">
                {activeAlignment.matchedPhrase || "—"}
              </dd>
            </div>
          </dl>
        </details>
      </main>
    </div>
  );
}
