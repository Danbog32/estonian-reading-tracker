#!/usr/bin/env node
// Exports a sherpa-onnx compatible `bpe.vocab` from a SentencePiece `bpe.model`.
//
// sherpa-onnx tokenizes hotwords with ssentencepiece, which reads a plain-text
// vocabulary of "<piece> <score>" lines instead of the binary model. This
// script parses the SentencePiece ModelProto directly so no Python or
// sentencepiece dependency is required.

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function readVarint(buffer, offset) {
  let result = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    cursor += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value: result, offset: cursor };
    shift += 7;
  }

  throw new Error("Truncated varint in SentencePiece model");
}

function parseSentencePiece(buffer) {
  const piece = { piece: "", score: 0, type: 1 };
  let offset = 0;

  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x07;

    if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const value = buffer.subarray(offset, offset + length.value);
      offset += length.value;
      if (fieldNumber === 1) piece.piece = value.toString("utf8");
    } else if (wireType === 5) {
      if (fieldNumber === 2) piece.score = buffer.readFloatLE(offset);
      offset += 4;
    } else if (wireType === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      if (fieldNumber === 3) piece.type = value.value;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      throw new Error(`Unsupported wire type ${wireType} in SentencePiece piece`);
    }
  }

  return piece;
}

function parseModelPieces(buffer) {
  const pieces = [];
  let offset = 0;

  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x07;

    if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const value = buffer.subarray(offset, offset + length.value);
      offset += length.value;
      if (fieldNumber === 1) pieces.push(parseSentencePiece(value));
    } else if (wireType === 0) {
      offset = readVarint(buffer, offset).offset;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      throw new Error(`Unsupported wire type ${wireType} in SentencePiece model`);
    }
  }

  return pieces;
}

function formatScore(score) {
  if (Number.isInteger(score)) return score.toFixed(1);
  return String(Number(score.toFixed(6)));
}

// The model tokens live inside the emscripten preload bundle, so the check
// against tokens.txt reads them straight out of the packaged .data file.
function readPackagedTokens(gluePath, dataPath) {
  const glue = fs.readFileSync(gluePath, "utf8");
  const entry = glue.match(
    /filename: "\/tokens\.txt", start: (\d+), end: (\d+)/,
  );

  if (!entry) {
    throw new Error(`Could not find tokens.txt offsets in ${gluePath}`);
  }

  const start = Number(entry[1]);
  const end = Number(entry[2]);
  return fs.readFileSync(dataPath).subarray(start, end).toString("utf8");
}

const args = parseArgs(process.argv.slice(2));
const modelPath = args.model ?? "public/onnx/bpe.model";
const outPath = args.out ?? "public/onnx/bpe.vocab";
const tokensPath = args.tokens ?? "";
const wasmName = args.wasm ?? "public/onnx/sherpa-onnx-wasm-main-asr-v2";
const verifyPackagedTokens = args.tokens ? false : args["skip-verify"] !== true;

const pieces = parseModelPieces(fs.readFileSync(modelPath));

if (pieces.length === 0) {
  throw new Error(`No SentencePiece pieces found in ${modelPath}`);
}

for (const piece of pieces) {
  if (/\s/.test(piece.piece)) {
    throw new Error(`Piece "${piece.piece}" contains whitespace and cannot be exported`);
  }
}

const tokensText = tokensPath
  ? fs.readFileSync(tokensPath, "utf8")
  : verifyPackagedTokens
    ? readPackagedTokens(`${wasmName}.js`, `${wasmName}.data`)
    : "";

if (tokensText) {
  const tokenLines = tokensText
    .split("\n")
    .filter((line) => line.length > 0);
  const tokenPieces = tokenLines.map((line) => line.slice(0, line.lastIndexOf(" ")));
  const shared = Math.min(tokenPieces.length, pieces.length);
  const mismatch = pieces
    .slice(0, shared)
    .findIndex((piece, index) => piece.piece !== tokenPieces[index]);

  console.log(
    `tokens.txt entries: ${tokenPieces.length}; bpe.model pieces: ${pieces.length}`,
  );

  if (mismatch !== -1) {
    throw new Error(
      `bpe.model does not match tokens.txt at index ${mismatch}: tokens.txt="${tokenPieces[mismatch]}" bpe.model="${pieces[mismatch].piece}"`,
    );
  }

  console.log(
    `All ${shared} bpe.model pieces match tokens.txt in order; tokens.txt has ${tokenPieces.length - shared} extra padding tokens.`,
  );
}

const vocab = pieces
  .map((piece) => `${piece.piece} ${formatScore(piece.score)}`)
  .join("\n");

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${vocab}\n`);

console.log(`Wrote ${pieces.length} pieces to ${outPath}`);
