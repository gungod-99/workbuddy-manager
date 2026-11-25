"""CA balances, official daily claims and authorization lifecycle contracts."""
from __future__ import annotations

import asyncio
import json
import time
from unittest import mock

import httpx
import pytest

from .test_codearts_platform import context, install_transport
from server import db, tokensvc
from server.services import codearts


def respond(value):
    return httpx.Response(200, json={'result': {'ok': True, 'value': value}})


def test_balance_zero_unknown_packages_and_secret_projection(context, monkeypatch):
    sent = install_transport(monkeypatch, lambda request: respond({'fromCache': True, 'accounts': [
        {'accountId': 'codearts-a', 'nickname': 'A', 'balance': {'total': 0, 'expiredTotal': 120,
         'packages': [{'name': '基础积分包', 'unit': 'credit', 'remaining': 0, 'total': 500,
          'used': 500, 'active': True, 'deductionEndTime': 1798243200000, 'access_token': 'dont-export'}]}},
        {'accountId': 'codearts-b', 'nickname': 'B', 'balance': None,
         'error': 'failed http://localhost/?code=secret-code&state=secret-state Bearer ' + 's' * 43},
        {'accountId': 'codearts-c', 'nickname': 'C', 'balance': {'total': 1234.56, 'packages': [
         {'name': '赠送积分包', 'unit': 'credit', 'remaining': 1234.56, 'active': True,
          'expiredTime': '', 'expiringRemaining': 100}]}},
        {'accountId': 'buddy-other', 'balance': {'total': 999}},
    ]}))
    result = context['client'].get('/api/ca/credits', params={'force': True})
    assert result.status_code == 200
    value = result.json()
    assert value['total'] == 1234.56 and value['known_accounts'] == 2 and value['unknown_accounts'] == 1
    assert value['accounts'][0]['balance']['total'] == 0
    assert value['accounts'][1]['balance'] is None
    assert value['accounts'][0]['balance']['packages'][0]['expires_at'] == 1798243200
    assert value['accounts'][2]['balance']['packages'][0]['expires_at'] is None
    assert value['from_cache'] is True
    for secret in ('dont-export', 'secret-code', 'secret-state', 's' * 43):
        assert secret not in result.text
    payload = json.loads(sent[0].content)['payload']
    assert payload == {'method': 'credits.balances', 'payload': {'provider': 'codearts', 'force': True}}


def test_all_unknown_balances_are_not_reported_as_zero(context, monkeypatch):
    install_transport(monkeypatch, lambda request: respond({'accounts': [{'accountId': 'codearts-a', 'balance': None}]}))
    value = context['client'].get('/api/ca/credits').json()
    assert value['total'] is None and value['unknown_accounts'] == 1
    assert value['accounts'][0]['error']


def test_checkin_partial_failure_is_preserved_and_only_calls_ca(context, monkeypatch):
    def reply(request):
        payload = json.loads(request.content)['payload']
        assert payload == {'method': 'credits.claimAll', 'payload': {'provider': 'codearts'}}
        return respond({'results': [
            {'accountId': 'codearts-a', 'nickname': 'A', 'outcome': {'kind': 'claimed', 'credit': 800}},
            {'accountId': 'codearts-b', 'nickname': 'B', 'outcome': {'kind': 'already-claimed'}},
            {'accountId': 'codearts-c', 'nickname': 'C', 'outcome': {'kind': 'failed', 'message': 'renewal failed https://secret.test/?code=private-code'}},
            {'accountId': 'codearts-d', 'nickname': 'D', 'outcome': {'kind': 'inactive', 'actionRequired': True, 'message': '请开通活动'}},
        ], 'summary': {'claimed': 1, 'alreadyClaimed': 1, 'inactive': 1, 'failed': 1, 'totalCredit': 800}})
    sent = install_transport(monkeypatch, reply)
    result = context['client'].post('/api/ca/checkin')
    assert result.status_code == 200
    value = result.json()
    assert value['summary'] == {'claimed': 1, 'already_claimed': 1, 'inactive': 1, 'failed': 1, 'total_credit': 800}
    assert value['results'][0]['credit'] == 800
    assert value['results'][2]['kind'] == 'failed' and 'private-code' not in result.text
    assert value['results'][3]['action_required'] is True
    assert db.get_setting('codearts_last_checkin') == value
    assert codearts._latest_account_checkin('codearts-c')['kind'] == 'failed'
    value['date'] = '2000-01-01'
    db.set_setting('codearts_last_checkin', value)
    assert codearts._latest_account_checkin('codearts-a') is None
    assert len(sent) == 1


def test_concurrent_manual_claim_returns_conflict_instead_of_second_claim(context, monkeypatch):
    sent = install_transport(monkeypatch, lambda request: respond({}))
    assert codearts._checkin_lock.acquire(blocking=False)
    try:
        result = context['client'].post('/api/ca/checkin')
        assert result.status_code == 409 and not sent
    finally:
        codearts._checkin_lock.release()


