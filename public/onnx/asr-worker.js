// ASR worker: runs sherpa-onnx recognizer off the main thread.

const runtimeState = {
  bootstrapped: false,
  loading: false,
  ready: false,
  readyPromise: null,
};

// Forward the worker's cache-busting query so the config matches this worker version.
importScripts("/onnx/asr-decoder-config.js" + (self.location?.search ?? ""));

let recognizer = null;
let recognizerStream = null;
let expectedSampleRate = 16000;
let lastDecodeTs = 0;
let lastText = "";
let paused = false;
let segmentationMode = "vad";
let legacyUtteranceCounter = 0;
let currentUtteranceId = null;
let currentSourceType = "microphone";
let currentSourceTimeSec = null;
let currentSourceDurationSec = null;
let currentSourceStartTimeSec = null;
// Source time of the first sample the current sherpa stream received. Sherpa
// keeps counting frames across recognizer.reset(), so this survives resets and
// is only cleared when the stream itself is recreated.
let streamOriginSourceTimeSec = null;
let currentStreamSampleCount = 0;
let lastResultMetadata = null;
let decoderOptions = null;
let activeDecoderConfig = null;

const BPE_VOCAB_URL = "/onnx/bpe.vocab";
const BPE_VOCAB_FS_PATH = "./bpe.vocab";
let bpeVocabText = null;
let bpeVocabPromise = null;
let bpeVocabInstalled = false;

let sabEnabled = false;
let ringData = null;
let ringCtrl = null;
let ringCapacity = 0;
const IDX_WRITE = 0;
const IDX_READ = 1;
let initRequested = false;
let initNotified = false;

function getModule() {
  self.Module = self.Module || {};
  return self.Module;
}

function needsReferenceBias(options) {
  return (
    Array.isArray(options?.referenceWords) && options.referenceWords.length > 0
  );
}

function loadBpeVocabOnce() {
  if (bpeVocabPromise) {
    return bpeVocabPromise;
  }

  bpeVocabPromise = fetch(BPE_VOCAB_URL)
    .then((response) => {
      if (!response.ok) {
        throw new Error(
          `Failed to load ${BPE_VOCAB_URL}: ${response.status} ${response.statusText}`
        );
      }
      return response.text();
    })
    .then((text) => {
      if (!text.trim()) {
        throw new Error(`${BPE_VOCAB_URL} is empty`);
      }
      bpeVocabText = text;
    })
    .catch((error) => {
      bpeVocabPromise = null;
      throw error;
    });

  return bpeVocabPromise;
}

function withBpeVocabPath(options) {
  if (
    !needsReferenceBias(options) ||
    !self.AsrDecoderConfig.usesBpeVocab(options.modelingUnit)
  ) {
    return options;
  }

  return {
    ...options,
    bpeVocab: options.bpeVocab || BPE_VOCAB_FS_PATH,
  };
}

// sherpa-onnx tokenizes hotwords by reading bpeVocab from the wasm filesystem,
// so the fetched vocabulary has to exist there before the recognizer is built.
function installBpeVocab() {
  if (bpeVocabInstalled) {
    return;
  }

  const module = getModule();
  const bytes = new TextEncoder().encode(bpeVocabText);

  try {
    module.FS_unlink("/bpe.vocab");
  } catch (_) {
    // The file does not exist yet on the first install.
  }

  module.FS_createDataFile("/", "bpe.vocab", bytes, true, true, true);
  bpeVocabInstalled = true;
}

function postInitError(error) {
  self.postMessage({
    type: "error",
    stage: "init",
    error: String(error),
  });
}

