"""验证 CA 接入的真实路由、旧数据迁移、协议输出和授权边界。"""
from __future__ import annotations

import asyncio
import json
import secrets
import sqlite3
import sys
import time
from pathlib import Path
from unittest import mock

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server import config, db, keysvc, security, tokensvc, upstreamsvc
from server.routers import gateway
from server.services import codearts, platforms


@pytest.fixture
def context(tmp_path, monkeypatch):
    # 不进入 lifespan：测试不能启动生产调度器，也不能访问真实账号和网络。
    for name, path in {'DB_PATH': tmp_path / 'manager.db', 'USERS_FILE': tmp_path / 'users.json',
                       'DATA_DIR': tmp_path, 'STATIC_DIR': tmp_path / 'no-static'}.items():
        monkeypatch.setattr(config, name, path)
    if db._conn is not None:
        db._conn.close()
    db._conn = None
    codearts.invalidate_catalog()
    codearts._pending.clear()
    monkeypatch.setattr(gateway, 'RATE_MAX_PER_MIN', 10000)
    db.connect()
    security.save_users({'secret': secrets.token_urlsafe(32), 'users': [
        {'username': 'admin', 'role': 'admin', 'pwd_hash': security.make_hash('test-password')},
        {'username': 'viewer', 'role': 'viewer', 'pwd_hash': security.make_hash('test-password')},
    ], 'api_keys': []})
    ca = upstreamsvc.create_upstream('CA', 'http://127.0.0.1:8092', 'ca-upstream-sentinel', platform='ca')
    wb = upstreamsvc.create_upstream('WB', 'http://wb.test:7863', 'wb-upstream-sentinel')
    db.set_setting('codearts_connection', {'base_url': ca['base_url'], 'admin_key': 'ca-admin-sentinel',
                                          'upstream_id': ca['id']})
    from server.main import app
    client = TestClient(app)
    result = client.post('/api/login', json={'username': 'admin', 'password': 'test-password'})
    assert result.status_code == 200
    client.cookies.update(dict(result.cookies))
    yield {'client': client, 'ca': ca, 'wb': wb}
    client.close()
    if db._conn is not None:
        db._conn.close()
    db._conn = None
    codearts.invalidate_catalog()
    codearts._pending.clear()


def install_transport(monkeypatch, handler):
    sent = []
    def dispatch(request):
        sent.append(request)
        return handler(request)
    monkeypatch.setattr(config, 'http_client', lambda *a, **kw:
                        httpx.AsyncClient(transport=httpx.MockTransport(dispatch), trust_env=False))
    return sent


def create(client, platform, **fields):
    result = client.post('/api/keys', json={'name': 'platform-test', 'platform': platform, **fields})
    assert result.status_code == 200, result.text
    return result.json()


def request_body(model, route, *, stream=False):
    if route == '/v1/responses':
        return {'model': model, 'input': 'hello', 'stream': stream}
    if route == '/v1/tools/search':
        return {'query': 'hello'}
    return {'model': model, 'messages': [{'role': 'user', 'content': 'hello'}],
            'max_tokens': 64, 'stream': stream}


def test_existing_database_migration_preserves_original_keys(context, monkeypatch, tmp_path):
    old_db = tmp_path / 'old.db'
    # 用部署前的真实 schema 造旧库，避免只造几个列漏掉真实迁移交互。
    original = Path(__file__).resolve().parent / 'fixtures/pre_codearts_schema.sql'
    schema = original.read_text(encoding='utf-8')
    token = 'wbk_migration_sentinel'
    with sqlite3.connect(old_db) as old:
        old.executescript(schema)
        old.execute('INSERT INTO api_keys(name,key_hash,key_plain,prefix,realm,created_at) VALUES(?,?,?,?,?,?)',
                    ('old-key', keysvc._hash(token), token, token[:12], 'global', 1))
        old.execute('INSERT INTO upstreams(name,base_url,api_key,created_at,updated_at) VALUES(?,?,?,?,?)',
                    ('old-upstream', 'http://old.test:7863', 'old-upstream-key', 1, 1))
    db._conn.close()
    db._conn = None
    monkeypatch.setattr(config, 'DB_PATH', old_db)
    db.connect()
    resolved = keysvc.resolve(token)
    assert resolved['platform'] == 'wb'
    assert resolved['realm'] == 'global'
    assert keysvc.reveal_key(resolved['id'])['key'] == token
    assert upstreamsvc.list_upstreams(include_default=False)[0]['platform'] == 'wb'
    assert db.query_one('PRAGMA integrity_check')[0] == 'ok'


