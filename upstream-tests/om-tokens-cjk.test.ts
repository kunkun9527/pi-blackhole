/**
 * Conservative local CJK budget policy: BMP letters cost 1.5 tokens,
 * punctuation 1, and supplementary code points 4. These are safety
 * heuristics, not a provider tokenizer or a guaranteed upper bound.
 */
import { describe, expect, it } from "vitest";

import { estimateStringTokens } from "../src/om/tokens.js";

describe("estimateStringTokens — CJK script awareness (#106)", () => {
  it("counts BMP Han conservatively at 1.5 tokens per character", () => {
    expect(estimateStringTokens("这是一段中文")).toBe(9);
  });

  it("counts kana conservatively at 1.5 tokens per character", () => {
    expect(estimateStringTokens("カタカナ")).toBe(6);
  });

  it("rounds the complete Hangul estimate upward", () => {
    expect(estimateStringTokens("한국어")).toBe(5);
  });

  it("counts CJK punctuation at ~1 token per char", () => {
    expect(estimateStringTokens("。！？")).toBe(3);
  });

  it("leaves pure ASCII at chars/4 (unchanged behavior)", () => {
    expect(estimateStringTokens("This is English")).toBe(4);
    expect(estimateStringTokens("hello world")).toBe(3);
  });

  it("blends mixed CJK + ASCII text", () => {
    // 2 BMP CJK letters and 10 ASCII characters: ceil(3 + 10/4).
    expect(estimateStringTokens("the 面板 shows")).toBe(6);
  });

  it("returns 0 for empty text", () => {
    expect(estimateStringTokens("")).toBe(0);
  });

  it("reserves four tokens for a supplementary Han code point", () => {
    expect(estimateStringTokens("𠮷")).toBe(4);
  });

  it("blends supplementary Han with ASCII before rounding", () => {
    expect(estimateStringTokens("a𠮷b")).toBe(5);
  });
});
