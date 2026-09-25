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
const evidence = loadTypeScriptModule("app/text-alignment/asrEvidence.ts", {
  "./alignment": alignment,
});
const voice = loadTypeScriptModule("app/text-alignment/voiceTimeline.ts");
const pace = loadTypeScriptModule("app/text-alignment/pacePredictor.ts", {
  "./alignment": alignment,
  "./asrEvidence": evidence,
});

const referenceWords = alignment.parseReferenceText("laps loeb raamatut raamat on paks");
// Child reads at 0.2 s per letter: laps and loeb 0.8 s, raamatut 1.6 s, raamat 1.2 s.
const onsets = { laps: 0, loeb: 0.8, raamatut: 1.6 };
const allVoiced = (fromSec, toSec) => Math.max(0, toSec - fromSec);

function evidenceFor(words, delaySec = 0) {
  return {
    tokens: words.map((word) => ` ${word}`),
    tokenSourceTimestamps: words.map((word) => onsets[word] + delaySec),
  };
}

function readThroughRaamatut({ voicedSeconds = allVoiced, delaySec = 0, overrides = {} } = {}) {
  const steps = [
    { nowSec: 0.5, matcherIndex: 1, words: ["laps"] },
    { nowSec: 1.3, matcherIndex: 2, words: ["laps", "loeb"] },
    { nowSec: 2.1, matcherIndex: 3, words: ["laps", "loeb", "raamatut"] },
  ];
  let state = pace.INITIAL_PACE_PREDICTOR_STATE;
  for (const step of steps) {
    state = pace.predictReadingPosition(
      state,
      {
        referenceWords,
        matcherIndex: step.matcherIndex,
        matcherHasLock: true,
        nowSec: step.nowSec,
        evidence: evidenceFor(step.words, delaySec),
        voicedSeconds,
        tokenDelaySec: delaySec,
      },
      overrides,
    );
  }
  return state;
}

function tick(state, nowSec, { voicedSeconds = allVoiced, delaySec = 0, overrides = {} } = {}) {
  return pace.predictReadingPosition(
    state,
    {
      referenceWords,
      matcherIndex: 3,
      matcherHasLock: true,
      nowSec,
      evidence: evidenceFor(["laps", "loeb", "raamatut"], delaySec),
      voicedSeconds,
      tokenDelaySec: delaySec,
    },
    overrides,
  );
}

test("pace is the median of recent words and needs a minimum history", () => {
  const options = { ...pace.DEFAULT_PACE_PREDICTOR_OPTIONS };
  assert.equal(pace.getPace([0.2], options), null);
  assert.equal(pace.getPace([0.2, 0.4], options), 0.30000000000000004);
  assert.equal(pace.getPace([0.1, 0.2, 5], options), 0.2);
});

test("measures pace from confirmed word onsets", () => {
  const state = readThroughRaamatut();
  assert.deepEqual([...state.paceHistory].map((value) => Number(value.toFixed(3))), [0.2, 0.2]);
  assert.equal(Number(state.paceSecPerUnit.toFixed(3)), 0.2);
  assert.equal(state.anchorIndex, 2);
});

test("runs ahead of the matcher once the anchor word's voiced time is used up", () => {
  const state = readThroughRaamatut();
  // 3.6 s of voice since raamatut began covers raamatut (1.6 s) and raamat (1.2 s).
  assert.equal(tick(state, 5.2).predictedIndex, 4);
});

test("never runs more than the lead limit past the anchor", () => {
  const state = readThroughRaamatut();
  assert.equal(tick(state, 60).predictedIndex, 4);
});

test("does not advance while the child is silent", () => {
  const silentAfter = (fromSec, toSec) => Math.max(0, Math.min(toSec, 2.1) - fromSec);
  const state = readThroughRaamatut({ voicedSeconds: silentAfter });
  assert.equal(tick(state, 5.2, { voicedSeconds: silentAfter }).predictedIndex, 3);
});

test("by default never sits behind the matcher", () => {
  // At 2.4 s raamatut has used 0.8 s of its 1.6 s, so a holding predictor stays on it.
  const overrides = { allowBehindMatcher: true };
  assert.equal(tick(readThroughRaamatut(), 2.4).predictedIndex, 3);
  assert.equal(tick(readThroughRaamatut({ overrides }), 2.4, { overrides }).predictedIndex, 2);
});

test("ignores a held word when measuring pace", () => {
  const state = readThroughRaamatut();
  const held = pace.predictReadingPosition(state, {
    referenceWords,
    matcherIndex: 4,
    matcherHasLock: true,
    nowSec: 9,
    evidence: {
      tokens: [" raamatut", " raamat"],
      tokenSourceTimestamps: [1.6, 8.5],
    },
    voicedSeconds: allVoiced,
  });
  // raamatut took 6.9 s, far beyond 2.5 times the pace, so the history is unchanged.
  assert.equal(held.paceHistory.length, 2);
});

test("subtracting the token delay recovers the same prediction", () => {
  const direct = tick(readThroughRaamatut(), 5.2);
  const delayed = tick(readThroughRaamatut({ delaySec: 0.8 }), 5.2, { delaySec: 0.8 });
  assert.equal(delayed.predictedIndex, direct.predictedIndex);
  assert.equal(Number(delayed.anchorOnsetSec.toFixed(3)), Number(direct.anchorOnsetSec.toFixed(3)));
});

test("voice timeline counts only reported voiced windows on the source clock", () => {
  const timeline = voice.createVoiceTimeline(16000);
  timeline.reset(10);
  // 512-sample windows are 32 ms; voice, voice, silence, voice.
  timeline.append(0, 512, [1, 1, 0, 1]);
  assert.equal(Number(timeline.voicedSeconds(10, 10.128).toFixed(3)), 0.096);
  assert.equal(Number(timeline.voicedSeconds(10.032, 10.096).toFixed(3)), 0.032);
  // Windows not yet reported do not count.
  assert.equal(Number(timeline.voicedSeconds(10, 11).toFixed(3)), 0.096);
  timeline.reset(0);
  assert.equal(timeline.voicedSeconds(0, 1), 0);
});
