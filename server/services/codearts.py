"""Private, bounded bridge to the official CodeArts service; never exports credentials."""
from __future__ import annotations

import asyncio
import datetime
import math
import re
import threading
import time
import uuid
from urllib.parse import parse_qs, urlsplit

from .. import config, db, upstreamsvc
from . import modelcatalog, platforms

_cache: dict = {}
_cache_lock = threading.Lock()
_pending: dict[str, dict] = {}
# Matches the pinned official OAuth callback timeout; the UI must not promise 15 minutes.
LOGIN_SECONDS = 180
_checkin_lock = threading.Lock()
_schedule_lock = threading.Lock()


class CodeArtsError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def safe_error(raw: object) -> str:
    text = str(raw or 'CA 服务未给出详细原因')
    text = re.sub(r'https?://[^\s<>"\']+', '[链接已隐藏]', text)
    text = re.sub(r'(?i)(bearer\s+|(?:access|refresh)[_-]?token["\s:=]+|(?:api[_-]?key|secret|password|code|state)["\s:=]+)[^\s,;"\'}]+', r'\1[已隐藏]', text)
    text = re.sub(r'\b[A-Za-z0-9_-]{40,}\b', '[已隐藏]', text)
    return ' '.join(text.split())[:350]


async def rpc(method: str, payload: dict | None = None, *, timeout: int = 20):
    # This is an internal helper, never an arbitrary-RPC public endpoint.
    try:
        base, admin = platforms.codearts_connection()
    except ValueError as exc:
        raise CodeArtsError(str(exc), 503) from exc
    body = {'type': 'client-request', 'rpcId': uuid.uuid4().hex,
            'method': 'jet-hub', 'payload': {'method': method, 'payload': payload or {}}}
    try:
        async with config.http_client(timeout, connect=3, proxy='', lane='codearts-admin') as client:
            response = await client.post(base + '/api/jet-hub', json=body,
                                         headers={'Authorization': 'Bearer ' + admin})
        if response.status_code in (401, 403):
            raise CodeArtsError('CA 内部管理凭据失效，请检查服务配置', 503)
        if response.status_code != 200:
            raise CodeArtsError('CA 管理服务返回 HTTP ' + str(response.status_code))
        result = response.json().get('result')
        if not isinstance(result, dict) or result.get('ok') is not True:
            error = result.get('error') if isinstance(result, dict) else None
            detail = error.get('message') if isinstance(error, dict) else error
            raise CodeArtsError(safe_error(detail), 400 if isinstance(error, dict) and error.get('code') == 'bad-request' else 502)
        # Official mutation RPCs return undefined => value is omitted from JSON.
        return result.get('value')
    except CodeArtsError:
        raise
    except Exception as exc:
        raise CodeArtsError('无法连接 CA 服务，请检查 CodeArts 服务运行状态', 503) from exc


def invalidate_catalog() -> None:
    with _cache_lock:
        _cache.clear()


def cached_ids() -> set[str] | None:
    with _cache_lock:
        value = _cache.get('payload')
        if value is None or value.get('source') == 'none':
            return None
        return {m['id'] for m in value.get('models', [])}


def _seconds(value: object) -> int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 < value <= 8640000000000000:
        return int(value / 1000)
    return None


def _account(raw: dict) -> dict:
    expiration = _seconds(raw.get('expiresAt'))
    rates = raw.get('modelRateLimits') or {}
    if not isinstance(rates, dict):
        rates = {}
    return {
        'id': str(raw.get('id') or ''), 'platform': 'ca',
        'nickname': str(raw.get('nickname') or raw.get('id') or '')[:128],
        'enabled': raw.get('enabled') is not False,
        'expires_at': expiration, 'is_expired': bool(expiration and expiration <= time.time()),
        'created_at': _seconds(raw.get('createdAt')),
        'last_used_at': _seconds(raw.get('lastUsedAt')),
        'refreshable': raw.get('refreshable') is True,
        'credential_status': ('available' if raw.get('source') in ('file', 'env', 'runtime', 'memory')
                              else 'pending' if str(raw.get('id')) in _pending else 'unknown'),
        'model_rate_limits': {('codearts/' + str(mid).removeprefix('codearts/')): _seconds(at)
                              for mid, at in rates.items() if isinstance(rates, dict)
                              and isinstance(at, (int, float)) and at > time.time() * 1000},
    }


