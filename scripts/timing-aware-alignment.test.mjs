import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadTypeScriptModule(filePath, dependencies = {}) {
  const ts = require("typescript");
  const source = fs.readFileSync(filePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: (specifier) => dependencies[specifier] ?? require(specifier),
  });
  return module.exports;
}

const alignment = loadTypeScriptModule("app/text-alignment/alignment.ts");
const evidence = loadTypeScriptModule(
  "app/text-alignment/asrEvidence.ts",
  { "./alignment": alignment },
);
const probabilistic = loadTypeScriptModule(
  "app/text-alignment/probabilisticAlignment.ts",
  { "./alignment": alignment },
);
const timing = loadTypeScriptModule(
  "app/text-alignment/timingAwareAlignment.ts",
  {
    "./alignment": alignment,
    "./asrEvidence": evidence,
    "./probabilisticAlignment": probabilistic,
  },
);

test("groups BPE pieces into words with absolute timing and confidence", () => {
  const words = evidence.buildAsrWordEvidence({
    tokens: [" nä", "gi", " li", "nd"],
    tokenTimestamps: [1.68, 1.96, 2.32, 2.52],
    tokenSourceTimestamps: [16.68, 16.96, 17.32, 17.52],
    tokenLogProbabilities: [-0.37, -0.38, -0.34, -0.74],
  });

  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        words.map(({ word, startSec, tokenStartIndex, tokenEndIndex }) => ({
          word,
          startSec,
          tokenStartIndex,
          tokenEndIndex,
        })),
      ),
    ),
    [
      { word: "nägi", startSec: 16.68, tokenStartIndex: 0, tokenEndIndex: 1 },
      { word: "lind", startSec: 17.32, tokenStartIndex: 2, tokenEndIndex: 3 },
    ],
  );
  assert.ok(words[0].confidence > 0 && words[0].confidence < 1);
});

test("keeps a fresh fuzzy partial on the currently spoken word", () => {
  const referenceWords = alignment.parseReferenceText(
    "Keegi laulis oksal. Uku vaatas üles.",
  );
  let state = timing.alignTranscriptWithTiming(
    referenceWords,
    "keegi",
    timing.INITIAL_TIMING_AWARE_ALIGNMENT_STATE,
    {
      type: "partial",
      utteranceId: "u1",
      sourceTimeSec: 0.8,
      tokens: [" ke", "egi"],
      tokenSourceTimestamps: [0.2, 0.4],
      tokenLogProbabilities: [-0.2, -0.2],
      combinedTranscriptText: "keegi",
    },
  );
  state = timing.alignTranscriptWithTiming(
    referenceWords,
    "keegi laulis",
    state,
    {
      type: "partial",
      utteranceId: "u1",
      sourceTimeSec: 1.6,
      tokens: [" ke", "egi", " la", "ulis"],
      tokenSourceTimestamps: [0.2, 0.4, 1.0, 1.3],
      tokenLogProbabilities: [-0.2, -0.2, -0.2, -0.2],
      combinedTranscriptText: "keegi laulis",
    },
  );
  state = timing.alignTranscriptWithTiming(
    referenceWords,
    "keegi laulis oskar",
    state,
    {
      type: "partial",
      utteranceId: "u1",
      sourceTimeSec: 3.1,
      tokens: [" ke", "egi", " la", "ulis", " os", "kar"],
      tokenSourceTimestamps: [0.2, 0.4, 1.0, 1.3, 2.7, 2.9],
      tokenLogProbabilities: [-0.2, -0.2, -0.2, -0.2, -0.8, -0.9],
      combinedTranscriptText: "keegi laulis oskar",
    },
  );

  assert.equal(state.currentWordIndex, 2);
  assert.equal(state.matchedPhrase, "oksal.");
  assert.ok(state.latestTokenAgeSec < 0.32);
});

test("final evidence can complete the last word", () => {
  const referenceWords = alignment.parseReferenceText("Mina loen raamatut.");
  const state = timing.alignTranscriptWithTiming(
    referenceWords,
    "mina loen",
    timing.INITIAL_TIMING_AWARE_ALIGNMENT_STATE,
    {
      type: "final",
      utteranceId: "u1",
      sourceTimeSec: 2.4,
      tokens: [" mina", " lo", "en"],
      tokenSourceTimestamps: [0.2, 1.0, 1.2],
      tokenLogProbabilities: [-0.2, -0.2, -0.2],
      combinedTranscriptText: "mina loen",
    },
  );

  assert.equal(state.currentWordIndex, 2);
});

test("does not feed unchanged transcript into local DP twice", () => {
  const referenceWords = alignment.parseReferenceText(
    "Keegi laulis oksal. Uku vaatas üles.",
  );
  const signal = {
    type: "partial",
    utteranceId: "u1",
    sourceTimeSec: 3.1,
    tokens: [" ke", "egi", " la", "ulis", " os", "kar"],
    tokenSourceTimestamps: [0.2, 0.4, 1.0, 1.3, 2.7, 2.9],
    tokenLogProbabilities: [-0.2, -0.2, -0.2, -0.2, -0.8, -0.9],
    combinedTranscriptText: "keegi laulis oskar",
  };
  const first = timing.alignTranscriptWithTiming(
    referenceWords,
    "keegi laulis oskar",
    timing.INITIAL_TIMING_AWARE_ALIGNMENT_STATE,
    signal,
  );
  const second = timing.alignTranscriptWithTiming(
    referenceWords,
    "keegi laulis oskar",
    first,
    { ...signal, sourceTimeSec: 3.6 },
  );

  assert.equal(
    second.localState.currentWordIndex,
    first.localState.currentWordIndex,
  );
});