def test_create_edit_platform_binding_and_reset(context):
    c = context['client']
    ca = create(c, 'ca', realm='global', models=['codearts/model-a'])
    assert ca['key'].startswith('cak_')
    assert ca['realm'] == '' and ca['upstream_id'] == context['ca']['id']
    wb = create(c, 'wb', realm='global', models=['global:model-b'])
    assert wb['key'].startswith('wbk_')
    for selected, uid in [('wb', context['ca']['id']), ('ca', context['wb']['id'])]:
        result = c.post('/api/keys', json={'name': 'mismatch', 'platform': selected, 'upstream_id': uid})
        assert result.status_code == 400
    result = c.patch(f"/api/keys/{wb['id']}", json={'platform': 'ca'})
    assert result.status_code == 200, result.text
    assert result.json()['models'] == [] and result.json()['realm'] == ''
    assert result.json()['upstream_id'] == context['ca']['id']
    result = c.patch(f"/api/keys/{wb['id']}", json={'platform': 'wb'})
    assert result.status_code == 200 and result.json()['upstream_id'] is None
    result = c.patch(f"/api/keys/{ca['id']}", json={'models': ['global:model-b']})
    assert result.status_code == 400
    assert keysvc.get_key(ca['id'])['models'] == ['codearts/model-a']


@pytest.mark.parametrize('route', ['/v1/chat/completions', '/v2/chat/completions', '/v1/responses',
                                   '/v1/messages', '/v1/messages/count_tokens'])
@pytest.mark.parametrize('selected,model', [('wb', 'codearts/model-a'), ('ca', 'glm-5.2'),
                                           ('ca', 'global:gpt-5.6-sol'), ('ca', 'jet-hub-auto/auto')])
def test_cross_platform_requests_never_reach_an_upstream(context, monkeypatch, route, selected, model):
    key = create(context['client'], selected)
    sent = install_transport(monkeypatch, lambda r: httpx.Response(500))
    result = context['client'].post(route, json=request_body(model, route),
                                   headers={'Authorization': 'Bearer ' + key['key']})
    assert result.status_code == 400, result.text
    assert sent == []
    assert db.query_one('SELECT used_tokens FROM api_keys WHERE id=?', (key['id'],))[0] == 0


def test_ca_search_and_wb_account_endpoints_reject_ca(context, monkeypatch):
    c = context['client']
    ca = create(c, 'ca')
    sent = install_transport(monkeypatch, lambda r: httpx.Response(500))
    assert c.post('/v1/tools/search', json={'query': 'hello'},
                  headers={'Authorization': 'Bearer ' + ca['key']}).status_code == 400
    for route in ('/api/accounts', '/api/upstream/status'):
        assert c.get(route, params={'upstream_id': context['ca']['id']}).status_code == 400
    assert sent == []


def test_aliases_and_wildcard_cannot_cross_platform(context, monkeypatch):
    c = context['client']
    ca = create(c, 'ca')
    wb = create(c, 'wb')
    db.set_setting('model_map', {'alias-to-ca': 'codearts/model-a', 'codearts/model-a': 'glm-5.2', '*': 'glm-5.2'})
    assert gateway._map_model('codearts/model-a') == 'codearts/model-a'
    sent = install_transport(monkeypatch, lambda r: httpx.Response(500))
    for key, name in [(wb, 'alias-to-ca'), (ca, 'alias-to-ca'), (ca, 'typo')]:
        r = c.post('/v1/chat/completions', json=request_body(name, '/v1/chat/completions'),
                   headers={'Authorization': 'Bearer ' + key['key']})
        assert r.status_code == 400
    assert sent == []