def _prune_pending() -> None:
    now = time.time()
    for aid, state in list(_pending.items()):
        if state.get('expires_at', 0) + 90 <= now:
            _pending.pop(aid, None)


async def accounts() -> list[dict]:
    _prune_pending()
    value = await rpc('account.list', {'provider': 'codearts'})
    rows = (value or {}).get('accounts') or []
    return [_account(a) for a in rows if isinstance(a, dict) and a.get('provider') == 'codearts'
            and not (_pending.get(str(a.get('id')), {}).get('cancelled')
                     and a.get('source') not in ('file', 'env', 'runtime', 'memory'))]


async def require_account(account_id: str, *, allow_pending: bool = False) -> None:
    if not account_id.startswith('codearts-'):
        raise CodeArtsError('该账号不属于 CA 平台', 400)
    current = time.time()
    if allow_pending and _pending.get(account_id, {}).get('expires_at', 0) > current:
        return
    if not any(a['id'] == account_id for a in await accounts()):
        raise CodeArtsError('CA 账号不存在或登录已经结束', 404)


async def start_login() -> dict:
    _prune_pending()
    # Supported official preference; headless server never tries to open a browser.
    await rpc('loginPreferences.setEnabled', {'enabled': False})
    started_at = time.time()
    value = await rpc('account.create', {'provider': 'codearts'}, timeout=35)
    aid = str((value or {}).get('accountId') or '')
    login_url = str((value or {}).get('loginUrl') or '')
    parsed = urlsplit(login_url)
    if not aid.startswith('codearts-') or parsed.scheme != 'https' or not (
        parsed.hostname and (parsed.hostname == 'huaweicloud.com' or parsed.hostname.endswith('.huaweicloud.com'))
    ):
        raise CodeArtsError('CA 授权链接格式异常，请检查官方服务版本')
    expires_at = int(started_at + LOGIN_SECONDS)
    _pending[aid] = {'expires_at': expires_at, 'cancelled': False,
                     'submitted': False, 'lock': asyncio.Lock()}
    invalidate_catalog()
    return {'account_id': aid, 'login_url': login_url, 'expires_at': expires_at}


async def poll_login(account_id: str) -> dict:
    if not account_id.startswith('codearts-'):
        raise CodeArtsError('该账号不属于 CA 平台', 400)
    if account_id not in _pending:
        await require_account(account_id)
    value = await rpc('login.poll', {'accountId': account_id}) or {}
    out = {'done': value.get('done') is True, 'success': value.get('success') is True}
    if value.get('error'):
        out['error'] = safe_error(value['error'])
    if out['done']:
        _pending.pop(account_id, None)
        invalidate_catalog()
    elif account_id not in _pending:
        raise CodeArtsError('本轮授权已结束或面板已重启，请重新添加 CA 账号', 409)
    elif _pending[account_id]['expires_at'] <= time.time() and not _pending[account_id]['submitted']:
        out.update(done=True, success=False, error='本轮授权已超时，请重新生成授权链接')
        _pending.pop(account_id, None)
    return out


async def submit_callback(account_id: str, callback_url: str) -> dict:
    if not account_id.startswith('codearts-'):
        raise CodeArtsError('该账号不属于 CA 平台', 400)
    pending = _pending.get(account_id)
    if pending is None or pending['cancelled'] or pending['expires_at'] <= time.time():
        raise CodeArtsError('本轮授权已结束或面板已重启，请重新添加 CA 账号', 409)
    try:
        parsed = urlsplit(callback_url.strip())
        port = parsed.port
        params = parse_qs(parsed.query)
    except ValueError as exc:
        raise CodeArtsError('回调链接格式不正确，请复制浏览器地址栏的完整地址', 400) from exc
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')
            or parsed.username or parsed.password or not port or parsed.fragment):
        raise CodeArtsError('请粘贴华为授权后地址栏中的完整 localhost／127.0.0.1 回调链接', 400)
    if not any(value.strip() for key in ('code', 'secret') for value in params.get(key, [])):
        raise CodeArtsError('回调链接缺少授权参数，请复制地址栏中的完整链接', 400)
    # Huawei supports code-only OAuth and secret-based fallback callbacks. The
    # official receiver validates the path and uses the original PKCE/DPoP flow;
    # imposing an extra state parameter here rejects valid Huawei callbacks.
    async with pending['lock']:
        if pending['cancelled'] or _pending.get(account_id) is not pending:
            raise CodeArtsError('本轮授权已结束，请重新添加 CA 账号', 409)
        if pending['submitted']:
            return {'accepted': True}
        value = await rpc('account.submitCallback', {'accountId': account_id, 'callbackUrl': callback_url.strip()})
        pending['submitted'] = (value or {}).get('accepted') is True
        return {'accepted': pending['submitted']}


