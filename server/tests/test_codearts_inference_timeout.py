"""CA's slow first response must not inherit WB's shorter inference timeout."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import httpx
import pytest

from server import config, db
from server.routers import anthropic, responses
from server.services import codearts
from server.tests.test_codearts_platform import context, create, request_body


@pytest.mark.parametrize('route', ['/v1/chat/completions', '/v2/chat/completions',
                                   '/v1/responses', '/v1/messages'])
@pytest.mark.parametrize('stream', [False, True])
@pytest.mark.parametrize('selected,expected', [('wb', 121), ('ca', 601)])
@pytest.mark.parametrize('error_type', [httpx.ReadTimeout, httpx.ConnectError])
def test_platform_timeout_and_empty_transport_errors(context, monkeypatch, route,
                                                     stream, selected, expected, error_type):
    monkeypatch.setattr(config, 'UPSTREAM_TIMEOUT', 121)
    monkeypatch.setattr(config, 'CODEARTS_TIMEOUT', 601)
    sent = []

    def fail(request):
        sent.append(request)
        assert request.extensions['timeout']['read'] == expected
        assert request.extensions['timeout']['connect'] == 5
        raise error_type('', request=request)

    def client(timeout, **kwargs):
        assert timeout == expected
        return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=kwargs['connect']),
                                 transport=httpx.MockTransport(fail), trust_env=False)

    monkeypatch.setattr(config, 'http_client', client)
    key = create(context['client'], selected)
    model = 'codearts/model-a' if selected == 'ca' else 'glm-5.2'
    result = context['client'].post(route, json=request_body(model, route, stream=stream),
                                    headers={'Authorization': 'Bearer ' + key['key']})
    assert result.status_code == 502, result.text
    assert error_type.__name__ in result.json()['error']['message']
    assert len(sent) == 1
    log = db.query_one('SELECT * FROM request_logs WHERE key_id=? ORDER BY id DESC LIMIT 1',
                       (key['id'],))
    assert log['error'] == error_type.__name__
    assert log['status'] == 502 and log['stream'] == int(stream)


def test_ca_inference_timeout_does_not_change_management_rpc(context, monkeypatch):
    monkeypatch.setattr(config, 'UPSTREAM_TIMEOUT', 121)
    monkeypatch.setattr(config, 'CODEARTS_TIMEOUT', 601)
    used = []

    def reply(request):
        assert request.url.path == '/api/jet-hub'
        return httpx.Response(200, json={'result': {'ok': True, 'value': {'accounts': []}}})

    def client(timeout, **kwargs):
        used.append((timeout, kwargs))
        return httpx.AsyncClient(transport=httpx.MockTransport(reply), trust_env=False)

    monkeypatch.setattr(config, 'http_client', client)
    assert asyncio.run(codearts.rpc('account.list')) == {'accounts': []}
    assert used == [(20, {'connect': 3, 'proxy': '', 'lane': 'codearts-admin'})]


@pytest.mark.parametrize('configured,expected', [(None, 600), ('345', 345), ('invalid', 600)])
def test_ca_timeout_environment_default_and_override(configured, expected):
    environment = os.environ.copy()
    environment.pop('WB_UPSTREAM_TIMEOUT', None)
    environment.pop('WB_CODEARTS_TIMEOUT', None)
    if configured is not None:
        environment['WB_CODEARTS_TIMEOUT'] = configured
    output = subprocess.check_output(
        [sys.executable, '-c', 'import json; from server import config; '
         'print(json.dumps([config.UPSTREAM_TIMEOUT, config.CODEARTS_TIMEOUT]))'],
        cwd=Path(__file__).resolve().parents[2], env=environment, text=True)
    assert json.loads(output) == [120, expected]


@pytest.mark.parametrize('route', ['/v1/responses', '/v1/messages'])
@pytest.mark.parametrize('selected', ['ca', 'wb'])
@pytest.mark.parametrize('fragmented', [False, True])
def test_ca_comments_survive_translation_without_changing_model_events(
        context, monkeypatch, route, selected, fragmented):
    clock = [0]
    module = responses if route == '/v1/responses' else anthropic
    monkeypatch.setattr(module, 'time', SimpleNamespace(time=lambda: clock[0]))
    model = 'codearts/model-a' if selected == 'ca' else 'glm-5.2'
    content = {'id': 'chatcmpl-comments', 'model': model, 'choices': [
        {'index': 0, 'delta': {'content': 'hello'}, 'finish_reason': None}]}
    finish = {'id': 'chatcmpl-comments', 'model': model, 'choices': [
        {'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
        'usage': {'prompt_tokens': 2, 'completion_tokens': 3, 'total_tokens': 5}}
    frames = [
        (2, b': before\r\n\r\n'),
        (20, ('data: ' + json.dumps(content) + '\n\n').encode()),
        (25, b': middle\n\n'),
        (30, ('data: ' + json.dumps(finish) + '\n\n').encode()),
        (35, b'data: [DONE]\n\n'),
        (40, b': after\r\n\r\n'),
    ]

    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            for at, frame in frames:
                clock[0] = at
                if fragmented:
                    # Exercise a CR/LF split and a data prefix split, including
                    # comments before the first model event and after [DONE].
                    for byte in frame:
                        yield bytes([byte])
                else:
                    yield frame

    def reply(request):
        return httpx.Response(200, stream=Stream(), headers={'content-type': 'text/event-stream'})

    monkeypatch.setattr(config, 'http_client', lambda *a, **kw:
                        httpx.AsyncClient(transport=httpx.MockTransport(reply), trust_env=False))
    key = create(context['client'], selected)
    result = context['client'].post(route, json=request_body(model, route, stream=True),
                                    headers={'Authorization': 'Bearer ' + key['key']})
    assert result.status_code == 200, result.text
    comments = [line for line in result.text.splitlines() if line.startswith(':')]
    assert comments == ([': before', ': middle', ': after'] if selected == 'ca' else [])
    if selected == 'ca':
        assert result.text.startswith(': before\n\n')
        assert ': middle\n\n' in result.text and ': after\n\n' in result.text
    events = [json.loads(line[5:]) for line in result.text.splitlines() if line.startswith('data:')]
    kinds = [event['type'] for event in events]
    if route == '/v1/responses':
        from server.tests.test_responses_api import parse_events
        text, tools, terminal = parse_events([result.content])
        assert text == 'hello' and not tools
        assert terminal['type'] == 'response.completed'
        assert kinds.count('response.created') == kinds.count('response.completed') == 1
        assert terminal['response']['usage']['total_tokens'] == 5
    else:
        assert kinds.count('message_start') == kinds.count('message_stop') == 1
        assert [event['delta']['text'] for event in events
                if event['type'] == 'content_block_delta'] == ['hello']
        assert next(event for event in events if event['type'] == 'message_delta')['usage'] == {
            'input_tokens': 2, 'output_tokens': 3,
            'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0}
    log = db.query_one('SELECT * FROM request_logs WHERE key_id=? ORDER BY id DESC LIMIT 1',
                       (key['id'],))
    assert log['first_token_ms'] == 20000
    assert log['prompt_tokens'] == 2 and log['completion_tokens'] == 3
    assert log['latency_ms'] == 40000
