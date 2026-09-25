// VAD worker: runs sherpa-onnx Silero VAD off the main thread.

const runtimeState = {
  bootstrapped: false,
  loading: false,
  ready: false,
  readyPromise: null,
};

let vad = null;
let paused = false;
let speechActive = false;
// Optional per-window voice flags, used by text alignment to measure reading pace.
let pendingSamples = new Float32Array(0);
let flagsSampleOffset = 0;
let flagsGeneration = 0;
let config = {
  sileroVad: {
    model: "./silero_vad.onnx",
    threshold: 0.5,
    minSilenceDuration: 1.0,
    minSpeechDuration: 0.25,
    maxSpeechDuration: 20,
    windowSize: 512,
  },
  tenVad: {
    model: "",
    threshold: 0.5,
    minSilenceDuration: 1.0,
    minSpeechDuration: 0.25,
    maxSpeechDuration: 20,
    windowSize: 256,
  },
  sampleRate: 16000,
  numThreads: 1,
  provider: "cpu",
  debug: 0,
  bufferSizeInSeconds: 30,
};
let initRequested = false;
let initNotified = false;

function getModule() {
  self.Module = self.Module || {};
  return self.Module;
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
      maybeInitializeVad();
    };

    try {
      if (!runtimeState.bootstrapped) {
        runtimeState.bootstrapped = true;
        importScripts("/onnx/sherpa-onnx-vad.js");
        importScripts("/onnx/sherpa-onnx-wasm-main-vad.js");
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

function freeVad() {
  try {
    vad?.free?.();
  } catch (_) {
    // Ignore teardown failures.
  }
  vad = null;
  speechActive = false;
}

function drainSegments() {
  if (!vad) {
    return;
  }

  while (!vad.isEmpty()) {
    const segment = vad.front();
    vad.pop();
    speechActive = false;
    self.postMessage({
      type: "speech_end",
      start: segment.start,
      sampleCount: segment.samples.length,
    });
  }
}

function processSamplesWithFlags(samples) {
  const windowSize = config.sileroVad?.windowSize || 512;
  const joined = new Float32Array(pendingSamples.length + samples.length);
  joined.set(pendingSamples);
  joined.set(samples, pendingSamples.length);

  const windowCount = Math.floor(joined.length / windowSize);
  const flags = new Uint8Array(windowCount);
  const startSample = flagsSampleOffset;

  for (let index = 0; index < windowCount; index += 1) {
    const wasDetected = speechActive;
    vad.acceptWaveform(joined.subarray(index * windowSize, (index + 1) * windowSize));
    const detected = vad.isDetected();
    flags[index] = detected ? 1 : 0;
    if (detected && !wasDetected) {
      speechActive = true;
      self.postMessage({ type: "speech_start" });
    }
    drainSegments();
  }

  pendingSamples = joined.slice(windowCount * windowSize);
  flagsSampleOffset += windowCount * windowSize;

  if (windowCount > 0) {
    self.postMessage(
      {
        type: "voice_flags",
        generation: flagsGeneration,
        startSample,
        windowSize,
        flags,
      },
      [flags.buffer]
    );
  }
}

function processSamples(samples) {
  if (paused || !vad || !samples?.length) {
    return;
  }

  if (config.emitVoiceFlags) {
    processSamplesWithFlags(samples);
    return;
  }

  const wasDetected = speechActive;
  vad.acceptWaveform(samples);

  if (vad.isDetected() && !wasDetected) {
    speechActive = true;
    self.postMessage({ type: "speech_start" });
  }

  drainSegments();
}

function maybeInitializeVad() {
  if (!runtimeState.ready || !initRequested || initNotified) {
    return;
  }

  try {
    const module = getModule();
    freeVad();
    vad = createVad(module, config);
    initNotified = true;
    self.postMessage({ type: "initialized", voiceFlags: true });
  } catch (e) {
    postInitError(e);
  }
}

self.onmessage = function (e) {
  const msg = e.data || {};

  switch (msg.type) {
    case "init": {
      if (msg.config && typeof msg.config === "object") {
        config = {
          ...config,
          ...msg.config,
          sileroVad: {
            ...config.sileroVad,
            ...(msg.config.sileroVad || {}),
          },
          tenVad: {
            ...config.tenVad,
            ...(msg.config.tenVad || {}),
          },
        };
      }
      initRequested = true;
      initNotified = false;
      bootstrapRuntimeOnce().then(maybeInitializeVad).catch(postInitError);
      maybeInitializeVad();
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
    case "audio": {
      let samples = msg.samples;
      if (!(samples instanceof Float32Array) && samples?.buffer) {
        samples = new Float32Array(samples);
      }
      processSamples(samples);
      break;
    }
    case "flush": {
      try {
        vad?.flush();
      } catch (_) {
        // Ignore flush failures.
      }
      drainSegments();
      break;
    }
    case "reset": {
      try {
        vad?.reset();
      } catch (_) {
        // Ignore reset failures.
      }
      speechActive = false;
      pendingSamples = new Float32Array(0);
      flagsSampleOffset = 0;
      if (typeof msg.generation === "number") {
        flagsGeneration = msg.generation;
      }
      break;
    }
    case "free": {
      initNotified = false;
      freeVad();
      break;
    }
  }
};
