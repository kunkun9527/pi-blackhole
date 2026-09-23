/**
 * Lossless exact clustering for memory export. Unicode token similarity is
 * retained for retrieval and ranking, never as proof that two facts are equal.
 */
import type { CorpusObservation, CorpusReflection } from "./corpus.js";
import type { Relevance } from "../om/ledger/types.js";


/**
 * Tokens stripped before similarity scoring — "user"/"agent" appear in the
 * vast majority of observations and would dominate token-set overlap.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "user",
  "agent",
  "assistant",
  // relevance labels are rank words, not topics
  "critical",
  "high",
  "medium",
  "low",
  // generic path components (scope dirs, cwd paths)
  "home",
  "projects",
  "github",
  "git",
  "the",
  "a",
  "an",
  "to",
  "of",
  "in",
  "for",
  "on",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "and",
  "but",
  "or",
  "with",
  "at",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "about",
  "also",
  "because",
  "until",
  "while",
  "which",
  "who",
  "whom",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "them",
  "their",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "need",
  "used",
  "using",
  "one",
  "two",
  "new",
  "old",
  "via",
  "per",
  "etc",
]);

/**
 * Root synonym and base mappings for technical verbs, nouns, and modifiers across
 * software development workflows and programming ecosystems.
 */
const TECHNICAL_ROOTS: Record<string, string> = {
  initialize: "init",
  initialization: "init",
  initialized: "init",
  initializes: "init",
  initializer: "init",
  configure: "config",
  configuration: "config",
  configuring: "config",
  configured: "config",
  configures: "config",
  authenticate: "auth",
  authentication: "auth",
  authenticated: "auth",
  authenticates: "auth",
  synchronous: "sync",
  synchronized: "sync",
  synchronization: "sync",
  synchronize: "sync",
  synchronizing: "sync",
  deprecate: "deprec",
  deprecation: "deprec",
  deprecated: "deprec",
  deprecates: "deprec",
  allocate: "alloc",
  allocation: "alloc",
  allocated: "alloc",
  allocator: "alloc",
  destructure: "destruct",
  destructured: "destruct",
  destructuring: "destruct",
  destructor: "destruct",
  destruction: "destruct",
  validate: "valid",
  validation: "valid",
  validator: "valid",
  validated: "valid",
  validates: "valid",
  validating: "valid",
  sanitize: "sanit",
  sanitization: "sanit",
  sanitized: "sanit",
  sanitizer: "sanit",
  normalize: "normal",
  normalization: "normal",
  normalized: "normal",
  normalizer: "normal",
  refactor: "refactor",
  refactored: "refactor",
  refactoring: "refactor",
  refactors: "refactor",
  rebase: "rebas",
  rebasing: "rebas",
  rebased: "rebas",
  serialize: "serializ",
  serialization: "serializ",
  serialized: "serializ",
  serializer: "serializ",
  serializers: "serializ",
  optimize: "optim",
  optimization: "optim",
  optimized: "optim",
  optimizer: "optim",
  compress: "compress",
  compression: "compress",
  compressed: "compress",
  compressor: "compress",
  transpile: "transpil",
  transpilation: "transpil",
  transpiled: "transpil",
  transpiler: "transpil",
  migrate: "migrat",
  migration: "migrat",
  migrated: "migrat",
  migrates: "migrat",
  migrating: "migrat",
  subscribe: "subscrib",
  subscription: "subscrib",
  subscribed: "subscrib",
  subscriber: "subscrib",
  resolve: "resolv",
  resolution: "resolv",
  resolved: "resolv",
  resolver: "resolv",
  implement: "implement",
  implementation: "implement",
  implemented: "implement",
  implementer: "implement",
  execute: "execut",
  execution: "execut",
  executed: "execut",
  executor: "execut",
  executable: "execut",
  register: "regist",
  registration: "regist",
  registered: "regist",
  registry: "regist",
  registrar: "regist",
  compact: "compact",
  compaction: "compact",
  compacted: "compact",
  compactor: "compact",
  prune: "prun",
  pruning: "prun",
  pruned: "prun",
  pruner: "prun",
  reflect: "reflect",
  reflection: "reflect",
  reflector: "reflect",
  reflected: "reflect",
  observe: "observ",
  observation: "observ",
  observer: "observ",
  observed: "observ",
};

