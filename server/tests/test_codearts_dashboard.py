"""CA dashboard uses complete logs and projects only official CA gateway history."""
from __future__ import annotations

import datetime
import json
import time

import pytest

from .test_codearts_platform import context, install_transport
from .test_codearts_rewards import respond
from server import db
from server.services import codearts


def totals(requests=1, tokens=21):
    return {'requests': requests, 'reportedRequests': 1, 'inputTokens': 10, 'outputTokens': 8,
            'cacheReadTokens': 3, 'cacheWriteTokens': 3, 'reasoningTokens': 5, 'totalTokens': tokens, 'errors': 0}


def history_provider(provider='codearts', **patch):
    return {'provider': provider, 'totals': totals(), 'secret': 'provider-secret-sentinel',
            'accounts': [{'accountId': 'codearts-a', 'totals': totals(), 'accessToken': 'account-secret-sentinel',
                          'models': [{'model': 'deepseek-v4.1-flash', **totals(), 'api_key': 'model-secret-sentinel'}]},
                         {'accountId': '-', 'totals': totals(), 'models': []}], **patch}


def transport(monkeypatch, *, unavailable=()):
    day = codearts._today()
    def reply(request):
        method = json.loads(request.content)['payload']['method']
        if method in unavailable:
            return respond(None)
        if method == 'provider.status':
            return respond({'statuses': {'codearts': {'accounts': {'total': 6, 'enabled': 5},
                'models': {'total': 12, 'disabled': 1}, 'closed': False, 'api_key': 'status-secret-sentinel'},
                'buddy': {'accounts': {'total': 99}}}})
        assert method == 'usage.tokenLedgerHistory'
        return respond({'totals': totals(99999, 99999999), 'history': [
            {'day': '2000-01-01', 'channels': [{'channel': 'gateway', 'providers': [history_provider()]}]},
            {'day': '2099-01-01', 'channels': [{'channel': 'gateway', 'providers': [history_provider()]}]},
            {'day': day, 'totals': totals(99999, 99999999), 'channels': [
                {'channel': 'direct', 'providers': [history_provider()]},
                {'channel': 'gateway', 'providers': [history_provider('buddy'), history_provider()]}]},
        ]})
    return install_transport(monkeypatch, reply)


def log(status=200, *, realm='ca', key=1, at=None, latency=1000, first=200, credit=None, pt=10, ct=8, error=None):
    db.execute('INSERT INTO request_logs(ts,key_id,model,status,prompt_tokens,completion_tokens,'
               'latency_ms,first_token_ms,credit,realm,error) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
               (at or int(time.time()), key, 'codearts/deepseek-v4.1-flash', status, pt, ct, latency, first, credit, realm, error))


def test_ca_projection_excludes_other_providers_direct_calls_global_totals_and_secrets(context, monkeypatch):
    sent = transport(monkeypatch)
    result = context['client'].get('/api/ca/dashboard', params={'days': 14})
    assert result.status_code == 200
    value = result.json()
    assert value['platform'] == 'ca' and value['timezone'] == 'Asia/Shanghai'
    assert value['status'] == {'connected': True, 'closed': False, 'accounts_total': 6, 'accounts_enabled': 5,
                              'models_total': 12, 'models_disabled': 1, 'error': ''}
    history = value['ledger']['history']
    assert len(history) == 1 and history[0]['totals']['requests'] == 1
    assert history[0]['accounts'][1]['account_id'] is None
    assert history[0]['accounts'][0]['totals']['total_tokens'] == 21
    assert history[0]['accounts'][0]['models'][0]['model'] == 'codearts/deepseek-v4.1-flash'
    assert not any(text in result.text for text in ('sentinel', '99999999', 'buddy', '2099-01-01', '2000-01-01'))
    assert sorted(json.loads(row.content)['payload']['method'] for row in sent) == ['provider.status', 'usage.tokenLedgerHistory']


