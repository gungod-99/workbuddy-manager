"""Read-only CA dashboard projections; accounting stays with the official provider."""
from __future__ import annotations

import asyncio
import datetime
import math
import time

from .. import db
from . import codearts

_TZ = datetime.timezone(datetime.timedelta(hours=8))
_COUNTERS = {
    'requests': 'requests', 'reported_requests': 'reportedRequests',
    'input_tokens': 'inputTokens', 'output_tokens': 'outputTokens',
    'cache_read_tokens': 'cacheReadTokens', 'cache_write_tokens': 'cacheWriteTokens',
    'reasoning_tokens': 'reasoningTokens', 'total_tokens': 'totalTokens', 'errors': 'errors',
}


def _count(value: object) -> int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return int(value)
    return None


def _totals(value: object) -> dict:
    raw = value if isinstance(value, dict) else {}
    # Keep absent fields absent in meaning: they are unknown, not measured zeros.
    # Official totalTokens already includes cached input and reasoning output.
    return {target: _count(raw.get(source)) for target, source in _COUNTERS.items()}


def _status(value: object) -> dict:
    statuses = value.get('statuses') if isinstance(value, dict) else None
    row = statuses.get('codearts') if isinstance(statuses, dict) else None
    if not isinstance(row, dict):
        raise codearts.CodeArtsError('CA 服务未返回华为云渠道状态')
    accounts = row.get('accounts') if isinstance(row.get('accounts'), dict) else {}
    models = row.get('models') if isinstance(row.get('models'), dict) else {}
    return {'connected': True, 'closed': row.get('closed') if isinstance(row.get('closed'), bool) else None,
            'accounts_total': _count(accounts.get('total')), 'accounts_enabled': _count(accounts.get('enabled')),
            'models_total': _count(models.get('total')), 'models_disabled': _count(models.get('disabled')),
            'error': ''}


def _history(value: object, start: str, end: str) -> list[dict]:
    if not isinstance(value, dict) or not isinstance(value.get('history'), list):
        raise codearts.CodeArtsError('CA 官方账号用量响应格式异常')
    result = []
    for day in value['history']:
        if not isinstance(day, dict) or not isinstance(day.get('day'), str):
            continue
        key = day['day']
        try:
            if datetime.date.fromisoformat(key).isoformat() != key or not start <= key <= end:
                continue
        except ValueError:
            continue
        # Other providers, direct calls and global totals are different scopes.
        # Return only the official CA gateway projection, without credentials.
        for channel in day.get('channels') or []:
            if not isinstance(channel, dict) or channel.get('channel') != 'gateway':
                continue
            for provider in channel.get('providers') or []:
                if not isinstance(provider, dict) or provider.get('provider') != 'codearts':
                    continue
                accounts = []
                for row in provider.get('accounts') or []:
                    if not isinstance(row, dict):
                        continue
                    aid = row.get('accountId')
                    aid = aid if isinstance(aid, str) and aid.startswith('codearts-') else None
                    models = [{'model': 'codearts/' + model['model'].removeprefix('codearts/'),
                               'totals': _totals(model)}
                              for model in row.get('models') or []
                              if isinstance(model, dict) and isinstance(model.get('model'), str)]
                    accounts.append({'account_id': aid, 'totals': _totals(row.get('totals')), 'models': models})
                result.append({'day': key, 'totals': _totals(provider.get('totals')), 'accounts': accounts})
    return sorted(result, key=lambda row: row['day'])


