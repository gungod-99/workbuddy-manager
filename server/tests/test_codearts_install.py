"""Deployment failures preserve prior files and refuse unsafe image members."""
import importlib.util
import io
from pathlib import Path
import tarfile

import pytest

spec = importlib.util.spec_from_file_location('ca_installer', Path(__file__).resolve().parents[2] / 'deploy/codearts/install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


@pytest.mark.parametrize('name,link', [('app/../../escape', ''), ('app/link', '../../escape'),
                                       ('app/.wh.application', ''), ('app/link', '/etc/passwd')])
def test_image_paths_cannot_escape_extraction(tmp_path, name, link):
    archive = tmp_path / 'layer.tar.gz'
    with tarfile.open(archive, 'w:gz') as package:
        entry = tarfile.TarInfo(name)
        if link:
            entry.type = tarfile.SYMTYPE
            entry.linkname = link
        else:
            entry.size = 4
        package.addfile(entry, None if link else io.BytesIO(b'data'))
    stage = tmp_path / 'stage'
    stage.mkdir()
    with pytest.raises(ValueError):
        installer.extract_layer(archive, stage)
    assert not (tmp_path / 'escape').exists()


def test_activation_failure_restores_code_connection_and_unit(tmp_path, monkeypatch):
    destination = tmp_path / 'runtime'
    library = destination / 'app/node_modules/dsh-providers-hub/lib'
    (library / 'openai-gateway').mkdir(parents=True)
    connection, unit = tmp_path / 'connection.json', tmp_path / 'ca.service'
    paths = [library / 'account-pool.js', library / 'openai-gateway/server.js', connection, unit]
    for path in paths:
        path.write_text('before-' + path.name)
    commands = []
    monkeypatch.setattr(installer, 'command', lambda *args, **kw: commands.append(args))
    with pytest.raises(RuntimeError, match='previous runtime and connection restored'):
        with installer.restore_on_failure(destination, connection, unit):
            for path in paths:
                path.write_text('changed')
            (library / 'wb-account-scope.mjs').write_text('new helper')
            raise RuntimeError('failed activation')
    for path in paths:
        assert path.read_text() == 'before-' + path.name
    assert not (library / 'wb-account-scope.mjs').exists()
    assert ('systemctl', 'restart', 'codearts2api.service') in commands


def test_compose_connects_private_ca_and_waits_for_readiness():
    import yaml
    root = Path(__file__).resolve().parents[2]
    compose = yaml.safe_load((root / 'docker-compose.yml').read_text(encoding='utf-8'))
    manager, ca = compose['services']['workbuddy-manager'], compose['services']['codearts2api']
    assert manager['depends_on']['codearts2api']['condition'] == 'service_healthy'
    assert manager['environment']['WB_CODEARTS_BASE'] == ca['environment']['WB_CA_MANAGER_BASE']
    assert 'codearts-connection:/run/codearts-connection:ro' in manager['volumes']
    assert 'ports' not in ca
    assert ca['build']['dockerfile'] == 'deploy/codearts/Dockerfile'
    dockerfile = (root / ca['build']['dockerfile']).read_text()
    assert installer.INDEX in dockerfile