def test_ca_disabled_or_unconfigured_never_falls_back(context, monkeypatch):
    c = context['client']
    ca = create(c, 'ca')
    upstreamsvc.update_upstream(context['ca']['id'], {'enabled': False})
    sent = install_transport(monkeypatch, lambda r: httpx.Response(500))
    result = c.post('/v1/chat/completions', json=request_body('codearts/model-a', '/v1/chat/completions'),
                    headers={'Authorization': 'Bearer ' + ca['key']})
    assert result.status_code == 503 and not sent
    db.set_setting('codearts_connection', {})
    with pytest.raises(upstreamsvc.UpstreamUnavailable):
        upstreamsvc.resolve_for_key({'platform': 'ca'})
    assert c.post('/api/keys', json={'name': 'missing-ca', 'platform': 'ca'}).status_code == 400


def test_model_listing_isolates_platform_and_preserves_provider_metadata(context, monkeypatch):
    payload = {'object': 'list', 'data': [
        {'id': 'codearts/model-a', 'context_window': 300000, 'reasoning': {'openai_efforts': ['high']},
         'input': ['text', 'image'], 'owned_by': 'codearts'},
        {'id': 'codearts/model-b'}, {'id': 'cn:glm-5.2'}, {'id': 'global:gpt-5.6-sol'},
        {'id': 'jet-hub-auto/auto'}, {'id': 'qiniu/model-c'},
    ]}
    sent = install_transport(monkeypatch, lambda r: httpx.Response(200, json=payload))
    c = context['client']
    ca = create(c, 'ca', models=['codearts/model-a'])
    with mock.patch.object(gateway, '_drop_models_outside_catalog', side_effect=AssertionError('CA called Tencent')):
        result = c.get('/v1/models', headers={'Authorization': 'Bearer ' + ca['key']})
    assert result.status_code == 200
    assert result.json()['data'] == [payload['data'][0]]
    assert str(sent[0].url) == context['ca']['base_url'] + '/v1/models'
    assert sent[0].headers['authorization'] == 'Bearer ca-upstream-sentinel'
    wb = create(c, 'wb')
    result = c.get('/v1/models', headers={'Authorization': 'Bearer ' + wb['key']})
    assert result.status_code == 200
    assert [m['id'] for m in result.json()['data']] == ['glm-5.2', 'global:gpt-5.6-sol']
    result = c.get('/v1/models', headers={'x-api-key': ca['key'], 'anthropic-version': '2023-06-01'})
    assert result.status_code == 200 and result.json()['first_id'] == 'codearts/model-a'


USAGE = {'prompt_tokens': 11, 'completion_tokens': 7, 'total_tokens': 18,
         'prompt_tokens_details': {'cached_tokens': 3}}