function bootstrapRuntimeOnce() {
  if (runtimeState.readyPromise) {
    return runtimeState.readyPromise;
  }

  runtimeState.loading = true;
  runtimeState.readyPromise = new Promise((resolve, reject) => {
    const module = getModule();
    const previousOnRuntimeInitialized = module.onRuntimeInitialized;

    module.locateFile = function (path) {
      return "/onnx/" + path;
    };

    module.onRuntimeInitialized = function () {
      runtimeState.ready = true;
      runtimeState.loading = false;
      if (typeof previousOnRuntimeInitialized === "function") {
        previousOnRuntimeInitialized();
      }
      resolve(module);
      maybeInitializeRecognizer();
    };

    try {
      if (!runtimeState.bootstrapped) {
        runtimeState.bootstrapped = true;
        importScripts("/onnx/sherpa-onnx-asr.js");
        importScripts("/onnx/sherpa-onnx-wasm-main-asr-v2.js");
      } else if (runtimeState.ready) {
        resolve(module);
      }
    } catch (error) {
      runtimeState.loading = false;
      reject(error);
    }
  });

  return runtimeState.readyPromise;
}

function buildRecognizerConfig(mode, decoding = {}) {
  return {
    featConfig: {
      sampleRate: 16000,
      featureDim: 80,
    },
    modelConfig: {
      transducer: {
        encoder: "./encoder.onnx",
        decoder: "./decoder.onnx",
        joiner: "./joiner.onnx",
      },
      paraformer: {
        encoder: "",
        decoder: "",
      },
      zipformer2Ctc: {
        model: "",
      },
      tokens: "./tokens.txt",
      numThreads: 1,
      provider: "cpu",
      debug: 0,
      modelType: "",
      modelingUnit: decoding.modelingUnit || "bpe",
      bpeVocab: decoding.bpeVocab || "",
    },
    decodingMethod: decoding.method || "greedy_search",
    maxActivePaths: decoding.maxActivePaths || 4,
    enableEndpoint: mode === "legacy" ? 1 : 0,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
    hotwordsFile: "",
    hotwordsBuf: decoding.hotwordsBuf || "",
    hotwordsBufSize: decoding.hotwordsBufSize || 0,
    hotwordsScore: decoding.hotwordsScore ?? 1.5,
    ctcFstDecoderConfig: {
      graph: "",
      maxActive: 3000,
    },
    ruleFsts: "",
    ruleFars: "",
  };
}

function ensureRecognizerStream() {
  if (!recognizer) {
    return null;
  }

  if (!recognizerStream) {
    recognizerStream = recognizer.createStream();
  }

  return recognizerStream;
}

function freeRecognizer() {
  try {
    recognizerStream?.free?.();
  } catch (_) {
    // Ignore stream teardown errors.
  }
  recognizerStream = null;
  streamOriginSourceTimeSec = null;

  try {
    recognizer?.free?.();
  } catch (_) {
    // Ignore recognizer teardown errors.
  }
  recognizer = null;
}

// A new source must start on a new stream. recognizer.reset() keeps audio the
// stream already buffered, which would leak the end of the previous source into
// the next one and shift its timestamps.
function recreateRecognizerStream() {
  try {
    recognizerStream?.free?.();
  } catch (_) {
    // Ignore stream teardown errors.
  }
  recognizerStream = null;
  streamOriginSourceTimeSec = null;
  resetStreamState();
}

function resetStreamState() {
  if (recognizer && recognizerStream) {
    try {
      recognizer.reset(recognizerStream);
    } catch (_) {
      // Best effort reset.
    }
  }

  lastText = "";
  lastDecodeTs = 0;
  currentUtteranceId = null;
  currentSourceType = "microphone";
  currentSourceTimeSec = null;
  currentSourceDurationSec = null;
  currentSourceStartTimeSec = null;
  currentStreamSampleCount = 0;
  lastResultMetadata = null;
}

function updateSourceContext(message = {}) {
  currentSourceType = message.sourceType === "file" ? "file" : "microphone";
  currentSourceTimeSec =
    typeof message.sourceTimeSec === "number" ? message.sourceTimeSec : null;
  currentSourceDurationSec =
    typeof message.sourceDurationSec === "number" ? message.sourceDurationSec : null;
}

