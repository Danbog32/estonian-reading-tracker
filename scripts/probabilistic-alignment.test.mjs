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
const probabilistic = loadTypeScriptModule(
  "app/text-alignment/probabilisticAlignment.ts",
  { "./alignment": alignment },
);

function align(referenceText, updates) {
  const referenceWords = alignment.parseReferenceText(referenceText);
  let state = probabilistic.INITIAL_PROBABILISTIC_ALIGNMENT_STATE;
  for (const update of updates) {
    state = probabilistic.alignTranscriptProbabilistically(
      referenceWords,
      update.text,
      state,
      { type: update.type ?? "partial", utteranceId: update.utteranceId ?? "u1" },
    );
  }
  return state;
}

test("keeps a held partial pronunciation on the current word", () => {
  const state = align("Laps loeb raamatut. Raamat on paks.", [
    { text: "täpi" },
    { text: "täpi laps" },
    { text: "täpi laps lei" },
    { text: "täpi laps lei le" },
    { text: "täpi laps lei le lebu" },
  ]);

  assert.equal(state.currentWordIndex, 1);
  assert.equal(state.matchedPhrase, "loeb");
});

test("partial revisions do not multiply the stable prefix twice", () => {
  const reference = "Laps loeb raamatut. Raamat on paks.";
  const incremental = align(reference, [
    { text: "laps" },
    { text: "laps lo" },
    { text: "laps loeb" },
  ]);
  const direct = align(reference, [{ text: "laps loeb" }]);

  assert.equal(incremental.currentWordIndex, direct.currentWordIndex);
  assert.deepEqual(
    incremental.probabilities.map((value) => value.toFixed(10)),
    direct.probabilities.map((value) => value.toFixed(10)),
  );
});

test("can recover after one skipped reference word", () => {
  const state = align("Mina loen täna raamatut.", [
    { text: "mina loen raamatut", type: "final" },
  ]);

  assert.equal(state.currentWordIndex, 3);
  assert.notEqual(state.mode, "lost");
});

test("retains multiple nearby position hypotheses", () => {
  const state = align("Keegi laulis oksal. Uku vaatas üles.", [
    { text: "keegi laulis oskar" },
  ]);

  assert.ok(state.hypotheses.length >= 2);
  assert.ok(state.hypotheses[0].probability > state.hypotheses[1].probability);
  assert.ok(
    Math.abs(state.probabilities.reduce((sum, value) => sum + value, 0) - 1) < 1e-9,
  );
});