def test_request_quality_counts_zero_token_errors_and_preserves_unknown_credits(context, monkeypatch):
    transport(monkeypatch)
    log(200, credit=0)
    log(200, latency=2000, first=None)
    log(429, latency=9000, first=1000, pt=0, ct=0)
    log(503, latency=9000, first=1000, pt=0, ct=0)
    log(200, realm='cn', credit=9999)
    log(401, key=None)
    log(200, at=int(time.time()) - 3 * 86400)
    value = context['client'].get('/api/ca/dashboard', params={'days': 1}).json()
    row = value['quality']
    assert row['requests'] == 4 and row['succeeded'] == 2 and row['failed'] == 2
    assert row['success_rate'] == 50 and row['failures_4xx'] == row['failures_5xx'] == row['rate_limited'] == 1
    assert row['avg_latency_ms'] == 1500 and row['latency_samples'] == 2
    assert row['avg_first_token_ms'] == 200 and row['first_token_samples'] == 1
    assert row['tokens_per_sec'] == 5.71 and row['throughput_samples'] == 2
    assert row['reported_credit'] == 0 and row['credit_samples'] == 1 and row['unreported_credit'] == 3
    assert len(value['recent_requests']) == 4 and value['today'] == row
    db.execute("UPDATE request_logs SET credit = NULL WHERE realm = 'ca'")
    row = context['client'].get('/api/ca/dashboard', params={'days': 1}).json()['quality']
    assert row['reported_credit'] is None and row['credit_samples'] == 0


def test_empty_quality_does_not_report_perfect_success_or_zero_latency(context, monkeypatch):
    transport(monkeypatch)
    row = context['client'].get('/api/ca/dashboard').json()['quality']
    assert row['requests'] == 0 and row['succeeded'] == 0 and row['failed'] == 0
    assert row['success_rate'] is None and row['avg_latency_ms'] is None and row['avg_first_token_ms'] is None
    assert row['tokens_per_sec'] is None and row['reported_credit'] is None


def test_partial_rpc_failure_keeps_quality_and_never_borrows_workbuddy_status(context, monkeypatch):
    transport(monkeypatch, unavailable=('provider.status', 'usage.tokenLedgerHistory'))
    log(503)
    value = context['client'].get('/api/ca/dashboard').json()
    assert value['status']['connected'] is False and value['status']['accounts_total'] is None
    assert value['ledger']['history'] is None and set(value['errors']) == {'status', 'ledger'}
    assert value['quality']['requests'] == value['quality']['failed'] == 1


def test_missing_official_counters_stay_unknown_in_projection(context, monkeypatch):
    day = codearts._today()
    def reply(request):
        method = json.loads(request.content)['payload']['method']
        if method == 'provider.status':
            return respond({'statuses': {'codearts': {'closed': False}}})
        return respond({'history': [{'day': day, 'channels': [{'channel': 'gateway',
            'providers': [history_provider(totals={'requests': 2, 'totalTokens': None})]}]}]})
    install_transport(monkeypatch, reply)
    value = context['client'].get('/api/ca/dashboard').json()
    assert value['status']['models_total'] is None
    assert value['ledger']['history'][0]['totals']['total_tokens'] is None


def test_bounded_recent_rows_redact_auth_errors(context, monkeypatch):
    transport(monkeypatch)
    for _ in range(12):
        log(400, error='failed http://localhost:19000/callback?code=hidden-callback Bearer ' + 's' * 43)
    result = context['client'].get('/api/ca/dashboard')
    assert len(result.json()['recent_requests']) == 8
    assert 'hidden-callback' not in result.text and 's' * 43 not in result.text


@pytest.mark.parametrize('days', [0, -1, 91, 9999999999999999])
def test_invalid_dashboard_ranges_rejected_before_rpc(context, monkeypatch, days):
    sent = transport(monkeypatch)
    assert context['client'].get('/api/ca/dashboard', params={'days': days}).status_code == 422
    assert not sent


def test_dashboard_requires_auth_and_viewer_can_read_without_mutations(context, monkeypatch):
    sent = transport(monkeypatch)
    client = context['client']
    client.cookies.clear()
    assert client.get('/api/ca/dashboard').status_code == 401 and not sent
    assert client.post('/api/login', json={'username': 'viewer', 'password': 'test-password'}).status_code == 200
    assert client.get('/api/ca/dashboard').status_code == 200
    assert len(sent) == 2
