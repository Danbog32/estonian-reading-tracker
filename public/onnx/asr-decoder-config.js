(function (scope) {
  "use strict";

  const SUPPORTED_METHODS = new Set([
    "greedy_search",
    "modified_beam_search",
  ]);
  const BPE_MODELING_UNITS = new Set(["bpe", "cjkchar+bpe"]);

  function utf8ByteLength(value) {
    let bytes = 0;
    for (const character of value) {
      const codePoint = character.codePointAt(0);
      if (codePoint <= 0x7f) bytes += 1;
      else if (codePoint <= 0x7ff) bytes += 2;
      else if (codePoint <= 0xffff) bytes += 3;
      else bytes += 4;
    }
    return bytes;
  }

  function usesBpeVocab(modelingUnit) {
    return BPE_MODELING_UNITS.has(modelingUnit || "bpe");
  }

  function normalizeReferenceWord(value) {
    return String(value ?? "")
      .toLocaleLowerCase("et")
      .replace(/[^\p{L}\p{N}'’-]+/gu, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function buildHotwordsBuffer(referenceWords, limit) {
    const words = Array.isArray(referenceWords) ? referenceWords : [];
    const uniqueWords = [];
    const seen = new Set();

    for (const value of words.slice(0, limit)) {
      const word = normalizeReferenceWord(value);
      if (!word || seen.has(word)) continue;
      seen.add(word);
      uniqueWords.push(word);
    }

    return uniqueWords.join("\n");
  }

  function resolveDecoderConfig(options) {
    const input = options && typeof options === "object" ? options : {};
    const method = input.method || "greedy_search";

    if (!SUPPORTED_METHODS.has(method)) {
      throw new Error(`Unsupported ASR decoding method: ${method}`);
    }

    const maxActivePaths = Number.isInteger(input.maxActivePaths)
      ? Math.min(32, Math.max(1, input.maxActivePaths))
      : method === "modified_beam_search"
        ? 8
        : 4;
    const referenceWordLimit = Number.isInteger(input.referenceWordLimit)
      ? Math.min(256, Math.max(1, input.referenceWordLimit))
      : 64;
    const hotwordsBuf = buildHotwordsBuffer(
      input.referenceWords,
      referenceWordLimit
    );
    const hasReferenceBias = hotwordsBuf.length > 0;

    if (hasReferenceBias && method !== "modified_beam_search") {
      throw new Error(
        "Reference-word biasing requires modified_beam_search; greedy_search ignores hotwords"
      );
    }

    const modelingUnit = input.modelingUnit || (hasReferenceBias ? "bpe" : "cjkchar");
    const bpeVocab = typeof input.bpeVocab === "string"
      ? input.bpeVocab.trim()
      : "";

    if (hasReferenceBias && usesBpeVocab(modelingUnit) && !bpeVocab) {
      throw new Error(
        "Reference-word biasing is unavailable: this BPE model requires a compatible bpe.vocab asset"
      );
    }

    const hotwordsScore = Number.isFinite(input.hotwordsScore)
      ? Math.min(10, Math.max(0, input.hotwordsScore))
      : 1.5;

    return {
      method,
      maxActivePaths,
      modelingUnit,
      bpeVocab,
      hotwordsBuf,
      hotwordsBufSize: utf8ByteLength(hotwordsBuf),
      hotwordsScore,
      referenceWordCount: hotwordsBuf ? hotwordsBuf.split("\n").length : 0,
      referenceBiasEnabled: hasReferenceBias,
    };
  }

  scope.AsrDecoderConfig = {
    buildHotwordsBuffer,
    usesBpeVocab,
    normalizeReferenceWord,
    resolveDecoderConfig,
    utf8ByteLength,
  };
})(typeof self !== "undefined" ? self : globalThis);
