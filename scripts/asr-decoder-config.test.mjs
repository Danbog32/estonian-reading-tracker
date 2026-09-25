import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../public/onnx/asr-decoder-config.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context);

const workerSource = readFileSync(
  new URL("../public/onnx/asr-worker.js", import.meta.url),
  "utf8",
);
const workerContext = vm.createContext({
  importScripts() {},
  self: {
    AsrDecoderConfig: context.AsrDecoderConfig,
    postMessage() {},
  },
});
vm.runInContext(workerSource, workerContext);

const {
  buildHotwordsBuffer,
  resolveDecoderConfig,
  utf8ByteLength,
} = context.AsrDecoderConfig;

test("preserves greedy search defaults without reference bias", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(resolveDecoderConfig())),
    {
      method: "greedy_search",
      maxActivePaths: 4,
      modelingUnit: "cjkchar",
      bpeVocab: "",
      hotwordsBuf: "",
      hotwordsBufSize: 0,
      hotwordsScore: 1.5,
      referenceWordCount: 0,
      referenceBiasEnabled: false,
    },
  );
});

test("configures modified beam search without claiming bias is active", () => {
  const config = resolveDecoderConfig({ method: "modified_beam_search" });

  assert.equal(config.method, "modified_beam_search");
  assert.equal(config.maxActivePaths, 8);
  assert.equal(config.referenceBiasEnabled, false);
  assert.equal(config.referenceWordCount, 0);
});

test("builds a normalized, bounded, unique hotword buffer", () => {
  assert.equal(
    buildHotwordsBuffer(["Keegi,", "LAULIS", "keegi", "oksal!"], 3),
    "keegi\nlaulis",
  );
});

test("configures BPE reference bias only when its vocabulary is supplied", () => {
  const config = resolveDecoderConfig({
    method: "modified_beam_search",
    referenceWords: ["Keegi", "laulis", "õues"],
    bpeVocab: "./bpe.vocab",
    hotwordsScore: 2,
  });

  assert.equal(config.hotwordsBuf, "keegi\nlaulis\nõues");
  assert.equal(config.hotwordsBufSize, utf8ByteLength(config.hotwordsBuf));
  assert.equal(config.referenceBiasEnabled, true);
  assert.equal(config.referenceWordCount, 3);
  assert.equal(config.hotwordsScore, 2);
});

test("maps resolved decoder options to the sherpa wrapper contract", () => {
  const decoding = resolveDecoderConfig({
    method: "modified_beam_search",
    referenceWords: ["Keegi", "laulis"],
    bpeVocab: "./bpe.vocab",
    hotwordsScore: 0,
  });
  const config = workerContext.buildRecognizerConfig("vad", decoding);

  assert.equal(config.decodingMethod, "modified_beam_search");
  assert.equal(config.maxActivePaths, 8);
  assert.equal(config.modelConfig.modelingUnit, "bpe");
  assert.equal(config.modelConfig.bpeVocab, "./bpe.vocab");
  assert.equal(config.hotwordsBuf, "keegi\nlaulis");
  assert.equal(config.hotwordsBufSize, 12);
  assert.equal(config.hotwordsScore, 0);
  assert.equal(config.enableEndpoint, 0);
});

test("defaults the worker to the bundled bpe vocabulary for reference bias", () => {
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        workerContext.withBpeVocabPath({
          method: "modified_beam_search",
          referenceWords: ["keegi", "laulis"],
        }),
      ),
    ),
    {
      method: "modified_beam_search",
      referenceWords: ["keegi", "laulis"],
      bpeVocab: "./bpe.vocab",
    },
  );
});

test("leaves decoder options untouched without reference words", () => {
  const options = { method: "modified_beam_search" };

  assert.equal(workerContext.withBpeVocabPath(options), options);
  assert.equal(workerContext.withBpeVocabPath(null), null);
});

test("keeps all reference words for a full reading text", () => {
  const referenceWords = Array.from({ length: 73 }, (_, index) => `sõna${index}`);
  const config = resolveDecoderConfig({
    method: "modified_beam_search",
    referenceWords,
    bpeVocab: "./bpe.vocab",
  });

  assert.equal(config.referenceWordCount, 64);
  assert.equal(
    resolveDecoderConfig({
      method: "modified_beam_search",
      referenceWords,
      referenceWordLimit: 256,
      bpeVocab: "./bpe.vocab",
    }).referenceWordCount,
    73,
  );
});

test("rejects reference words with greedy search", () => {
  assert.throws(
    () => resolveDecoderConfig({ referenceWords: ["keegi"] }),
    /requires modified_beam_search/,
  );
});

test("rejects BPE reference bias without a compatible vocabulary", () => {
  assert.throws(
    () =>
      resolveDecoderConfig({
        method: "modified_beam_search",
        referenceWords: ["keegi"],
      }),
    /requires a compatible bpe\.vocab asset/,
  );
});