function getResultMetadata(result) {
  if (!result || typeof result !== "object") {
    return {
      text: "",
      tokens: [],
      tokenTimestamps: [],
      tokenLogProbabilities: [],
    };
  }

  const tokens = Array.isArray(result.tokens)
    ? result.tokens.filter((token) => typeof token === "string")
    : [];
  const tokenTimestamps =
    Array.isArray(result.timestamps) && result.timestamps.length === tokens.length
      ? result.timestamps.filter((value) => Number.isFinite(value))
      : [];
  const rawProbabilities = Array.isArray(result.ys_log_probs)
    ? result.ys_log_probs
    : Array.isArray(result.ys_probs)
      ? result.ys_probs
      : [];
  const tokenLogProbabilities =
    rawProbabilities.length === tokens.length
      ? rawProbabilities.filter((value) => Number.isFinite(value))
      : [];

  return {
    text: typeof result.text === "string" ? result.text : "",
    // Start of the current segment, in seconds since the stream was created.
    segmentStartSec: Number.isFinite(result.start_time) ? result.start_time : null,
    tokens,
    tokenTimestamps:
      tokenTimestamps.length === tokens.length ? tokenTimestamps : [],
    tokenLogProbabilities:
      tokenLogProbabilities.length === tokens.length
        ? tokenLogProbabilities
        : [],
  };
}

function buildRecognitionMessage(type, utteranceId, result) {
  const effectiveSourceTimeSec =
    typeof currentSourceTimeSec === "number"
      ? currentSourceTimeSec
      : currentStreamSampleCount / expectedSampleRate;
  // Sherpa token timestamps are relative to the start of the current segment.
  // Anchor them with sherpa's own segment start rather than the first chunk the
  // worker saw after a reset, which ignores audio the stream still buffered.
  const tokenSourceTimestamps =
    typeof streamOriginSourceTimeSec === "number" &&
    typeof result.segmentStartSec === "number"
      ? result.tokenTimestamps.map(
          (timestamp) =>
            streamOriginSourceTimeSec + result.segmentStartSec + timestamp
        )
      : typeof currentSourceStartTimeSec === "number"
        ? result.tokenTimestamps.map(
            (timestamp) => currentSourceStartTimeSec + timestamp
          )
        : result.tokenTimestamps;

  return {
    type,
    utteranceId,
    text: result.text,
    tokens: result.tokens,
    tokenTimestamps: result.tokenTimestamps,
    tokenSourceTimestamps,
    segmentStartSec: result.segmentStartSec ?? null,
    tokenLogProbabilities: result.tokenLogProbabilities,
    sourceType: currentSourceType,
    sourceTimeSec: effectiveSourceTimeSec,
    sourceDurationSec: currentSourceDurationSec,
  };
}

function emitPartial(result) {
  if (!result.text || result.text === lastText) {
    return;
  }

  lastText = result.text;
  lastResultMetadata = result;

  if (segmentationMode === "vad") {
    if (!currentUtteranceId) {
      return;
    }

    self.postMessage(
      buildRecognitionMessage("partial", currentUtteranceId, result)
    );
    return;
  }

  if (!currentUtteranceId) {
    legacyUtteranceCounter += 1;
    currentUtteranceId = `legacy-${legacyUtteranceCounter}`;
  }

  self.postMessage(
    buildRecognitionMessage("partial", currentUtteranceId, result)
  );
}

function decodeReadyFrames() {
  if (!recognizer || !recognizerStream) {
    return getResultMetadata(null);
  }

  while (recognizer.isReady(recognizerStream)) {
    recognizer.decode(recognizerStream);
  }

  let result = recognizer.getResult(recognizerStream);

  try {
    if (recognizer.config.modelConfig.paraformer.encoder !== "") {
      const tailPaddings = new Float32Array(expectedSampleRate);
      recognizerStream.acceptWaveform(expectedSampleRate, tailPaddings);
      while (recognizer.isReady(recognizerStream)) {
        recognizer.decode(recognizerStream);
      }
      result = recognizer.getResult(recognizerStream);
    }
  } catch (_) {
    // Best effort flush for paraformer models.
  }

  return getResultMetadata(result);
}

