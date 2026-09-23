// Offline CLIProxyAPI transport probe. Only an ephemeral loopback HTTP server is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Model } from '@earendil-works/pi-ai';
process.argv[1] = realpathSync(fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)));
const { loadCliproxyCodexStreams, CLIPROXYAPI_CODEX_API } = await import('C:/Users/Su/.pi/agent/npm/node_modules/@router-for-me/pi-cliproxyapi-provider/extensions/codex-stream.ts');
const streams = await loadCliproxyCodexStreams();
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'offline-message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'offline transport success' },
  ]) response.write('data: ' + JSON.stringify(event) + '\n\n');
  response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'offline-response', status: 'completed', output: [{ type: 'message', id: 'offline-message', role: 'assistant', content: [{ type: 'output_text', text: 'offline transport success', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }) + '\n\n');
});
server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  assert.equal(typeof key, 'string');
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', chunk => {
    if ((chunk[0] & 0x0f) === 8) { socket.end(Buffer.from([0x88, 0])); return; }
    for (const event of [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'offline-message', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'offline transport success' },
      { type: 'response.completed', response: { id: 'offline-response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) {
      const payload = Buffer.from(JSON.stringify(event));
      const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
      header[0] = 0x81;
      header[1] = payload.length < 126 ? payload.length : 126;
      if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
      socket.write(Buffer.concat([header, payload]));
    }
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const model: Model<typeof CLIPROXYAPI_CODEX_API> = { id: 'offline', name: 'Offline', api: CLIPROXYAPI_CODEX_API, provider: 'cliproxyapi', baseUrl: process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${address.port}`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 };
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(model.baseUrl).hostname), 'Offline probe only permits loopback');
  for (let request = 0; request < Number(process.env.PROBE_REQUESTS ?? 1); request++) {
    const transport = process.env.PROBE_TRANSPORT === 'websocket' ? 'websocket' : process.env.PROBE_TRANSPORT === 'auto' ? 'auto' : 'sse';
    const result = await streams.streamSimple(model, { messages: [{ role: 'user', content: 'offline ping', timestamp: 0 }] }, { apiKey: 'offline-only', sessionId: 'offline-session', transport, signal: AbortSignal.timeout(5000) }).result();
    assert.equal(result.stopReason, 'stop', JSON.stringify(result));
    assert.ok(result.content.some(block => block.type === 'text' && block.text === 'offline transport success'));
    console.log('PROBE: provider response complete', request + 1);
  }
} finally {
  streams.closeOpenAICodexWebSocketSessions();
  await new Promise<void>((resolve, reject) => {
    server.close(error => error && error.message !== 'Server is not running.' ? reject(error) : resolve());
    server.closeAllConnections();
  });
  console.log('PROBE: cleanup complete');
}
