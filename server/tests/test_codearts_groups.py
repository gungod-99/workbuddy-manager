"""Exercise persisted group policy through management APIs and every inference protocol."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
from pathlib import Path
import shutil
import subprocess
import time

import httpx
import pytest

from server import db, keysvc
from server.services import codearts, codearts_groups
from server.tests.test_codearts_platform import context, create, install_transport, request_body


def account(name, **extra):
    return {'id': 'codearts-' + name, 'provider': 'codearts', 'source': 'file', 'enabled': True, **extra}


def transport(monkeypatch, rows, *, capability=True):
    def reply(request):
        if request.url.path == '/api/jet-hub':
            inner = json.loads(request.content)['payload']
            assert inner['method'] == 'account.list'
            return httpx.Response(200, json={'result': {'ok': True, 'value': {'accounts': rows}}})
        if request.url.path == codearts_groups.SCOPE_PATH:
            return httpx.Response(200, json={'version': 1}, headers={'x-wb-ca-scope': 'v1'}) if capability else httpx.Response(404)
        body = json.loads(request.content)
        result = {'id': 'chatcmpl-group', 'model': body['model'], 'choices': [
            {'index': 0, 'message': {'role': 'assistant', 'content': 'within group'}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 2, 'completion_tokens': 3, 'total_tokens': 5}}
        if body.get('stream'):
            chunk = {'id': result['id'], 'model': body['model'], 'choices': [
                {'index': 0, 'delta': {'content': 'within group'}, 'finish_reason': 'stop'}], 'usage': result['usage']}
            return httpx.Response(200, content=('data: ' + json.dumps(chunk) + '\n\ndata: [DONE]\n\n').encode(),
                                  headers={'content-type': 'text/event-stream'})
        return httpx.Response(200, json=result)
    return install_transport(monkeypatch, reply)


def decode_scope(token):
    encoded, signature = token.split('.')
    expected = hmac.new(b'ca-admin-sentinel', b'wb-ca-scope-v1.' + encoded.encode(), hashlib.sha256).digest()
    assert hmac.compare_digest(base64.urlsafe_b64decode(signature + '=='), expected)
    return json.loads(base64.urlsafe_b64decode(encoded + '=='))


@pytest.mark.skipif(not shutil.which('node'), reason='Node is required for signing interoperability')
def test_python_signature_is_accepted_by_the_node_gateway():
    helper = (Path(__file__).resolve().parents[2] / 'deploy/codearts/account-scope.mjs').as_uri()
    token = codearts_groups.scope_token(['codearts-b', 'codearts-a'], 'test-interoperability-key',
                                       '/v1/chat/completions', now=1700000000)
    script = f"import {{verifyScope}} from {json.dumps(helper)}; console.log(JSON.stringify([...verifyScope(process.argv[1], '/v1/chat/completions', 'test-interoperability-key', 1700000000)]));"
    output = subprocess.check_output(['node', '--input-type=module', '-e', script, token], text=True)
    assert json.loads(output) == ['codearts-a', 'codearts-b']


def test_group_lifecycle_and_key_binding(context, monkeypatch):
    c = context['client']
    transport(monkeypatch, [account('a'), account('b')])
    assert c.post('/api/ca/groups', json={'name': '   '}).status_code == 400
    group = c.post('/api/ca/groups', json={'name': ' A '}).json()
    gid = group['id']
    assert group['name'] == 'A' and group['account_count'] == group['key_count'] == 0
    assert c.post('/api/ca/groups', json={'name': 'A'}).status_code == 400
    assert c.patch(f'/api/ca/groups/{gid}', json={'name': 'Team A'}).json()['name'] == 'Team A'
    assert c.post('/api/ca/accounts/group', json={'account_ids': ['codearts-a', 'invalid'], 'group_id': gid}).status_code == 404
    assert codearts_groups.memberships() == {}
    assert c.post('/api/ca/accounts/group', json={'account_ids': ['codearts-a', 'codearts-b', 'codearts-a'], 'group_id': gid}).status_code == 200
    assert {a['group_id'] for a in c.get('/api/ca/accounts').json()['accounts']} == {gid}
    assert c.delete(f'/api/ca/groups/{gid}').status_code == 409
    ca = create(c, 'ca', ca_group_id=gid)
    assert ca['ca_group_id'] == gid and keysvc.resolve(ca['key'])['ca_group_id'] == gid
    groups = c.get('/api/ca/groups').json()['groups']
    assert groups[0]['account_count'] == 2 and groups[0]['key_count'] == 1
    assert c.post('/api/keys', json={'name': 'bad', 'platform': 'wb', 'ca_group_id': gid}).status_code == 400
    for invalid in (99999, 0, -1, True, '1'):
        assert c.post('/api/keys', json={'name': 'bad', 'platform': 'ca', 'ca_group_id': invalid}).status_code in (400, 422)
    assert c.post('/api/ca/accounts/group', json={'account_ids': ['codearts-a', 'codearts-b']}).status_code == 200
    assert c.delete(f'/api/ca/groups/{gid}').status_code == 409  # still bound by a key
    assert c.patch(f"/api/keys/{ca['id']}", json={'platform': 'wb'}).json()['ca_group_id'] is None
    assert c.delete(f'/api/ca/groups/{gid}').status_code == 200
    assert c.get('/api/ca/groups').json()['groups'] == []


def test_key_group_clear_and_move_take_effect_without_reissuing(context, monkeypatch):
    c = context['client']
    one = codearts_groups.save_group('one')['id']
    two = codearts_groups.save_group('two')['id']
    codearts_groups.assign(['codearts-a'], one)
    codearts_groups.assign(['codearts-b'], two)
    ca = create(c, 'ca', ca_group_id=one)
    sent = transport(monkeypatch, [account('a'), account('b')])
    headers = {'Authorization': 'Bearer ' + ca['key']}
    def invoke():
        return c.post('/v1/chat/completions', headers=headers, json=request_body('codearts/a', '/v1/chat/completions'))
    assert invoke().status_code == 200
    assert decode_scope(sent[-1].headers['x-wb-ca-scope'])['accounts'] == ['codearts-a']
    assert c.patch(f"/api/keys/{ca['id']}", json={'ca_group_id': two}).status_code == 200
    assert invoke().status_code == 200
    assert decode_scope(sent[-1].headers['x-wb-ca-scope'])['accounts'] == ['codearts-b']
    assert c.patch(f"/api/keys/{ca['id']}", json={'ca_group_id': None}).status_code == 200
    sent.clear()
    assert invoke().status_code == 200
    assert len(sent) == 1 and 'x-wb-ca-scope' not in sent[0].headers


@pytest.mark.parametrize('route', ['/v1/chat/completions', '/v2/chat/completions', '/v1/responses', '/v1/messages'])
@pytest.mark.parametrize('stream', [False, True])
def test_scoped_key_protocols_ignore_client_scope_and_sign_actual_path(context, monkeypatch, route, stream):
    c = context['client']
    gid = codearts_groups.save_group('restricted')['id']
    codearts_groups.assign(['codearts-a', 'codearts-disabled'], gid)
    ca = create(c, 'ca', ca_group_id=gid)
    sent = transport(monkeypatch, [account('a'), account('disabled', enabled=False), account('outside')])
    response = c.post(route, json=request_body('codearts/model-a', route, stream=stream), headers={
        'Authorization': 'Bearer ' + ca['key'], 'X-WB-CA-Scope': 'forged-outside-scope'})
    assert response.status_code == 200, response.text
    assert 'within group' in response.text
    assert len(sent) == 3
    assert [request.url.path for request in sent] == ['/api/jet-hub', '/v1/wb-account-scope', '/v1/chat/completions']
    for request in sent[1:]:
        scope = decode_scope(request.headers['x-wb-ca-scope'])
        assert scope['v'] == 1 and abs(scope['at'] - time.time()) < 10
        assert scope['accounts'] == ['codearts-a'] and scope['path'] == request.url.path
    assert 'ca-admin-sentinel' not in response.text


@pytest.mark.parametrize('failure', ['empty', 'disabled', 'unknown', 'missing', 'unpatched', 'malformed-capability'])
def test_fail_closed_never_sends_inference(context, monkeypatch, failure):
    c = context['client']
    gid = codearts_groups.save_group('restricted')['id']
    codearts_groups.assign(['codearts-a'], gid)
    ca = create(c, 'ca', ca_group_id=gid)
    if failure == 'missing':
        db.execute('DELETE FROM codearts_groups WHERE id = ?', (gid,))
    rows = [account('outside')]
    if failure != 'empty':
        rows.append(account('a', enabled=failure != 'disabled', source='missing' if failure == 'unknown' else 'file'))
    if failure == 'malformed-capability':
        def reply(request):
            if request.url.path == '/api/jet-hub':
                return httpx.Response(200, json={'result': {'ok': True, 'value': {'accounts': rows}}})
            return httpx.Response(200, json={'version': 1})  # the header is also mandatory
        sent = install_transport(monkeypatch, reply)
    else:
        sent = transport(monkeypatch, rows, capability=failure != 'unpatched')
    response = c.post('/v1/chat/completions', json=request_body('codearts/a', '/v1/chat/completions'),
                      headers={'Authorization': 'Bearer ' + ca['key']})
    assert response.status_code == 503, response.text
    assert not any(request.url.path == '/v1/chat/completions' for request in sent)
    assert keysvc.get_key(ca['id'])['used_tokens'] == 0


def test_pending_login_remembers_group_and_membership_cleanup_is_snapshot_safe(context, monkeypatch):
    gid = codearts_groups.save_group('new accounts')['id']
    async def rpc(method, *args, **kwargs):
        if method == 'account.create':
            return {'accountId': 'codearts-new', 'loginUrl': 'https://codearts.huaweicloud.com/authorize'}
        if method == 'account.list':
            # Simulates a login assigned after the account-list request started.
            codearts_groups.assign(['codearts-concurrent'], gid)
            return {'accounts': []}
    monkeypatch.setattr(codearts, 'rpc', rpc)
    result = context['client'].post('/api/ca/auth/start', json={'group_id': gid})
    assert result.status_code == 200
    codearts_groups.assign(['codearts-deleted'], gid)
    asyncio.run(codearts.accounts())
    assert codearts_groups.memberships() == {'codearts-new': gid, 'codearts-concurrent': gid}
    assert context['client'].post('/api/ca/auth/start', json={'group_id': 9999}).status_code == 400


def test_viewer_cannot_mutate_groups(context, monkeypatch):
    c = context['client']
    c.post('/api/logout')
    c.cookies.clear()
    assert c.post('/api/login', json={'username': 'viewer', 'password': 'test-password'}).status_code == 200
    sent = transport(monkeypatch, [account('a')])
    assert c.get('/api/ca/groups').status_code == 200
    for method, path, payload in [('POST', '/api/ca/groups', {'name': 'x'}),
                                  ('PATCH', '/api/ca/groups/1', {'name': 'x'}),
                                  ('DELETE', '/api/ca/groups/1', None),
                                  ('POST', '/api/ca/accounts/group', {'account_ids': ['codearts-a'], 'group_id': None})]:
        assert c.request(method, path, json=payload).status_code == 403
    assert not sent