function finalizeCurrentUtterance(forceInputFinished, shouldNotifyFlush = false) {
  if (!recognizer || !recognizerStream) {
    if (shouldNotifyFlush) {
      self.postMessage({ type: "flush_complete" });
    }
    return;
  }

  const activeUtteranceId =
    currentUtteranceId ||
    (segmentationMode === "legacy"
      ? `legacy-${legacyUtteranceCounter + 1}`
      : null);

  if (!activeUtteranceId) {
    resetStreamState();
    if (shouldNotifyFlush) {
      self.postMessage({ type: "flush_complete" });
    }
    return;
  }

  if (!currentUtteranceId && segmentationMode === "legacy") {
    legacyUtteranceCounter += 1;
    currentUtteranceId = activeUtteranceId;
  }

  try {
    if (forceInputFinished) {
      recognizerStream.inputFinished();
    }
  } catch (_) {
    // Some recognizers may ignore this if the stream is already finished.
  }

  const decodedResult = decodeReadyFrames();
  const finalResult = decodedResult.text
    ? decodedResult
    : lastResultMetadata || {
        text: lastText,
        tokens: [],
        tokenTimestamps: [],
        tokenLogProbabilities: [],
      };

  if (finalResult.text.length > 0) {
    self.postMessage(
      buildRecognitionMessage("final", activeUtteranceId, finalResult)
    );
  }

  resetStreamState();
  if (shouldNotifyFlush) {
    self.postMessage({ type: "flush_complete" });
  }
}

function processSamples(samples, options = {}) {
  if (paused || !recognizer) {
    return;
  }

  const stream = ensureRecognizerStream();
  if (!stream) {
    return;
  }

  if (
    currentSourceStartTimeSec === null &&
    typeof currentSourceTimeSec === "number"
  ) {
    currentSourceStartTimeSec = Math.max(
      0,
      currentSourceTimeSec - samples.length / expectedSampleRate
    );
  }
  if (
    streamOriginSourceTimeSec === null &&
    typeof currentSourceTimeSec === "number"
  ) {
    streamOriginSourceTimeSec = Math.max(
      0,
      currentSourceTimeSec - samples.length / expectedSampleRate
    );
  }

  stream.acceptWaveform(expectedSampleRate, samples);
  currentStreamSampleCount += samples.length;

  const now =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();

  if (!options.forceDecode && now - lastDecodeTs < 50) {
    return;
  }

  lastDecodeTs = now;
  const result = decodeReadyFrames();
  emitPartial(result);

  if (segmentationMode === "legacy" && recognizer.isEndpoint(recognizerStream)) {
    finalizeCurrentUtterance(false);
  }
}

function maybeInitializeRecognizer() {
  if (!runtimeState.ready || !initRequested || initNotified) {
    return;
  }

  const referenceBiasRequested =
    needsReferenceBias(decoderOptions) &&
    self.AsrDecoderConfig.usesBpeVocab(decoderOptions.modelingUnit);

  if (referenceBiasRequested && bpeVocabText === null) {
    // Wait for the vocabulary fetch started by the init message.
    return;
  }

  try {
    const module = getModule();

    if (referenceBiasRequested) {
      installBpeVocab();
    }

    activeDecoderConfig = self.AsrDecoderConfig.resolveDecoderConfig(
      withBpeVocabPath(decoderOptions)
    );
    freeRecognizer();
    recognizer = createOnlineRecognizer(
      module,
      buildRecognizerConfig(segmentationMode, activeDecoderConfig)
    );
    initNotified = true;
    self.postMessage({
      type: "initialized",
      mode: segmentationMode,
      decodingMethod: activeDecoderConfig.method,
      maxActivePaths: activeDecoderConfig.maxActivePaths,
      referenceBiasEnabled: activeDecoderConfig.referenceBiasEnabled,
      referenceWordCount: activeDecoderConfig.referenceWordCount,
      hotwordsScore: activeDecoderConfig.hotwordsScore,
    });
  } catch (e) {
    postInitError(e);
  }
}

