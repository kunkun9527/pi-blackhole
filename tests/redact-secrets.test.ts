import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/core/redact-secrets';
import { compile } from '../src/core/summarize';

// Synthetic values shaped like keys seen in real sessions; none are real credentials.
// Prefixes are concatenated so secret scanners do not flag this file.
const HEX64 = '3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a';
const OPENROUTER = 'sk-' + `or-v1-${HEX64}`;
const VENDOR_PREFIX = 'classifier' + `_live_${HEX64}`;
const KAGGLE = 'KGAT' + '_4b8e2a6c9d1f3e5a7b0c2d4e6f8a1b3c';

test('keys pasted into Chinese and English chat are masked', () => {
  for (const text of [
    `${OPENROUTER} 这是我的openrouter的apikey，专门用于测试`,
    `试试这个，APIKEY，${VENDOR_PREFIX} 参考文档，https://example.com/docs`,
    `API换成这个，${VENDOR_PREFIX}`,
    `${KAGGLE}，这是我在kaggle的apikey`,
    `export OPENAI_API_KEY=a8F3kL9qZ2xV7mN4pR6tW1yB5cD0eG`,
    `api_key = "${HEX64}"`,
    `数据库密码：Xk82mQp4Lz9RtV3nWc7Y`,
    `连接串 postgres://admin:hunter2pass@db.local:5432/app`,
  ]) {
    const out = redactSecrets(text);
    assert.match(out, /\[REDACTED [a-z-]+\]/, text.slice(0, 30));
    assert.ok(!/[0-9a-f]{32}|a8F3kL9q|Xk82mQp4|hunter2pass/.test(out), out);
  }
});

test('identifiers, digests, paths and model ids are kept', () => {
  for (const text of [
    `commit ${'4e7c1a9b2d5f8e0a3c6b9d2f5a8c1e4b7d0f3a6c'} fixed the auth bug`,
    `token budget: observationsPoolMaxTokens=20000`,
    'session 01a0e9a6-e186-731f-9872-6f773791d998 used cliproxyapi/gpt-6-luna',
    'node_id: C_kwDOAbCdEf12GhIjKlMnOpQrStUvWx34 author token',
    'Next Page Token = CfDJ8AbCdEfGhIjKlMnOpQrStUv12345',
    'read C:/Users/Su/.pi/agent/sessions/2026-09-28T20-13-43-175Z_01a0e9a6-e186.jsonl for auth',
    'api: normalizeSourceAddressedBranchEntries2 handles token windows',
    `api key image sha256:${HEX64}`,
    `token budget check passed at commit ${HEX64.slice(0, 40)}`,
  ]) {
    assert.equal(redactSecrets(text), text);
  }
});

test('compaction summary masks a key from the user message and keeps Chinese text', () => {
  const summary = compile({
    messages: [
      { role: 'user', content: `${OPENROUTER} 这是我的apikey，请用官方模型测试延迟`, timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: '好的，开始测试。' }], timestamp: 2 },
    ] as any,
  });
  assert.ok(!summary.includes(HEX64));
  assert.match(summary, /\[REDACTED api-key\]/);
  assert.match(summary, /请用官方模型测试延迟/);
});
