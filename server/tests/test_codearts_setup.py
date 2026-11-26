"""The installer credential file connects CA without resetting existing keys or switches."""
import json

import pytest

from server import config, db, keysvc, upstreamsvc
from server.services import codearts_setup
from server.tests.test_codearts_platform import context, create


def test_connection_setup_is_idempotent_and_preserves_existing_configuration(context, monkeypatch):
    c = context['client']
    key = create(c, 'ca')
    uid = context['ca']['id']
    upstreamsvc.update_upstream(uid, {'enabled': False})
    path = config.DATA_DIR / 'codearts-connection.json'
    data = {'base_url': config.CODEARTS_BASE, 'admin_key': 'private-admin-sentinel-' * 2,
            'gateway_key': 'private-gateway-sentinel-' * 2}
    path.write_text(json.dumps(data))
    assert codearts_setup.configure_from_file() is True
    assert codearts_setup.configure_from_file() is True
    assert len(upstreamsvc.list_upstreams(include_default=False)) == 2
    upstream = upstreamsvc.get_upstream(uid)
    assert upstream['api_key'] == data['gateway_key'] and not upstream['enabled']
    assert db.get_setting('codearts_connection')['admin_key'] == data['admin_key']
    assert keysvc.resolve(key['key'])['upstream_id'] == uid
    assert keysvc.reveal_key(key['id'])['key'] == key['key']


def test_connection_setup_creates_missing_ca_upstream(context):
    db.set_setting('codearts_connection', {})
    path = config.DATA_DIR / 'codearts-connection.json'
    path.write_text(json.dumps({'base_url': config.CODEARTS_BASE, 'admin_key': 'a' * 40, 'gateway_key': 'g' * 40}))
    assert codearts_setup.configure_from_file() is True
    row = upstreamsvc.get_upstream(db.get_setting('codearts_connection')['upstream_id'])
    assert row['platform'] == 'ca' and row['base_url'] == config.CODEARTS_BASE


@pytest.mark.parametrize('value', [[], {'base_url': 'http://outside:8092'},
                                  {'base_url': 'http://127.0.0.1:8092', 'admin_key': 'short', 'gateway_key': 'g' * 40},
                                  {'base_url': 'http://127.0.0.1:8092', 'admin_key': 'a' * 40, 'gateway_key': 'secret with spaces' * 3}])
def test_invalid_connection_does_not_alter_existing_configuration(context, value):
    before = db.get_setting('codearts_connection')
    (config.DATA_DIR / 'codearts-connection.json').write_text(json.dumps(value))
    with pytest.raises(ValueError):
        codearts_setup.configure_from_file()
    assert db.get_setting('codearts_connection') == before


def test_optional_missing_file_and_explicit_missing_file(context, monkeypatch):
    monkeypatch.delenv('WB_CODEARTS_CONNECTION_FILE', raising=False)
    assert codearts_setup.configure_from_file() is False
    monkeypatch.setenv('WB_CODEARTS_CONNECTION_FILE', str(config.DATA_DIR / 'missing.json'))
    with pytest.raises(ValueError):
        codearts_setup.configure_from_file()