@pytest.mark.parametrize('route', ['/v1/chat/completions', '/v2/chat/completions', '/v1/responses', '/v1/messages'])
@pytest.mark.parametrize('stream', [False, True])
def test_ca_protocols_forward_to_ca_and_finish_with_usage(context, monkeypatch, route, stream):
    def respond(request):
        body = json.loads(request.content)
        assert body['model'] == 'codearts/model-a'
        assert body['messages'][-1]['content'] == 'hello'
        if body.get('stream'):
            assert body['stream_options']['include_usage'] is True
            chunks = [
                {'id': 'chatcmpl-test', 'model': 'codearts/model-a', 'choices': [{'index': 0, 'delta': {'role': 'assistant'}}]},
                {'id': 'chatcmpl-test', 'model': 'codearts/model-a', 'choices': [{'index': 0, 'delta': {'content': 'hello CA'}}]},
                {'id': 'chatcmpl-test', 'model': 'codearts/model-a', 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': USAGE},
            ]
            raw = ''.join('data: ' + json.dumps(item) + '\n\n' for item in chunks) + 'data: [DONE]\n\n'
            return httpx.Response(200, content=raw.encode(), headers={'content-type': 'text/event-stream'})
        return httpx.Response(200, json={'id': 'chatcmpl-test', 'model': 'codearts/model-a', 'choices': [
            {'index': 0, 'message': {'role': 'assistant', 'content': 'hello CA'}, 'finish_reason': 'stop'}], 'usage': USAGE})
    sent = install_transport(monkeypatch, respond)
    c = context['client']
    ca = create(c, 'ca')
    db.set_setting('model_map', {'*': 'glm-5.2'})
    result = c.post(route, json=request_body('codearts/model-a', route, stream=stream),
                    headers={'Authorization': 'Bearer ' + ca['key']})
    assert result.status_code == 200, result.text
    assert len(sent) == 1 and str(sent[0].url) == context['ca']['base_url'] + '/v1/chat/completions'
    assert sent[0].headers['authorization'] == 'Bearer ca-upstream-sentinel'
    assert 'hello CA' in result.text
    if stream:
        if route == '/v1/responses':
            from server.tests.test_responses_api import parse_events
            text, tools, terminal = parse_events([result.content])
            assert text == 'hello CA' and not tools
            assert terminal['type'] == 'response.completed'
            assert terminal['response']['usage']['input_tokens'] == 11
            assert terminal['response']['usage']['output_tokens'] == 7
        elif route == '/v1/messages':
            events = [json.loads(line[5:]) for line in result.text.splitlines() if line.startswith('data:')]
            assert events[-1]['type'] == 'message_stop'
            assert any(e.get('usage', {}).get('output_tokens') == 7 for e in events)
        else:
            assert 'data: [DONE]' in result.text
    elif route == '/v1/messages':
        assert result.json()['usage']['input_tokens'] == 11
    elif route == '/v1/responses':
        assert result.json()['usage']['output_tokens'] == 7
    log = db.query_one('SELECT * FROM request_logs WHERE key_id=? ORDER BY id DESC LIMIT 1', (ca['id'],))
    assert log['prompt_tokens'] == 11 and log['completion_tokens'] == 7
    assert log['account_expected'] == 0 and not log['account']
    assert log['mapped_model'] == 'codearts/model-a'
    assert log['realm'] == 'ca'
    assert db.query_one('SELECT realm FROM usage_daily WHERE key_id=?', (ca['id'],))[0] == 'ca'
    assert db.query_one('SELECT realm FROM usage_hourly WHERE key_id=?', (ca['id'],))[0] == 'ca'
    assert keysvc.get_key(ca['id'])['used_tokens'] == 18


def test_private_rpc_handles_void_and_redacts_errors(context, monkeypatch):
    def reply(request):
        assert str(request.url) == 'http://127.0.0.1:8092/api/jet-hub'
        assert request.headers['authorization'] == 'Bearer ca-admin-sentinel'
        body = json.loads(request.content)
        assert body['type'] == 'client-request' and body['method'] == 'jet-hub'
        if body['payload']['method'] == 'account.update':
            return httpx.Response(200, json={'result': {'ok': True}})
        return httpx.Response(200, json={'result': {'ok': False, 'error': {'code': 'bad-request',
            'message': 'failed https://localhost/path?code=secret-code&state=secret-state Bearer ' + 's' * 43}}})
    install_transport(monkeypatch, reply)
    assert asyncio.run(codearts.rpc('account.update', {})) is None
    with pytest.raises(codearts.CodeArtsError) as failure:
        asyncio.run(codearts.rpc('account.refresh', {}))
    assert failure.value.status == 400
    for sensitive in ('secret-code', 'secret-state', 's' * 43):
        assert sensitive not in str(failure.value)


def test_account_projection_callback_ownership_and_admin_boundary(context, monkeypatch):
    now = int(time.time() * 1000)
    row = {'id': 'codearts-a', 'provider': 'codearts', 'nickname': 'Huawei A', 'enabled': True,
           'credentialRef': 'DO_NOT_EXPORT_THIS_REF', 'access_token': 'private-token', 'createdAt': now,
           'expiresAt': now + 7200000, 'refreshable': True, 'modelRateLimits': {'model-a': now + 60000}}
    def reply(request):
        inner = json.loads(request.content)['payload']
        method, body = inner['method'], inner['payload']
        if method == 'account.list':
            return httpx.Response(200, json={'result': {'ok': True, 'value': {'accounts': [row, {'id': 'wb-b', 'provider': 'buddy'}]}}})
        if method == 'account.create':
            return httpx.Response(200, json={'result': {'ok': True, 'value': {'accountId': row['id'],
                'loginUrl': 'https://codearts.huaweicloud.com/portal/authorize?state=private-state'}}})
        if method == 'account.submitCallback':
            assert body['accountId'] == row['id']
            return httpx.Response(200, json={'result': {'ok': True, 'value': {'accepted': True}}})
        return httpx.Response(200, json={'result': {'ok': True}})
    sent = install_transport(monkeypatch, reply)
    c = context['client']
    result = c.get('/api/ca/accounts')
    assert result.status_code == 200
    for sensitive in ('DO_NOT_EXPORT_THIS_REF', 'private-token', 'credentialRef', 'access_token'):
        assert sensitive not in result.text
    account = result.json()['accounts'][0]
    assert len(result.json()['accounts']) == 1 and account['expires_at'] == (now + 7200000) // 1000
    assert account['model_rate_limits']['codearts/model-a'] == (now + 60000) // 1000
    assert c.post('/api/ca/auth/start').status_code == 200
    before = len(sent)
    for account_id, url in [('buddy-a', 'http://localhost:123/oauth?code=a'),
                            ('codearts-a', 'https://external.test/oauth?code=a'),
                            ('codearts-a', 'http://user:pw@localhost:123/oauth?code=a')]:
        result = c.post(f'/api/ca/auth/{account_id}/callback', json={'callback_url': url})
        assert result.status_code == 400
    assert len(sent) == before
    result = c.post('/api/ca/auth/codearts-a/callback', json={'callback_url': 'http://localhost:123/oauth/callback?code=a&state=b'})
    assert result.status_code == 200 and result.json()['accepted']
    codearts._pending.clear()
    assert c.post('/api/ca/auth/codearts-a/callback', json={'callback_url': 'http://localhost:123/oauth?code=a'}).status_code == 409
    token = tokensvc.create_token('admin-test', 'admin')['token']
    c.cookies.clear()
    before = len(sent)
    assert c.post('/api/ca/auth/start', headers={'Authorization': 'Bearer ' + token}).status_code == 403
    assert not sent[before:]
    c.post('/api/login', json={'username': 'viewer', 'password': 'test-password'})
    assert c.get('/api/ca/accounts').status_code == 200
    assert c.delete('/api/ca/accounts/codearts-a').status_code == 403


def test_catalog_uses_ca_only_and_no_tencent_fallback(context, monkeypatch):
    def reply(request):
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'data': [{'id': 'codearts/model-a', 'context_window': 300000,
                'max_tokens': 32000, 'input': ['text', 'image'], 'reasoning': {'openai_efforts': ['high'],
                    'default': 'extra', 'efforts': [{'id': 'extra', 'name': 'Extra', 'canonical': 'high'}]}},
                {'id': 'jet-hub-auto/auto'}, {'id': 'cn:glm-5.2'}, {'id': 'codearts/model-off'}]})
        return httpx.Response(200, json={'result': {'ok': True, 'value': {'models': [
            {'id': 'model-a', 'name': 'Huawei Model A', 'description': 'official', 'isFree': True},
            {'id': 'model-off', 'disabled': True}]}}})
    install_transport(monkeypatch, reply)
    with mock.patch('server.services.modelcatalog.catalog', side_effect=AssertionError('CA called WB catalog')):
        result = context['client'].get('/api/model-catalog', params={'platform': 'ca', 'force': True})
    assert result.status_code == 200, result.text
    data = result.json()
    assert [m['id'] for m in data['models']] == ['codearts/model-a']
    assert data['models'][0]['context_length'] == 300000
    assert data['models'][0]['efforts'] == ['high']
    assert data['models'][0]['default_effort'] == 'high'
    assert data['models'][0]['max_output_tokens'] == 32000
    assert data['summary']['total'] == 1 and data['source'] == 'codearts'
    assert codearts.cached_ids() == {'codearts/model-a'}


