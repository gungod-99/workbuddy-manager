"""WB/CodeArts platform boundary shared by keys, catalogs and all gateway protocols."""
from __future__ import annotations

from .. import config, db

SUPPORTED = ('wb', 'ca')
CA_PREFIX = 'codearts/'


def normalize(value: object) -> str:
    text = str(value or 'wb').strip().lower()
    if text not in SUPPORTED:
        raise ValueError('平台只能选择 WB 或 CA')
    return text


def key_platform(key: dict | None) -> str:
    # Missing platform is the compatible shape of existing WB keys.
    return normalize((key or {}).get('platform'))


def model_platform(model: object) -> str:
    return 'ca' if isinstance(model, str) and model.strip().startswith(CA_PREFIX) else 'wb'


def upstream_platform(upstream: dict | None) -> str:
    return normalize((upstream or {}).get('platform'))


def codearts_connection() -> tuple[str, str]:
    value = db.get_setting('codearts_connection', {}) or {}
    if not isinstance(value, dict):
        raise ValueError('CA 上游配置异常')
    base = str(value.get('base_url') or '').rstrip('/')
    admin_key = str(value.get('admin_key') or '')
    if base != config.CODEARTS_BASE or not admin_key:
        raise ValueError('CA 上游尚未配置或已停用')
    return base, admin_key


def codearts_upstream_id() -> int:
    value = db.get_setting('codearts_connection', {}) or {}
    try:
        uid = int(value.get('upstream_id') or 0)
    except (AttributeError, TypeError, ValueError):
        uid = 0
    if uid <= 0:
        raise ValueError('CA 上游尚未配置')
    return uid


def key_upstream(platform: object, upstream_id: object) -> int | None:
    from .. import upstreamsvc
    selected = normalize(platform)
    uid = None if upstream_id in (None, '', 0, '0') else int(upstream_id)
    if selected == 'ca' and uid is None:
        uid = codearts_upstream_id()
    upstream = upstreamsvc.default_upstream() if uid is None else upstreamsvc.get_upstream(uid)
    if upstream is None or not upstream.get('enabled'):
        raise ValueError('选定平台的上游不存在或已停用')
    if upstream_platform(upstream) != selected:
        raise ValueError('密钥平台与所选上游不一致，请重新选择 WB／CA')
    return uid


def check_model(key: dict, requested: object, mapped: object) -> str | None:
    selected = key_platform(key)
    effective = mapped or requested
    if not isinstance(effective, str) or not effective.strip():
        return 'CA 请求必须指定 codearts/ 前缀的模型名' if selected == 'ca' else None
    if model_platform(effective) != selected or model_platform(requested) != selected:
        return '该密钥仅限 ' + selected.upper() + ' 平台；CA 模型使用 codearts/ 前缀，WB 模型使用原有名称'
    if selected == 'wb' and ('/' in effective or ':' in effective
                              and not effective.lower().startswith(('cn:', 'global:'))):
        return 'WB 密钥不能调用其他平台的模型'
    if selected == 'ca' and not effective[len(CA_PREFIX):].strip():
        return 'CA 请求必须指定 codearts/ 后面的模型名'
    return None