def _quality(since: int, until: int) -> dict:
    row = dict(db.query_one(
        'SELECT COUNT(*) AS requests, '
        'SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS succeeded, '
        'SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failed, '
        'SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END) AS failures_4xx, '
        'SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS failures_5xx, '
        'SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END) AS rate_limited, '
        'AVG(CASE WHEN status >= 200 AND status < 300 AND latency_ms > 0 THEN latency_ms END) AS avg_latency_ms, '
        'COUNT(CASE WHEN status >= 200 AND status < 300 AND latency_ms > 0 THEN 1 END) AS latency_samples, '
        'AVG(CASE WHEN status >= 200 AND status < 300 AND first_token_ms > 0 THEN first_token_ms END) AS avg_first_token_ms, '
        'COUNT(CASE WHEN status >= 200 AND status < 300 AND first_token_ms > 0 THEN 1 END) AS first_token_samples, '
        'SUM(credit) AS reported_credit, COUNT(credit) AS credit_samples, '
        'SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens '
        "FROM request_logs WHERE realm = 'ca' AND key_id IS NOT NULL AND ts >= ? AND ts < ?",
        (since, until),
    ))
    for field in ('requests', 'succeeded', 'failed', 'failures_4xx', 'failures_5xx', 'rate_limited',
                  'latency_samples', 'first_token_samples', 'credit_samples', 'prompt_tokens', 'completion_tokens'):
        row[field] = int(row[field] or 0)
    row['other'] = row['requests'] - row['succeeded'] - row['failed']
    row['success_rate'] = round(100 * row['succeeded'] / row['requests'], 2) if row['requests'] else None
    row['unreported_credit'] = row['requests'] - row['credit_samples']
    for field in ('avg_latency_ms', 'avg_first_token_ms', 'reported_credit'):
        row[field] = round(float(row[field]), 2) if row[field] is not None else None
    speed = db.query_one(
        'SELECT SUM(completion_tokens) AS tokens, '
        'SUM(latency_ms - COALESCE(first_token_ms, 0)) AS generation_ms, COUNT(*) AS samples '
        "FROM request_logs WHERE realm = 'ca' AND key_id IS NOT NULL AND ts >= ? AND ts < ? "
        'AND status >= 200 AND status < 300 AND completion_tokens > 0 '
        'AND latency_ms > COALESCE(first_token_ms, 0)', (since, until),
    )
    row['tokens_per_sec'] = (round(speed['tokens'] * 1000 / speed['generation_ms'], 2)
                             if speed['generation_ms'] else None)
    row['throughput_samples'] = int(speed['samples'] or 0)
    return row


def _recent(since: int, until: int) -> list[dict]:
    rows = db.query(
        'SELECT l.id, l.ts, l.status, l.model, l.mapped_model, k.name AS key_name, '
        'l.prompt_tokens, l.completion_tokens, l.latency_ms, l.first_token_ms, l.credit, l.error '
        'FROM request_logs l LEFT JOIN api_keys k ON k.id = l.key_id '
        "WHERE l.realm = 'ca' AND l.key_id IS NOT NULL AND l.ts >= ? AND l.ts < ? "
        'ORDER BY l.id DESC LIMIT 8', (since, until),
    )
    return [{**dict(row), 'error': codearts.safe_error(row['error']) if row['error'] else ''} for row in rows]


async def dashboard(days: int = 14) -> dict:
    now = int(time.time())
    today = datetime.datetime.fromtimestamp(now, _TZ).date()
    start = today - datetime.timedelta(days=days - 1)
    since = int(datetime.datetime.combine(start, datetime.time.min, _TZ).timestamp())
    today_since = int(datetime.datetime.combine(today, datetime.time.min, _TZ).timestamp())
    until = today_since + 86400
    status, ledger = await asyncio.gather(
        codearts.rpc('provider.status', {'providers': ['codearts']}),
        codearts.rpc('usage.tokenLedgerHistory', {'sinceDays': days}), return_exceptions=True,
    )
    errors = {}
    try:
        if isinstance(status, BaseException):
            raise status
        projected_status = _status(status)
    except codearts.CodeArtsError as exc:
        errors['status'] = codearts.safe_error(exc)
        projected_status = {'connected': False, 'closed': None, 'accounts_total': None,
                            'accounts_enabled': None, 'models_total': None, 'models_disabled': None,
                            'error': errors['status']}
    try:
        if isinstance(ledger, BaseException):
            raise ledger
        history = _history(ledger, start.isoformat(), today.isoformat())
    except codearts.CodeArtsError as exc:
        errors['ledger'] = codearts.safe_error(exc)
        history = None
    return {'platform': 'ca', 'days': days, 'timezone': 'Asia/Shanghai', 'checked_at': now,
            'range': {'from': start.isoformat(), 'to': today.isoformat()},
            'status': projected_status, 'quality': _quality(since, until),
            'today': _quality(today_since, until), 'recent_requests': _recent(since, until),
            'ledger': {'source': 'codearts_official_gateway', 'retention_days': 90, 'history': history},
            'log_retention_days': db._REQUEST_LOG_RETAIN_DAYS, 'errors': errors}