def test_ca_export_preserves_prefix_and_key_whitelist(context):
    c = context['client']
    key = create(c, 'ca', models=['codearts/model-a'])
    body = {'client': 'ccswitch', 'app': 'codex', 'token': key['key']}
    result = c.post('/api/keys/export', json=body)
    assert result.status_code == 200, result.text
    assert result.json()['realm'] == 'ca' and result.json()['models'] == ['codearts/model-a']
    assert 'codearts/model-a' in result.json()['settings_config']['config']
    for model in ('glm-5.2', 'codearts/not-allowed'):
        result = c.post('/api/keys/export', json={**body, 'models': [model]})
        assert result.status_code == 400


def test_ca_accounting_filters_success_errors_and_realtime(context, monkeypatch):
    from server import inflight
    from server.routers import stats
    c = context['client']
    ca = create(c, 'ca')
    wb = create(c, 'wb')
    for key, model, amount in [(ca, 'codearts/model-a', 18), (wb, 'glm-5.2', 33)]:
        gateway._record(key, '127.0.0.1', model, model, 200, amount - 7, 7, 200, None, None, False)
    # A wrong-platform rejection belongs to the initiating key, even though its model prefix differs.
    gateway._record(ca, '127.0.0.1', 'glm-5.2', 'glm-5.2', 400, 0, 0, 0, None, None, False)
    gateway._record(wb, '127.0.0.1', 'codearts/model-a', 'codearts/model-a', 400, 0, 0, 0, None, None, False)
    for realm, key, tokens in [('ca', ca, 18), ('cn', wb, 33)]:
        summary = c.get('/api/stats/summary', params={'realm': realm}).json()
        assert summary['today_tokens'] == tokens and summary['today_requests'] == 1
        assert summary['failures']['today_4xx'] == 1 and summary['usage_health']['ok']
        logs = c.get('/api/logs', params={'realm': realm}).json()['items']
        assert len(logs) == 2 and {l['key_id'] for l in logs} == {key['id']}
        assert {l['platform'] for l in logs} == {key['platform']}
        for endpoint in ('by-model', 'by-key'):
            rows = c.get('/api/stats/' + endpoint, params={'realm': realm, 'days': 1}).json()
            assert len(rows) == 1 and rows[0]['prompt_tokens'] + rows[0]['completion_tokens'] == tokens
        daily = c.get('/api/stats/daily', params={'realm': realm, 'days': 1}).json()
        hourly = c.get('/api/stats/hourly', params={'realm': realm}).json()
        assert sum(r['prompt_tokens'] + r['completion_tokens'] for r in daily) == tokens
        assert sum(r['prompt_tokens'] + r['completion_tokens'] for r in hourly) == tokens
        assert sum(r['failed'] for r in daily) == 1
    # Do not query Tencent status to display CA realtime metrics.
    monkeypatch.setattr(stats, '_upstream_status_cached', mock.AsyncMock(side_effect=AssertionError('CA queried WB')))
    stats._PEAK_CACHE.clear()
    stats._series_cache.clear()
    inflight.enter('ca')
    inflight.enter('wb')
    try:
        result = c.get('/api/stats/realtime', params={'platform': 'ca'}).json()
        assert result['client_inflight'] == 1 and result['rpm_60'] == 2
        assert result['peaks']['samples'] == 2 and 'capacity' not in result
    finally:
        inflight.leave('ca')
        inflight.leave('wb')
    assert c.get('/api/keys', params={'platform': 'ca'}).json()[0]['id'] == ca['id']
    assert len(c.get('/api/keys', params={'platform': 'ca'}).json()) == 1
    assert c.get('/api/keys', params={'platform': 'other'}).status_code == 400
    assert c.get('/api/stats/credits', params={'realm': 'ca', 'days': 1}).json()['today']['income'] == 0
    stats._PEAK_CACHE.clear()
    stats._series_cache.clear()