/**
 * Widened rule-based suffix stemmer for English content and multi-ecosystem technical terms.
 * Maps common grammatical variants, agentive nouns, action verbs, and derivational suffixes
 * to a shared root form for higher token-set overlap.
 */
export function stemToken(token: string): string {
  if (token.length <= 3) return token;
  const directRoot = Object.prototype.hasOwnProperty.call(TECHNICAL_ROOTS, token)
    ? TECHNICAL_ROOTS[token]
    : undefined;
  if (directRoot) return directRoot;

  let word = token;

  // Step 1: Plurals and past tense / participles
  if (word.endsWith("sses")) {
    word = word.slice(0, -2);
  } else if (word.endsWith("ies") && word.length > 4) {
    word = word.slice(0, -3) + "y";
  } else if (word.endsWith("ss")) {
    // Keep 'ss' (e.g., 'process', 'pass')
  } else if (
    word.endsWith("s") &&
    word.length > 3 &&
    !word.endsWith("us") &&
    !word.endsWith("is")
  ) {
    word = word.slice(0, -1);
  }

  if (word.endsWith("eed") && word.length > 4) {
    word = word.slice(0, -1);
  } else if (word.endsWith("ed") && word.length > 4) {
    word = word.slice(0, -2);
    if (word.endsWith("i")) word = word.slice(0, -1) + "y";
  } else if (word.endsWith("ing") && word.length > 5) {
    word = word.slice(0, -3);
    if (word.endsWith("i")) word = word.slice(0, -1) + "y";
  }

  // Step 2: Agentive and handler nouns (-ers, -ors, -er, -or)
  if (word.length > 5) {
    if (word.endsWith("ers") || word.endsWith("ors")) {
      word = word.slice(0, -3);
    } else if (word.endsWith("er") || word.endsWith("or")) {
      word = word.slice(0, -2);
    }
  }

  // Step 3: Derivational and capability suffixes (-ability, -ation, -ment, -ness, etc.)
  if (word.length > 6) {
    if (word.endsWith("ability") || word.endsWith("ibility")) {
      word = word.slice(0, -7);
    } else if (word.endsWith("ation") || word.endsWith("ition")) {
      word = word.slice(0, -5);
    } else if (word.endsWith("ction") || word.endsWith("stion")) {
      word = word.slice(0, -3); // compaction -> compact, ingestion -> ingest
    } else if (word.endsWith("tion") || word.endsWith("sion")) {
      word = word.slice(0, -2);
    } else if (word.endsWith("ment") || word.endsWith("ness")) {
      word = word.slice(0, -4);
    } else if (word.endsWith("able") || word.endsWith("ible")) {
      word = word.slice(0, -4);
    } else if (word.endsWith("ance") || word.endsWith("ence")) {
      word = word.slice(0, -4);
    } else if (word.endsWith("ity") || word.endsWith("ous")) {
      word = word.slice(0, -3);
    } else if (word.endsWith("ful") || word.endsWith("ive")) {
      word = word.slice(0, -3);
    } else if (word.endsWith("ize") || word.endsWith("ise")) {
      word = word.slice(0, -3);
    } else if (word.endsWith("ify") || word.endsWith("ied")) {
      word = word.slice(0, -3);
    } else if (word.endsWith("ly") && word.length > 5) {
      word = word.slice(0, -2);
    }
  }

  if (Object.prototype.hasOwnProperty.call(TECHNICAL_ROOTS, word)) return TECHNICAL_ROOTS[word];

  return word.length >= 3 ? word : token;
}

/** Unicode scripts that need segmentation without ASCII word boundaries. */
const CJK_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
let _surfaceSegmenter: Intl.Segmenter | null | undefined;

const surfaceSegments = (text: string): string[] => {
  if (_surfaceSegmenter === undefined) {
    try {
      _surfaceSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    } catch {
      _surfaceSegmenter = null;
    }
  }
  if (_surfaceSegmenter) {
    return Array.from(_surfaceSegmenter.segment(text), (part) => part.segment);
  }
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
};

