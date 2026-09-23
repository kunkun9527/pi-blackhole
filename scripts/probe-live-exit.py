"""Replay the real acceptance script against loopback, without credentials or paid calls."""
import http.server
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import zstandard
import base64
import hashlib
import struct


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    requests = 0
    tool_requests = 0

    def log_message(self, *args):
        pass

    def events(self, body):
        Handler.requests += 1
        tools = {t.get('name') for t in body.get('tools', [])}
        session = 'acceptance_ping' in tools
        tool_done = 'TOOL_RESULT_73921' in json.dumps(body.get('input', []))
        if session and not tool_done:
            Handler.tool_requests += 1
            item = {'type': 'function_call', 'id': 'fc_probe', 'call_id': 'call_probe', 'name': 'acceptance_ping', 'arguments': ''}
            events = [
                {'type': 'response.output_item.added', 'output_index': 0, 'item': item},
                {'type': 'response.function_call_arguments.delta', 'output_index': 0, 'delta': '{}'},
                {'type': 'response.output_item.done', 'output_index': 0, 'item': {**item, 'arguments': '{}'}},
            ]
        else:
            text = '项目青鹭，数据库端口15432，禁止删除生产数据库。TOOL_RESULT_73921' if session else 'No new durable records.'
            events = [
                {'type': 'response.output_item.added', 'output_index': 0, 'item': {'type': 'message', 'id': 'msg_probe', 'role': 'assistant', 'content': []}},
                {'type': 'response.output_text.delta', 'output_index': 0, 'delta': text},
            ]
        events.append({'type': 'response.completed', 'response': {'id': f'offline-{Handler.requests}', 'status': 'completed', 'output': [], 'usage': {'input_tokens': 6000 if not tool_done else 1000, 'output_tokens': 20, 'total_tokens': 6020 if not tool_done else 1020}}})
        return events

    def do_GET(self):
        if os.environ.get('PROBE_WEBSOCKET') != '1':
            self.send_error(501)
            return
        accept = base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.close_connection = True
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        self.end_headers()
        while True:
            header = self.rfile.read(2)
            if len(header) != 2:
                return
            opcode = header[0] & 15
            size = header[1] & 127
            if size == 126:
                size = struct.unpack('!H', self.rfile.read(2))[0]
            elif size == 127:
                size = struct.unpack('!Q', self.rfile.read(8))[0]
            mask = self.rfile.read(4) if header[1] & 128 else None
            payload = self.rfile.read(size)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 8:
                if os.environ.get('PROBE_IGNORE_CLOSE') == '1':
                    time.sleep(25)
                else:
                    self.wfile.write(bytes([0x88, len(payload)]) + payload)
                    self.wfile.flush()
                return
            if opcode != 1:
                raise RuntimeError(f'Unexpected opcode {opcode}')
            for event in self.events(json.loads(payload)):
                data = json.dumps(event).encode()
                length = bytes([len(data)]) if len(data) < 126 else b'\x7e' + struct.pack('!H', len(data))
                self.wfile.write(b'\x81' + length + data)
            self.wfile.flush()

    def do_POST(self):
        payload = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if self.headers.get('Content-Encoding') == 'zstd':
            payload = zstandard.ZstdDecompressor().decompress(payload)
        events = self.events(json.loads(payload))
        payload = ''.join('data: ' + json.dumps(e) + '\n\n' for e in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        if os.environ.get('PROBE_OPEN_STREAM') == '1':
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            self.wfile.write(f'{len(payload):x}\r\n'.encode() + payload + b'\r\n')
        else:
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        self.wfile.flush()

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    start = time.monotonic()
    env = {**os.environ, 'BLACKHOLE_OFFLINE_URL': f'http://127.0.0.1:{server.server_port}'}
    env.pop('BLACKHOLE_LIVE_TEST', None)
    script = Path(__file__).with_name('verify-live-session.ts')
    preload = ['--preload', os.environ['PROBE_PRELOAD']] if os.environ.get('PROBE_PRELOAD') else []
    result = subprocess.run(['bun', *preload, str(script)], env=env, capture_output=True, text=True, encoding='utf-8', timeout=20)
    print(result.stdout, result.stderr)
    if result.returncode != 0:
        raise RuntimeError(f'Client failed: {result.returncode}')
    assert Handler.requests >= 2, Handler.requests
    assert Handler.tool_requests == 1, Handler.tool_requests
    assert thread.is_alive()
    print(f'PASS: exact acceptance script exited naturally in {time.monotonic()-start:.2f}s; requests={Handler.requests}')
except subprocess.TimeoutExpired as error:
    print('FAIL: client hung after 20s', error.stdout, error.stderr)
    raise
finally:
    server.shutdown()
    server.server_close()