async def cancel_login(account_id: str) -> dict:
    if not account_id.startswith('codearts-'):
        raise CodeArtsError('该账号不属于 CA 平台', 400)
    pending = _pending.get(account_id)
    if pending is None:
        return {'ok': True, 'preserved': True}
    async with pending['lock']:
        pending['cancelled'] = True
    # The official service has no atomic CA cancel RPC. account.delete can race
    # credential exchange and erase a completed account, so leave timeout cleanup
    # to the official flow. Already accepted authorizations may still finish.
    value = await rpc('login.poll', {'accountId': account_id}) or {}
    if value.get('done') is True:
        _pending.pop(account_id, None)
        invalidate_catalog()
    return {'ok': True, 'preserved': value.get('success') is True}


async def update_account(account_id: str, patch: dict) -> dict:
    await require_account(account_id)
    await rpc('account.update', {'accountId': account_id, 'patch': patch})
    invalidate_catalog()
    return {'ok': True}


async def delete_account(account_id: str) -> dict:
    await require_account(account_id)
    await rpc('account.delete', {'accountId': account_id})
    _pending.pop(account_id, None)
    invalidate_catalog()
    return {'ok': True}


async def refresh_account(account_id: str) -> dict:
    await require_account(account_id)
    value = await rpc('account.refresh', {'accountId': account_id}, timeout=45)
    if not (value or {}).get('success'):
        raise CodeArtsError('CA 账号续期未成功，请重新授权')
    invalidate_catalog()
    return {'ok': True}


def _number(value: object) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _text(value: object, limit: int = 128) -> str:
    return safe_error(value)[:limit] if value else ''


def _balance(value: object) -> dict | None:
    if not isinstance(value, dict) or _number(value.get('total')) is None:
        return None
    packages = []
    for raw in value.get('packages') or []:
        if not isinstance(raw, dict):
            continue
        packages.append({
            'name': _text(raw.get('name')), 'unit': 'token' if raw.get('unit') == 'token' else 'credit',
            'remaining': _number(raw.get('remaining')), 'total': _number(raw.get('total')),
            'used': _number(raw.get('used')), 'active': raw.get('active') is True,
            'expires_at': _seconds(raw.get('deductionEndTime')),
            'expired_time': _text(raw.get('expiredTime')),
            'expiring_remaining': _number(raw.get('expiringRemaining')),
            'expiry_note': _text(raw.get('expiryNote'), 300),
        })
    return {'total': _number(value.get('total')), 'expired_total': _number(value.get('expiredTotal')),
            'expiring_total': _number(value.get('expiringTotal')), 'packages': packages}


async def credits(force: bool = False) -> dict:
    value = await rpc('credits.balances', {'provider': 'codearts', 'force': force}, timeout=90)
    if not isinstance(value, dict) or not isinstance(value.get('accounts'), list):
        raise CodeArtsError('CA 积分响应格式异常，请刷新重试')
    rows = []
    for raw in value['accounts']:
        if not isinstance(raw, dict) or not str(raw.get('accountId', '')).startswith('codearts-'):
            continue
        balance = _balance(raw.get('balance'))
        rows.append({'account_id': raw['accountId'], 'nickname': _text(raw.get('nickname')),
                     'balance': balance, 'error': _text(raw.get('error'), 350) or ('' if balance is not None else '积分尚未获取，请刷新重试'),
                     'checkin': _latest_account_checkin(raw['accountId'])})
    available = [row['balance']['total'] for row in rows if row['balance'] is not None]
    return {'platform': 'ca', 'accounts': rows, 'total': sum(available) if available else None,
            'known_accounts': len(available), 'unknown_accounts': len(rows) - len(available),
            'from_cache': value.get('fromCache') is True, 'checked_at': int(time.time())}


