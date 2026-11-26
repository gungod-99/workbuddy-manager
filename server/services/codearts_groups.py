"""CA account membership and per-key scopes; a missing group never means the full pool."""
from __future__ import annotations

import base64
import functools
import hashlib
import hmac
import json
import sqlite3
import time

from .. import config, db

SCOPE_HEADER = 'X-WB-CA-Scope'
SCOPE_PATH = '/v1/wb-account-scope'


def locked(function):
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        with db._lock:
            return function(*args, **kwargs)
    return wrapped


def require_group(group_id: object) -> int:
    if isinstance(group_id, bool) or not isinstance(group_id, int) or group_id <= 0:
        raise ValueError('请选择有效的 CA 账号分组')
    if not db.query_one('SELECT id FROM codearts_groups WHERE id = ?', (group_id,)):
        raise ValueError('CA 账号分组不存在，请刷新后重试')
    return group_id


def validate_key(platform: str, group_id: object) -> int | None:
    if group_id is None:
        return None
    if platform != 'ca':
        raise ValueError('华为云账号分组只能绑定 CA 密钥')
    return require_group(group_id)


def list_groups() -> list[dict]:
    return [dict(row) for row in db.query('''
        SELECT g.*,
          (SELECT COUNT(*) FROM codearts_account_groups a WHERE a.group_id = g.id) AS account_count,
          (SELECT COUNT(*) FROM api_keys k WHERE k.ca_group_id = g.id) AS key_count
        FROM codearts_groups g ORDER BY g.id
    ''')]


@locked
def save_group(name: str, group_id: int | None = None) -> dict:
    name = name.strip()
    if not name or len(name) > 64:
        raise ValueError('分组名称须为 1–64 个字符')
    try:
        if group_id is None:
            group_id = db.execute('INSERT INTO codearts_groups(name, created_at) VALUES(?, ?)',
                                  (name, int(time.time())))
        else:
            require_group(group_id)
            db.execute('UPDATE codearts_groups SET name = ? WHERE id = ?', (name, group_id))
    except sqlite3.IntegrityError as exc:
        raise ValueError('已存在同名 CA 分组') from exc
    return next(group for group in list_groups() if group['id'] == group_id)


@locked
def delete_group(group_id: int) -> None:
    require_group(group_id)
    if db.query_one('SELECT 1 FROM api_keys WHERE ca_group_id = ? LIMIT 1', (group_id,)):
        raise ValueError('该分组仍绑定密钥，请先修改或删除这些密钥')
    if db.query_one('SELECT 1 FROM codearts_account_groups WHERE group_id = ? LIMIT 1', (group_id,)):
        raise ValueError('该分组仍有账号，请先移动账号')
    db.execute('DELETE FROM codearts_groups WHERE id = ?', (group_id,))


def memberships() -> dict[str, int]:
    return {row['account_id']: row['group_id'] for row in db.query('SELECT * FROM codearts_account_groups')}


@locked
def prune_missing(snapshot: dict[str, int], present: set[str]) -> None:
    # Only remove memberships observed before the RPC, so a concurrent login's
    # new account cannot be mistaken for a deleted one by an older list result.
    conn = db.connect()
    with conn:
        for account_id, group_id in snapshot.items():
            if account_id not in present:
                conn.execute('DELETE FROM codearts_account_groups WHERE account_id = ? AND group_id = ?',
                             (account_id, group_id))


@locked
def assign(account_ids: list[str], group_id: int | None) -> None:
    if group_id is not None:
        require_group(group_id)
    conn = db.connect()
    try:
        for account_id in dict.fromkeys(account_ids):
            if group_id is None:
                conn.execute('DELETE FROM codearts_account_groups WHERE account_id = ?', (account_id,))
            else:
                conn.execute('INSERT INTO codearts_account_groups(account_id, group_id) VALUES(?, ?) '
                             'ON CONFLICT(account_id) DO UPDATE SET group_id = excluded.group_id',
                             (account_id, group_id))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def scope_token(account_ids: list[str], admin_key: str, path: str, *, now: int | None = None) -> str:
    payload = {'v': 1, 'at': int(time.time()) if now is None else now,
               'path': path, 'accounts': sorted(set(account_ids))}
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(',', ':')).encode()).rstrip(b'=')
    signature = hmac.new(admin_key.encode(), b'wb-ca-scope-v1.' + encoded, hashlib.sha256).digest()
    return (encoded + b'.' + base64.urlsafe_b64encode(signature).rstrip(b'=')).decode()


async def routing_headers(key: dict, upstream: dict, path: str) -> dict:
    from . import codearts, platforms

    group_id = key.get('ca_group_id')
    if group_id is None:
        return {}
    try:
        require_group(group_id)
        base, admin = platforms.codearts_connection()
    except ValueError as exc:
        raise codearts.CodeArtsError(str(exc), 503) from exc
    if upstream.get('base_url', '').rstrip('/') != base:
        raise codearts.CodeArtsError('CA 分组密钥必须使用已配置的 CA 管理上游', 503)
    members = {row['account_id'] for row in db.query(
        'SELECT account_id FROM codearts_account_groups WHERE group_id = ?', (group_id,))}
    accounts = await codearts.accounts()
    allowed = [a['id'] for a in accounts if a['id'] in members and a['enabled']
               and a['credential_status'] == 'available']
    if not allowed:
        raise codearts.CodeArtsError('该 CA 分组没有可用账号，请检查分组内的账号与授权状态', 503)
    if len(allowed) > 200:
        raise codearts.CodeArtsError('单个 CA 分组最多支持 200 个可用账号，请拆分分组', 503)
    headers = {'Authorization': 'Bearer ' + str(upstream.get('api_key') or ''),
               SCOPE_HEADER: scope_token(allowed, admin, SCOPE_PATH)}
    # Official builds ignore unknown headers. Prove the signed contract before sending inference.
    try:
        async with config.http_client(10, connect=3, proxy='', lane='codearts-scope') as client:
            response = await client.get(base + SCOPE_PATH, headers=headers)
        if (response.status_code != 200 or response.headers.get('x-wb-ca-scope') != 'v1'
                or response.json().get('version') != 1):
            raise ValueError('scope unavailable')
    except Exception as exc:
        raise codearts.CodeArtsError('CA 分组组件未就绪，请运行 deploy/codearts/install.py 完成安装', 503) from exc
    return {SCOPE_HEADER: scope_token(allowed, admin, path)}