self.onmessage = function (e) {
  const msg = e.data || {};

  switch (msg.type) {
    case "init": {
      if (typeof msg.expectedSampleRate === "number") {
        expectedSampleRate = msg.expectedSampleRate;
      }

      if (msg.mode === "legacy" || msg.mode === "vad") {
        segmentationMode = msg.mode;
      }
      decoderOptions = msg.decoderConfig ?? null;
      initRequested = true;
      initNotified = false;

      const pendingAssets =
        needsReferenceBias(decoderOptions) &&
        self.AsrDecoderConfig.usesBpeVocab(decoderOptions.modelingUnit)
          ? Promise.all([bootstrapRuntimeOnce(), loadBpeVocabOnce()])
          : bootstrapRuntimeOnce();

      pendingAssets.then(maybeInitializeRecognizer).catch(postInitError);
      maybeInitializeRecognizer();
      break;
    }
    case "pause": {
      paused = true;
      break;
    }
    case "resume": {
      paused = false;
      break;
    }
    case "begin_utterance": {
      updateSourceContext(msg);
      currentUtteranceId = msg.utteranceId || currentUtteranceId;
      if (currentUtteranceId && lastText) {
        self.postMessage(
          buildRecognitionMessage(
            "partial",
            currentUtteranceId,
            lastResultMetadata || {
              text: lastText,
              tokens: [],
              tokenTimestamps: [],
              tokenLogProbabilities: [],
            }
          )
        );
      }
      break;
    }
    case "end_utterance": {
      updateSourceContext(msg);
      finalizeCurrentUtterance(true, true);
      break;
    }
    case "force_finalize": {
      updateSourceContext(msg);
      finalizeCurrentUtterance(true, true);
      break;
    }
    case "sab_setup": {
      try {
        if (msg.dataSab && msg.controlSab && typeof msg.capacity === "number") {
          ringData = new Float32Array(msg.dataSab);
          ringCtrl = new Int32Array(msg.controlSab);
          ringCapacity = msg.capacity;
          sabEnabled = true;
          if (!self._sabInterval) {
            self._sabInterval = setInterval(drainRingToRecognizer, 16);
          }
        }
      } catch (_) {
        sabEnabled = false;
      }
      break;
    }
    case "audio": {
      updateSourceContext(msg);
      let samples = msg.samples;
      if (!(samples instanceof Float32Array) && samples?.buffer) {
        samples = new Float32Array(samples);
      }
      if (samples && samples.length) {
        processSamples(samples, {
          forceDecode: Boolean(msg.forceDecode),
        });
      }
      break;
    }
    case "reset": {
      recreateRecognizerStream();
      legacyUtteranceCounter = 0;
      break;
    }
    case "free": {
      initNotified = false;
      freeRecognizer();
      break;
    }
  }
};

function drainRingToRecognizer() {
  if (paused || !sabEnabled || !ringData || !ringCtrl) {
    return;
  }

  const writeIndex = Atomics.load(ringCtrl, IDX_WRITE);
  const readIndex = Atomics.load(ringCtrl, IDX_READ);
  const capacity = ringCapacity || ringData.length;
  const available = (writeIndex - readIndex + capacity) % capacity;

  if (available === 0) {
    return;
  }

  const toRead = Math.min(1024, available);
  const chunk = new Float32Array(toRead);
  const firstPart = Math.min(toRead, capacity - readIndex);

  if (firstPart > 0) {
    chunk.set(ringData.subarray(readIndex, readIndex + firstPart), 0);
  }

  const secondPart = toRead - firstPart;
  if (secondPart > 0) {
    chunk.set(ringData.subarray(0, secondPart), firstPart);
  }

  Atomics.store(ringCtrl, IDX_READ, (readIndex + toRead) % capacity);
  processSamples(chunk);
}