def _claim_row(raw: object) -> dict | None:
    if not isinstance(raw, dict) or not str(raw.get('accountId', '')).startswith('codearts-'):
        return None
    outcome = raw.get('outcome') or {}
    if not isinstance(outcome, dict):
        outcome = {}
    kind = outcome.get('kind')
    if kind not in ('claimed', 'already-claimed', 'inactive', 'failed'):
        kind = 'failed'
    return {'account_id': raw['accountId'], 'nickname': _text(raw.get('nickname')), 'kind': kind,
            'credit': _number(outcome.get('credit')), 'message': _text(outcome.get('message'), 350),
            'action_required': outcome.get('actionRequired') is True,
            'covers_today': outcome.get('coversToday') is not False}


def _today() -> str:
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y-%m-%d')


def _latest_account_checkin(account_id: str) -> dict | None:
    value = db.get_setting('codearts_last_checkin', {}) or {}
    if not isinstance(value, dict) or value.get('date') != _today():
        return None
    rows = [r for r in value.get('results', []) if isinstance(r, dict) and r.get('account_id') == account_id]
    if not rows:
        return None
    row = rows[-1]
    return {'kind': row.get('kind'), 'credit': row.get('credit'), 'message': _text(row.get('message'), 350),
            'covers_today': row.get('covers_today') is True, 'at': value.get('checked_at')}


async def checkin() -> dict:
    if not _checkin_lock.acquire(blocking=False):
        raise CodeArtsError('CA 签到正在执行，请稍后查看结果', 409)
    try:
        value = await rpc('credits.claimAll', {'provider': 'codearts'}, timeout=120)
        if not isinstance(value, dict) or not isinstance(value.get('results'), list):
            raise CodeArtsError('CA 签到响应格式异常，请刷新重试')
        rows = [row for raw in value['results'] if (row := _claim_row(raw)) is not None]
        summary = value.get('summary') if isinstance(value.get('summary'), dict) else {}
        result = {'platform': 'ca', 'date': _today(), 'checked_at': int(time.time()), 'results': rows,
                  'summary': {'claimed': _number(summary.get('claimed')),
                              'already_claimed': _number(summary.get('alreadyClaimed')),
                              'inactive': _number(summary.get('inactive')), 'failed': _number(summary.get('failed')),
                              'total_credit': _number(summary.get('totalCredit'))}}
        db.set_setting('codearts_last_checkin', result)
        return result
    finally:
        _checkin_lock.release()