def test_auto_schedule_separates_writes_and_only_exports_ca_status(context, monkeypatch):
    state = {'enabled': False, 'times': ['09:00', '21:00'], 'jitterMinutes': 0,
             'nextRunAt': 1798243200000, 'running': False, 'lastAt': 1798156800000,
             'lastResult': 'opencode other-provider-must-not-export',
             'channels': [{'provider': 'opencode', 'text': 'other-provider-must-not-export'},
                          {'provider': 'codearts', 'text': '3 个账号今日已领'}]}
    def reply(request):
        inner = json.loads(request.content)['payload']
        assert inner['method'] == 'usage.autoCheckin'
        state.update(inner['payload'])
        return respond({'autoCheckin': state})
    sent = install_transport(monkeypatch, reply)
    result = context['client'].patch('/api/ca/auto-checkin', json={
        'times': ['22:10', '08:20'], 'jitter_minutes': 0, 'enabled': True})
    assert result.status_code == 200
    value = result.json()
    assert value['enabled'] is True and value['times'] == ['08:20', '22:10']
    assert value['timezone'] == 'Asia/Shanghai' and value['next_run_at'] == 1798243200
    assert value['last_result'] == '3 个账号今日已领'
    assert 'other-provider-must-not-export' not in result.text
    assert [json.loads(r.content)['payload']['payload'] for r in sent] == [
        {'times': ['08:20', '22:10'], 'jitterMinutes': 0}, {'enabled': True}]


@pytest.mark.parametrize('body', [{'times': ['09:00']}, {'times': ['09:00', '09:00']},
    {'times': ['25:00', '09:00']}, {'enabled': 'true'}, {'jitter_minutes': -1}, {'jitter_minutes': True},
    {'jitter_minutes': 121}, {'provider': 'buddy'}])
def test_invalid_schedule_is_rejected_before_rpc(context, monkeypatch, body):
    sent = install_transport(monkeypatch, lambda request: respond({}))
    assert context['client'].patch('/api/ca/auto-checkin', json=body).status_code == 422
    assert not sent


def test_auto_status_without_ca_results_does_not_claim_ca_is_unsupported(context, monkeypatch):
    install_transport(monkeypatch, lambda request: respond({'autoCheckin': {'enabled': True, 'times': ['09:00', '21:00'],
        'lastAt': 1798156800000, 'lastResult': 'unsupported opencode', 'channels': [{'provider': 'opencode', 'text': 'unsupported'}]}}))
    value = context['client'].get('/api/ca/auto-checkin').json()
    assert value['last_at'] is None and value['last_result'] == ''


@pytest.mark.parametrize('path,method', [('/api/ca/checkin', 'post'), ('/api/ca/auto-checkin', 'patch'),
                                      ('/api/ca/auth/codearts-a/cancel', 'post')])
def test_mutations_require_admin_session(context, monkeypatch, path, method):
    sent = install_transport(monkeypatch, lambda request: respond({}))
    client = context['client']
    token = tokensvc.create_token('test-admin', 'admin')['token']
    client.cookies.clear()
    kwargs = {'json': {'enabled': True}} if method == 'patch' else {}
    assert getattr(client, method)(path, headers={'Authorization': 'Bearer ' + token}, **kwargs).status_code == 403
    client.post('/api/login', json={'username': 'viewer', 'password': 'test-password'})
    assert getattr(client, method)(path, **kwargs).status_code == 403
    assert not sent


def test_cancel_never_deletes_a_completed_or_exchanging_account(context, monkeypatch):
    for done in (True, False):
        async def rpc(method, payload=None, **kwargs):
            assert method == 'login.poll'  # Any account.delete here would be a regression.
            return {'done': done, 'success': done}
        monkeypatch.setattr(codearts, 'rpc', rpc)
        codearts._pending['codearts-a'] = {'expires_at': time.time() + 180, 'submitted': True,
                                           'cancelled': False, 'lock': asyncio.Lock()}
        result = context['client'].post('/api/ca/auth/codearts-a/cancel')
        assert result.status_code == 200
        assert result.json()['preserved'] is done
    assert context['client'].post('/api/ca/auth/buddy-a/cancel').status_code == 400


def test_cancelled_login_cannot_accept_callback(context, monkeypatch):
    codearts._pending['codearts-a'] = {'expires_at': time.time() + 180, 'submitted': False,
                                       'cancelled': True, 'lock': asyncio.Lock()}
    sent = install_transport(monkeypatch, lambda request: respond({}))
    result = context['client'].post('/api/ca/auth/codearts-a/callback', json={
        'callback_url': 'http://localhost:19000/oauth/callback?code=a&state=b'})
    assert result.status_code == 409 and not sent


