"""Initialize the private CA connection from the installer/container's credential file."""
from __future__ import annotations

import json
import os
from pathlib import Path

from .. import config, db, upstreamsvc


def configure_from_file() -> bool:
    path = Path(os.environ.get('WB_CODEARTS_CONNECTION_FILE') or config.DATA_DIR / 'codearts-connection.json')
    if not path.is_file():
        if os.environ.get('WB_CODEARTS_CONNECTION_FILE'):
            raise ValueError('CA 连接文件不存在，请先启动 codearts2api 服务')
        return False
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise ValueError('无法读取 CA 连接文件，请检查文件与权限') from exc
    if not isinstance(value, dict) or value.get('base_url') != config.CODEARTS_BASE:
        raise ValueError('CA 连接地址与 WB_CODEARTS_BASE 不一致')
    for field in ('admin_key', 'gateway_key'):
        key = value.get(field)
        if not isinstance(key, str) or not 24 <= len(key) <= 512 or any(c.isspace() for c in key):
            raise ValueError('CA 连接文件缺少有效的管理密钥或网关密钥')
    with db._lock:
        previous = db.get_setting('codearts_connection', {}) or {}
        uid = previous.get('upstream_id') if isinstance(previous, dict) else None
        upstream = upstreamsvc.get_upstream(uid) if uid else None
        if upstream and upstream.get('platform') != 'ca':
            raise ValueError('CA 连接引用了 WB 上游，请检查配置')
        if upstream:
            if upstream['base_url'] != value['base_url'] or upstream['api_key'] != value['gateway_key']:
                upstreamsvc.update_upstream(upstream['id'], {'base_url': value['base_url'],
                                                             'api_key': value['gateway_key']})
        else:
            upstream = upstreamsvc.create_upstream('Huawei CodeArts', value['base_url'],
                                                   value['gateway_key'], platform='ca')
        current = {'base_url': value['base_url'], 'admin_key': value['admin_key'], 'upstream_id': upstream['id']}
        if current != previous:
            db.set_setting('codearts_connection', current)
    return True