const addCjkBigrams = (tokens: string[], text: string): void => {
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const chars = Array.from(match[0]);
    for (let i = 0; i + 1 < chars.length; i++) {
      tokens.push(chars.slice(i, i + 2).join(""));
    }
  }
};

/**
 * Split content into normalized surface tokens before morphological stemming.
 *
 * English keeps the existing word/stemming behavior. CJK content uses
 * Intl.Segmenter when available and adds character bigrams as a conservative
 * fallback for different valid segmentations. CJK tokens are not subject to
 * the English minimum-length filter.
 */
export function tokenizeSurfaceContent(content: string): string[] {
  // Expand common contractions so "don't" and "do not" share tokens
  const expanded = content
    .replace(/\bdon't\b/gi, "do not")
    .replace(/\bcan't\b/gi, "cannot")
    .replace(/\bwon't\b/gi, "will not")
    .replace(/\bisn't\b/gi, "is not")
    .replace(/\baren't\b/gi, "are not")
    .replace(/\bwasn't\b/gi, "was not")
    .replace(/\bweren't\b/gi, "were not")
    .replace(/\bhasn't\b/gi, "has not")
    .replace(/\bhaven't\b/gi, "have not")
    .replace(/\bhadn't\b/gi, "had not")
    .replace(/\bdoesn't\b/gi, "does not")
    .replace(/\bdidn't\b/gi, "did not")
    .replace(/\bcouldn't\b/gi, "could not")
    .replace(/\bshouldn't\b/gi, "should not")
    .replace(/\bwouldn't\b/gi, "would not")
    .replace(/\bmustn't\b/gi, "must not")
    .replace(/\bneedn't\b/gi, "need not")
    .replace(/\bit's\b/gi, "it is")
    .replace(/\bthat's\b/gi, "that is")
    .replace(/\bwhat's\b/gi, "what is")
    .replace(/\bthere's\b/gi, "there is")
    .replace(/\bhere's\b/gi, "here is")
    .replace(/\bhow's\b/gi, "how is")
    .replace(/\bwho's\b/gi, "who is")
    .replace(/\bi'm\b/gi, "i am")
    .replace(/\byou're\b/gi, "you are")
    .replace(/\bwe're\b/gi, "we are")
    .replace(/\bthey're\b/gi, "they are");
  // Split camelCase and PascalCase before segmentation.
  const splitCamel = expanded.replace(/([a-z])([A-Z])/g, "$1 $2");
  const tokens: string[] = [];
  for (const segment of surfaceSegments(splitCamel)) {
    if (!/[\p{L}\p{N}]/u.test(segment)) continue;
    const token = segment
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}+#._@:/-]/gu, "");
    if (!token || /^\d+$/.test(token)) continue;
    const isCjk = CJK_SCRIPT_RE.test(token);
    if (!isCjk && token.length < 3 && !/[+#._@:/-]/u.test(token)) continue;
    if (!isCjk && STOP_WORDS.has(token)) continue;
    if (!/^[a-f0-9]{7,}$/i.test(token) && !/^[a-z]$/i.test(token)) {
      tokens.push(token);
    }
  }
  // Make matching robust to Segmenter dictionary differences without using
  // n-grams as a standalone merge decision.
  addCjkBigrams(tokens, splitCamel);
  return tokens;
}

/** Normalized, stop-word-stripped and stemmed token list for a piece of content. */
export function tokenizeContent(content: string): string[] {
  return tokenizeSurfaceContent(content).map(stemToken);
}

/**
 * 64-bit SimHash locality-sensitive fingerprint.
 * Fast bitwise signature of a token multiset for O(1) candidate pruning.
 */
export function computeSimHash64(tokens: string[]): bigint {
  if (tokens.length === 0) return 0n;
  const v = new Int32Array(64);
  for (const token of tokens) {
    // Corpus data is parsed from external session JSONL. Keep a malformed
    // token from aborting the whole export instead of assuming runtime types
    // always match the compile-time string[] declaration.
    if (typeof token !== "string") continue;
    // FNV-1a 64-bit hash
    let h = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let i = 0; i < token.length; i++) {
      h ^= BigInt(token.charCodeAt(i));
      h = (h * prime) & 0xffffffffffffffffn;
    }
    for (let i = 0; i < 64; i++) {
      const bit = (h >> BigInt(i)) & 1n;
      v[i] += bit === 1n ? 1 : -1;
    }
  }
  let fingerprint = 0n;
  for (let i = 0; i < 64; i++) {
    if (v[i] > 0) {
      fingerprint |= 1n << BigInt(i);
    }
  }
  return fingerprint;
}

/** Hamming distance between two 64-bit BigInt fingerprints. */
export function simHashHammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export function normalizeContent(content: string): string {
  // Expand common contractions so "don't" and "do not" normalize identically
  const expanded = content
    .replace(/\bdon't\b/gi, "do not")
    .replace(/\bcan't\b/gi, "cannot")
    .replace(/\bwon't\b/gi, "will not")
    .replace(/\bisn't\b/gi, "is not")
    .replace(/\baren't\b/gi, "are not")
    .replace(/\bwasn't\b/gi, "was not")
    .replace(/\bweren't\b/gi, "were not")
    .replace(/\bhasn't\b/gi, "has not")
    .replace(/\bhaven't\b/gi, "have not")
    .replace(/\bhadn't\b/gi, "had not")
    .replace(/\bdoesn't\b/gi, "does not")
    .replace(/\bdidn't\b/gi, "did not")
    .replace(/\bcouldn't\b/gi, "could not")
    .replace(/\bshouldn't\b/gi, "should not")
    .replace(/\bwouldn't\b/gi, "would not")
    .replace(/\bmustn't\b/gi, "must not")
    .replace(/\bneedn't\b/gi, "need not")
    .replace(/\bit's\b/gi, "it is")
    .replace(/\bthat's\b/gi, "that is")
    .replace(/\bwhat's\b/gi, "what is")
    .replace(/\bthere's\b/gi, "there is")
    .replace(/\bhere's\b/gi, "here is")
    .replace(/\bhow's\b/gi, "how is")
    .replace(/\bwho's\b/gi, "who is")
    .replace(/\bi'm\b/gi, "i am")
    .replace(/\byou're\b/gi, "you are")
    .replace(/\bwe're\b/gi, "we are")
    .replace(/\bthey're\b/gi, "they are");
  return expanded
    .normalize("NFKC")
    .toLowerCase()
    // Search-only normalization retains code punctuation; never use as identity.
    .replace(/\s+/gu, " ")
    .trim();
}

/** Lossless identity for deletion decisions. Search normalization is NOT identity. */
export function exactContentKey(content: string): string {
  return content;
}



/**
 * Sørensen-Dice coefficient over stop-word-stripped token sets.
 * 2*|intersection|/(|A|+|B|). High when two observations share most
 * content-bearing vocabulary even with different word order.
 */
export function sorensenDiceTokenSimilarity(a: string, b: string): number {
  return sorensenDiceSets(new Set(tokenizeContent(a)), new Set(tokenizeContent(b)));
}

/** Set-based Sørensen-Dice (avoids re-tokenizing inside O(n²) loops). */
export function sorensenDiceSets(A: Set<string>, B: Set<string>): number {
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

const TIER_RANK: Record<Relevance, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export interface MemoryCluster<T> {
  /** Best member: highest relevance tier, newest timestamp wins ties. */
  rep: T;
  /** Additional members worth rendering (fuzzy variants), capped. */
  extras: T[];
  /**
   * Every non-null member id in the cluster (uncapped). Coverage and topic
   * linkage must use this — extras is render-capped and omits exact dupes.
   */
  allIds?: string[];
  /**
   * Count of distinct-text members beyond the representative (uncapped).
   * Rendered as a "+N variants" count, never as sub-bullets.
   */
  hiddenVariants?: number;
  occurrences: number;
  distinctSessions: number;
  bestRelevance: Relevance;
  /**
   * Max Sørensen-Dice token-set similarity to any other cluster's rep.
   * Used as a consensus reranking signal (0–1 range, 0 when singleton).
   */
  maxRelatedSimilarity: number;
}

interface ClusterableItem {
  content: string;
  timestamp: string | null;
  sessionId: string;
}

function tsValue(ts: string | null): number {
  if (!ts) return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

function pickRep<T extends ClusterableItem>(members: T[]): T {
  return members.reduce((best, m) => (tsValue(m.timestamp) > tsValue(best.timestamp) ? m : best));
}


/** Lossless content group shared by observation and reflection clustering. */
interface ClusterGroup<T> {
  key: string;
  members: T[];
}

function groupByExactContent<T extends ClusterableItem>(items: T[]): Array<ClusterGroup<T>> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = exactContentKey(item.content);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([key, members]) => ({ key, members }));
}


function finalizeClusters<T extends ClusterableItem>(
  groups: Array<ClusterGroup<T>>,
  opts: {
    maxVariants: number;
    bestRelevanceOf: (members: T[]) => Relevance;
    repOf: (members: T[], best: Relevance) => T;
    idOf: (member: T) => string | null;
    computeConsensus: boolean;
  },
): Array<MemoryCluster<T>> {
  const clusters: Array<MemoryCluster<T>> = [];
  for (const group of groups) {
    const { members } = group;
    const bestRelevance = opts.bestRelevanceOf(members);
    const rep = opts.repOf(members, bestRelevance);
    const repKey = exactContentKey(rep.content);
    const variants = members.filter((m) => m !== rep && exactContentKey(m.content) !== repKey);
    const allIds: string[] = [];
    for (const m of members) {
      const id = opts.idOf(m);
      if (id) allIds.push(id);
    }
    clusters.push({
      rep,
      extras: variants.slice(0, opts.maxVariants),
      occurrences: members.length,
      distinctSessions: new Set(members.map((m) => m.sessionId)).size,
      bestRelevance,
      maxRelatedSimilarity: 0,
      allIds,
      hiddenVariants: variants.length,
    });
  }

  // Consensus rerank signal: max Sørensen-Dice to any other cluster.
  if (opts.computeConsensus && clusters.length > 1) {
    const repTokenSets = clusters.map((c) => new Set(tokenizeContent(c.rep.content)));
    for (let i = 0; i < clusters.length; i++) {
      let maxSim = 0;
      for (let j = 0; j < clusters.length; j++) {
        if (i === j) continue;
        const sim = sorensenDiceSets(repTokenSets[i], repTokenSets[j]);
        if (sim > maxSim) maxSim = sim;
      }
      clusters[i].maxRelatedSimilarity = maxSim;
    }
  }
  return clusters;
}

/** Exact observation grouping; similarity contributes only to the ranking signal. */
export function clusterObservations(
  items: CorpusObservation[],
  opts?: { fuzzy?: boolean; sorensen?: boolean; maxVariants?: number },
): Array<MemoryCluster<CorpusObservation>> {
  const maxVariants = opts?.maxVariants ?? 2;
  // Local safety policy: fuzzy/sorensen options remain API-compatible but
  // similarity is used only for ranking, never to discard distinct facts.
  const allGroups = groupByExactContent(items);
  return finalizeClusters(allGroups, {
    maxVariants,
    bestRelevanceOf: (members) =>
      members.reduce<Relevance>(
        (best, m) => (TIER_RANK[m.relevance] > TIER_RANK[best] ? m.relevance : best),
        "low",
      ),
    repOf: (members, bestRelevance) => {
      const tiered = members.filter((m) => m.relevance === bestRelevance);
      return pickRep(tiered.length > 0 ? tiered : members);
    },
    idOf: (m) => m.id,
    computeConsensus: true,
  });
}

/** Exact reflection grouping; legacy similarity options do not authorize deletion. */
export function clusterReflections(
  items: CorpusReflection[],
  opts?: { fuzzy?: boolean; sorensen?: boolean; maxVariants?: number },
): Array<MemoryCluster<CorpusReflection>> {
  const maxVariants = opts?.maxVariants ?? 0;
  // As with observations, only byte-for-byte equal text may be discarded.
  const allGroups = groupByExactContent(items);
  return finalizeClusters(allGroups, {
    maxVariants,
    bestRelevanceOf: (): Relevance => "medium",
    repOf: (members) => pickRep(members),
    idOf: () => null,
    computeConsensus: false,
  });
}