def test_closing_an_accepted_login_preserves_completed_account_and_credits(context, monkeypatch):
    codearts._pending['codearts-a'] = {'expires_at': time.time() + 180, 'submitted': True,
                                       'cancelled': True, 'lock': asyncio.Lock()}

    def reply(request):
        method = json.loads(request.content)['payload']['method']
        if method == 'account.list':
            return respond({'accounts': [{'id': 'codearts-a', 'provider': 'codearts',
                                         'source': 'file', 'nickname': 'A'}]})
        assert method == 'credits.balances'
        return respond({'accounts': [{'accountId': 'codearts-a', 'nickname': 'A',
                                     'balance': {'total': 1250, 'packages': []}}]})

    install_transport(monkeypatch, reply)
    accounts = context['client'].get('/api/ca/accounts').json()['accounts']
    assert len(accounts) == 1 and accounts[0]['credential_status'] == 'available'
    credits = context['client'].get('/api/ca/credits').json()
    assert credits['known_accounts'] == 1 and credits['total'] == 1250
    assert credits['accounts'][0]['account_id'] == accounts[0]['id']


def test_poll_preserves_official_terminal_result_when_placeholder_has_been_removed(context, monkeypatch):
    codearts._pending['codearts-a'] = {'expires_at': time.time() + 180}
    sent = install_transport(monkeypatch, lambda request: respond({'done': True, 'success': False, 'error': 'Huawei login failed'}))
    result = context['client'].get('/api/ca/auth/codearts-a/poll')
    assert result.status_code == 200 and result.json()['error'] == 'Huawei login failed'
    assert len(sent) == 1 and 'codearts-a' not in codearts._pending


def test_restart_poll_returns_restart_feedback_without_infinite_wait(context, monkeypatch):
    async def rpc(method, payload=None, **kwargs):
        return {'accounts': [{'id': 'codearts-a', 'provider': 'codearts'}]} if method == 'account.list' else {'done': False}
    monkeypatch.setattr(codearts, 'rpc', rpc)
    assert context['client'].get('/api/ca/auth/codearts-a/poll').status_code == 409


def test_duplicate_callback_submissions_are_idempotent_at_manager_boundary(context, monkeypatch):
    codearts._pending['codearts-a'] = {'expires_at': time.time() + 180, 'submitted': False,
                                       'cancelled': False, 'lock': asyncio.Lock()}
    sent = install_transport(monkeypatch, lambda request: respond({'accepted': True}))
    for _ in range(2):
        result = context['client'].post('/api/ca/auth/codearts-a/callback', json={
            'callback_url': 'http://localhost:19000/oauth/callback?code=a&state=b'})
        assert result.status_code == 200 and result.json()['accepted'] is True
    assert len(sent) == 1


@pytest.mark.parametrize('url', ['http://localhost:invalid/?code=a&state=b', 'http://localhost:19000/oauth/callback?state=b',
                                'http://localhost:19000/oauth/callback?code=%20&secret=',
                                'http://localhost/?code=a&state=b', 'http://localhost:19000/?code=a&state=b#x'])
def test_incomplete_callbacks_return_useful_400_instead_of_500(context, monkeypatch, url):
    codearts._pending['codearts-a'] = {'expires_at': time.time() + 180, 'submitted': False,
                                       'cancelled': False, 'lock': asyncio.Lock()}
    sent = install_transport(monkeypatch, lambda request: respond({}))
    assert context['client'].post('/api/ca/auth/codearts-a/callback', json={'callback_url': url}).status_code == 400
    assert not sent


@pytest.mark.parametrize('url', ['http://127.0.0.1:19000/oauth/callback?code=a',
                                'http://localhost:19000/oauth/callback?secret=a&redirect=true'])
def test_official_callbacks_without_state_reach_the_same_pending_receiver(context, monkeypatch, url):
    codearts._pending['codearts-a'] = {'expires_at': time.time() + 180, 'submitted': False,
                                       'cancelled': False, 'lock': asyncio.Lock()}
    sent = install_transport(monkeypatch, lambda request: respond({'accepted': True}))
    result = context['client'].post('/api/ca/auth/codearts-a/callback', json={'callback_url': url})
    assert result.status_code == 200 and result.json()['accepted'] is True
    assert json.loads(sent[0].content)['payload'] == {
        'method': 'account.submitCallback', 'payload': {'accountId': 'codearts-a', 'callbackUrl': url}}


def test_long_callback_is_forwarded_completely_without_logging_credentials(context, monkeypatch):
    codearts._pending['codearts-a'] = {'expires_at': time.time() + 180, 'submitted': False,
                                       'cancelled': False, 'lock': asyncio.Lock()}
    sent = install_transport(monkeypatch, lambda request: respond({'accepted': True}))
    url = 'http://localhost:19000/oauth/callback?code=' + 'x' * 3800 + '&state=' + 'y' * 2000
    result = context['client'].post('/api/ca/auth/codearts-a/callback', json={'callback_url': url})
    assert result.status_code == 200 and result.json()['accepted'] is True
    assert json.loads(sent[0].content)['payload']['payload']['callbackUrl'] == url
    assert 'xxxxxx' not in result.text and 'yyyyyy' not in result.text