def _auto_checkin(value: object) -> dict:
    raw = value.get('autoCheckin') if isinstance(value, dict) else None
    if not isinstance(raw, dict):
        raise CodeArtsError('CA 自动签到状态响应异常')
    channel = next((row for row in raw.get('channels', []) if isinstance(row, dict)
                    and row.get('provider') == 'codearts'), {})
    return {'platform': 'ca', 'enabled': raw.get('enabled') is True,
            'times': [v for v in raw.get('times', []) if isinstance(v, str) and re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', v)],
            'timezone': 'Asia/Shanghai', 'jitter_minutes': _number(raw.get('jitterMinutes')),
            'next_run_at': _seconds(raw.get('nextRunAt')), 'running': raw.get('running') is True,
            'last_at': _seconds(raw.get('lastAt')) if channel else None,
            'last_result': _text(channel.get('text'), 350),
            'pending': bool(raw.get('pendingSlot')) and bool(channel)}


async def auto_checkin(patch: dict | None = None) -> dict:
    if not patch:
        return _auto_checkin(await rpc('usage.autoCheckin'))
    if not _schedule_lock.acquire(blocking=False):
        raise CodeArtsError('自动签到设置正在保存，请稍后重试', 409)
    try:
        settings = {target: patch[source] for source, target in [('times', 'times'), ('jitter_minutes', 'jitterMinutes')]
                    if source in patch}
        # Upstream explicitly forbids mixing schedule fields and enabled in one RPC.
        if settings:
            value = await rpc('usage.autoCheckin', settings)
        if 'enabled' in patch:
            value = await rpc('usage.autoCheckin', {'enabled': patch['enabled']})
        return _auto_checkin(value)
    finally:
        _schedule_lock.release()


async def catalog(force: bool = False) -> dict:
    now = time.time()
    with _cache_lock:
        if not force and _cache.get('until', 0) > now:
            return {**_cache['payload'], 'cached': True, 'cache_age': int(now - _cache['at'])}
    try:
        upstream = upstreamsvc.resolve_for_key({'platform': 'ca'})
        async with config.http_client(25, connect=3, proxy='', lane='codearts-models') as client:
            response = await client.get(upstream['base_url'] + '/v1/models',
                                        headers={'Authorization': 'Bearer ' + upstreamsvc.forward_api_key(upstream)})
        if response.status_code != 200:
            raise CodeArtsError('CA 模型目录返回 HTTP ' + str(response.status_code))
        data = response.json().get('data')
        if not isinstance(data, list):
            raise CodeArtsError('CA 模型目录格式异常')
        details = await rpc('model.list', {'provider': 'codearts'})
        detail_map = {str(m.get('id')).removeprefix('codearts/'): m
                      for m in (details or {}).get('models', []) if isinstance(m, dict)}
        models = []
        for row in data:
            if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not row['id'].startswith('codearts/'):
                continue
            mid = row['id']
            detail = detail_map.get(mid.removeprefix('codearts/'), {})
            if detail.get('disabled') or detail.get('dead'):
                continue
            reasoning = row.get('reasoning') if isinstance(row.get('reasoning'), dict) else {}
            declared = reasoning.get('efforts') or []
            efforts = reasoning.get('openai_efforts') or [v.get('canonical') or v.get('id') for v in declared if isinstance(v, dict)]
            default = reasoning.get('default') or ''
            default = next((v.get('canonical') or v.get('id') for v in declared
                            if isinstance(v, dict) and v.get('id') == default), default)
            inputs = row.get('input')
            models.append({
                'id': mid, 'platform': 'ca', 'name': detail.get('name') or row.get('name') or mid,
                'context_length': row.get('context_window') or row.get('context_length') or 0,
                'max_output_tokens': row.get('max_output_tokens') or row.get('max_tokens') or 0,
                'description': detail.get('description') or row.get('description') or '',
                'efforts': [str(v) for v in efforts if v], 'default_effort': default,
                'supports_reasoning': bool(efforts),
                'supports_tool_call': row.get('supports_tool_call'),
                'supports_images': 'image' in inputs if isinstance(inputs, list) else None,
                'native_modality': 'multimodal' if isinstance(inputs, list) and 'image' in inputs else 'text' if isinstance(inputs, list) and inputs else 'unknown',
                'native_modality_source': 'CodeArts 官方网关' if isinstance(inputs, list) and inputs else '',
                'credits': row.get('credits') or '', 'vendor': 'Huawei CodeArts',
                'tags': ['free'] if detail.get('isFree') or detail.get('free') else [],
                'series': modelcatalog.series_of(mid.removeprefix('codearts/')),
            })
        errors = [] if models else ['请先添加并启用一个华为云 CodeArts 账号，再刷新模型目录']
        payload = {'models': models, 'platform': 'ca', 'source': 'codearts',
                   'source_label': 'CodeArts 官方网关模型目录', 'via': 'codearts2api',
                   'errors': errors, 'cached': False, 'cache_age': 0}
    except Exception as exc:
        payload = {'models': [], 'platform': 'ca', 'source': 'none', 'source_label': 'CA 模型目录暂不可用',
                   'via': 'codearts2api', 'errors': [safe_error(str(exc))], 'cached': False, 'cache_age': 0}
    payload['summary'] = modelcatalog.summarize(payload['models'])
    with _cache_lock:
        _cache.update(payload=payload, at=now, until=now + (300 if payload['models'] else 15))
    return payload


def fetch_ids_blocking() -> set[str]:
    return {m['id'] for m in asyncio.run(catalog()).get('models', [])}
