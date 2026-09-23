"""Offline exit watchdog: independent SSE server outlives the SDK/Blackhole client."""
import http.server
import json
import os
from pathlib import Path
import subprocess
import threading
import time


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    requests = 0

    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        Handler.requests += 1
        events = [
            {'type': 'response.output_item.added', 'output_index': 0, 'item': {'type': 'message', 'id': 'offline-message', 'role': 'assistant', 'content': []}},
            {'type': 'response.output_text.delta', 'output_index': 0, 'delta': 'offline response'},
            {'type': 'response.completed', 'response': {'id': 'offline-response', 'status': 'completed', 'output': [], 'usage': {'input_tokens': 6000, 'output_tokens': 1, 'total_tokens': 6001}}},
        ]
        payload = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            pass  # Client may close its keep-alive connection at natural exit.


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    start = time.monotonic()
    env = {**os.environ, 'PROBE_BLACKHOLE': '1', 'PROBE_COMPACT': '1', 'PROBE_MEMORY': '1', 'PROBE_BASE_URL': f'http://127.0.0.1:{server.server_port}'}
    script = Path(__file__).with_name('probe-session-exit.ts')
    result = subprocess.run(['bun', str(script)], env=env, capture_output=True, text=True, timeout=15)
    print(result.stdout, result.stderr)
    if result.returncode != 0:
        raise RuntimeError(f'Client failed: {result.returncode}')
    if Handler.requests < 3:
        raise AssertionError(f'Expected session, worker and continuation HTTP requests; got {Handler.requests}')
    if not thread.is_alive():
        raise AssertionError('Independent server stopped before client exit')
    print(f'PASS: natural client exit=0 elapsed={time.monotonic()-start:.2f}s requests={Handler.requests} server_still_running=True')
except subprocess.TimeoutExpired as error:
    print('FAIL: client hung after 15s', error.stdout, error.stderr)
    raise
finally:
    server.shutdown()
    server.server_close()
