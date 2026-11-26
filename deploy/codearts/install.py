#!/usr/bin/env python3
"""Install pinned official CA runtime, account scopes and Manager connection (Linux/systemd)."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import secrets
import shutil
import socket
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
import uuid

IMAGE = 'zhuweiyou/codearts2api'
INDEX = 'sha256:d677eda1bc5ca5613c4a3fe25a02e5b8852792b2ab1a6786fcd4d0be1567300c'
HERE = Path(__file__).resolve().parent


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            value.update(chunk)
    return 'sha256:' + value.hexdigest()


def command(*args: str, timeout: int = 60) -> str:
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        # Child logs can include an auto-generated official admin key.
        raise RuntimeError('Command failed: ' + args[0] + ' (exit ' + str(result.returncode) + ')')
    return result.stdout.strip()


def target_path(raw: str) -> Path:
    path = Path(raw).resolve()
    if not Path(raw).is_absolute() or path in map(Path, (
        '/', '/opt', '/var', '/var/lib', '/etc', '/usr', '/home', '/root', '/tmp', '/srv')):
        raise ValueError('Use an absolute, dedicated application/data directory')
    if any(c.isspace() or c in '"\\\n\r' for c in str(path)):
        raise ValueError('Installation paths cannot contain whitespace, quotes or backslashes')
    return path


def extract_layer(archive: Path, stage: Path) -> None:
    """Read application/runtime files only, validating links before extraction."""
    with tarfile.open(archive, 'r:gz') as package:
        members = []
        for entry in package.getmembers():
            name = entry.name.removeprefix('./')
            if name != 'usr/local/bin/node' and name != 'app' and not name.startswith('app/'):
                continue
            if PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts:
                raise ValueError('Unsafe CA image member')
            if any(part.startswith('.wh.') for part in PurePosixPath(name).parts):
                raise ValueError('Unsupported application whiteout in pinned CA image')
            if entry.issym():
                link = posixpath.normpath(posixpath.join(posixpath.dirname(name), entry.linkname))
                if link != 'app' and not link.startswith('app/'):
                    raise ValueError('CA application symlink escaped its directory')
            elif entry.islnk():
                if not entry.linkname.startswith('app/') or '..' in PurePosixPath(entry.linkname).parts:
                    raise ValueError('Unsafe CA hardlink')
            elif not (entry.isfile() or entry.isdir()):
                raise ValueError('Unsupported CA image file')
            members.append((entry, name))
        for links in (False, True):
            for entry, name in members:
                if (entry.issym() or entry.islnk()) != links:
                    continue
                destination = stage / ('runtime/bin/node' if name == 'usr/local/bin/node' else name)
                if not destination.resolve().is_relative_to(stage.resolve()):
                    raise ValueError('CA extraction escaped staging directory')
                destination.parent.mkdir(parents=True, exist_ok=True)
                if entry.isdir():
                    destination.mkdir(exist_ok=True)
                elif entry.issym():
                    if not destination.is_symlink():
                        destination.symlink_to(entry.linkname)
                elif entry.islnk():
                    linked = stage / entry.linkname
                    if not linked.resolve().is_relative_to(stage.resolve()):
                        raise ValueError('CA hardlink escaped staging directory')
                    os.link(linked, destination)
                else:
                    with package.extractfile(entry) as source, destination.open('wb') as output:
                        shutil.copyfileobj(source, output)
                    destination.chmod(0o755 if name == 'usr/local/bin/node' else entry.mode & 0o777)


def install_runtime(destination: Path, cache: Path) -> None:
    architecture = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    if architecture is None:
        raise ValueError('Official CA runtime supports Linux amd64/arm64')
    if platform.libc_ver()[0] == 'musl':
        raise ValueError('Use the Docker deployment on musl systems; the official Node runtime requires glibc')
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    with urllib.request.urlopen('https://ghcr.io/token?service=ghcr.io&scope=repository:' + IMAGE + ':pull', timeout=45) as response:
        token = json.load(response)['token']

    def obtain(kind: str, expected: str) -> Path:
        path = cache / expected.replace(':', '-')
        if path.is_file() and digest(path) == expected:
            return path
        request = urllib.request.Request('https://ghcr.io/v2/' + IMAGE + '/' + kind + '/' + expected,
            headers={'Authorization': 'Bearer ' + token,
                     'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json'})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=60) as response, path.with_suffix('.part').open('wb') as output:
                    shutil.copyfileobj(response, output)
                if digest(path.with_suffix('.part')) != expected:
                    raise ValueError('Official CA image checksum mismatch')
                path.with_suffix('.part').replace(path)
                return path
            except (OSError, urllib.error.URLError):
                if attempt == 2:
                    raise RuntimeError('Unable to download pinned official CA image from GHCR') from None
        raise RuntimeError('CA download did not complete')

    index = json.loads(obtain('manifests', INDEX).read_text())
    manifest_digest = next(item['digest'] for item in index['manifests']
                           if item.get('platform') == {'architecture': architecture, 'os': 'linux'})
    manifest = json.loads(obtain('manifests', manifest_digest).read_text())
    stage = destination / ('.install-' + uuid.uuid4().hex)
    stage.mkdir(parents=True, mode=0o755)
    for position, layer in enumerate(manifest['layers'], 1):
        print('CA official runtime: layer %d/%d (%d MB)' % (position, len(manifest['layers']), layer['size'] // 1048576), flush=True)
        extract_layer(obtain('blobs', layer['digest']), stage)
    command(str(stage / 'runtime/bin/node'), '--version')
    command(str(stage / 'runtime/bin/node'), str(HERE / 'patch.mjs'), str(stage / 'app'))
    if not (stage / 'app/dist-server/index.js').is_file():
        raise ValueError('Official CA image is missing its server application')
    # root may have umask 077; the dedicated service user must be able to read
    # immutable runtime files while credential directories remain private.
    destination.chmod(0o755)
    for path in stage.rglob('*'):
        if path.is_symlink():
            continue
        path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
    for name in ('app', 'runtime'):
        if (destination / name).exists():
            raise ValueError('Destination changed during installation; staging preserved')
        (stage / name).rename(destination / name)
    (destination / 'release.json').write_text(json.dumps({'version': '0.1.12', 'image': IMAGE,
                                                        'index': INDEX, 'manifest': manifest_digest}) + '\n')


def secret(path: Path, owner) -> str:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.exists():
        with path.open('x', encoding='utf-8') as output:
            output.write(secrets.token_urlsafe(40) + '\n')
    value = path.read_text().strip()
    if len(value) < 24 or any(c.isspace() for c in value):
        raise ValueError('Existing CA credential file is invalid; it has been preserved')
    path.chmod(0o600)
    os.chown(path, owner.pw_uid, owner.pw_gid)
    return value


def health(base: str, admin: str) -> dict:
    request = urllib.request.Request(base + '/healthz', headers={'Authorization': 'Bearer ' + admin})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def scope_health(base: str, admin: str, gateway: str) -> None:
    path = '/v1/wb-account-scope'
    value = {'v': 1, 'at': int(time.time()), 'path': path, 'accounts': []}
    payload = base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).rstrip(b'=')
    signature = base64.urlsafe_b64encode(hmac.new(admin.encode(), b'wb-ca-scope-v1.' + payload,
                                                hashlib.sha256).digest()).rstrip(b'=')
    request = urllib.request.Request(base + path, headers={
        'Authorization': 'Bearer ' + gateway, 'X-WB-CA-Scope': (payload + b'.' + signature).decode()})
    with urllib.request.urlopen(request, timeout=5) as response:
        if response.headers.get('x-wb-ca-scope') != 'v1' or json.load(response).get('version') != 1:
            raise RuntimeError('CA account scope capability check failed')


@contextmanager
def restore_on_failure(destination: Path, connection: Path, unit: Path):
    backup = destination / ('scope-backup-' + uuid.uuid4().hex)
    backup.mkdir(mode=0o700)
    library = (destination / 'app/node_modules/dsh-providers-hub/lib').resolve()
    if not library.is_relative_to((destination / 'app').resolve()):
        raise ValueError('CA dependency escaped its application directory')
    gateway = destination / 'app/dist-server/modules/gateway'
    paths = [library / 'account-pool.js', library / 'openai-gateway/server.js',
             library / 'wb-account-scope.mjs', library / 'wb-sse-keepalive.mjs',
             gateway / 'gateway.controller.js', gateway / 'wb-proxy-lifecycle.mjs', connection, unit]
    saved = {}
    for index, path in enumerate(paths):
        if path.exists():
            copy = backup / str(index)
            shutil.copy2(path, copy)
            saved[path] = copy
        else:
            saved[path] = None
    (backup / 'paths.json').write_text(json.dumps([
        {'path': str(path), 'backup': str(copy) if copy else None} for path, copy in saved.items()]) + '\n')
    try:
        yield
    except Exception:
        try:
            for path, copy in saved.items():
                if copy is not None:
                    shutil.copy2(copy, path)
                elif path.is_file():
                    path.unlink()
            command('systemctl', 'daemon-reload')
            command('systemctl', 'restart' if saved[unit] else 'stop', 'codearts2api.service')
        except Exception:
            raise RuntimeError('CA update failed and automatic rollback was incomplete; backup: ' + str(backup)) from None
        raise RuntimeError('CA update failed; previous runtime and connection restored. Backup: ' + str(backup)) from None


def main() -> None:
    import pwd

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ca-dir', default='/opt/codearts2api')
    parser.add_argument('--ca-data', default='/var/lib/codearts2api')
    parser.add_argument('--manager-dir', default='/opt/workbuddy-manager')
    parser.add_argument('--manager-data')
    parser.add_argument('--manager-user', default='workbuddy')
    parser.add_argument('--cache', default='/var/cache/workbuddy-codearts')
    parser.add_argument('--no-restart-manager', action='store_true')
    args = parser.parse_args()
    if platform.system() != 'Linux' or os.geteuid() != 0:
        raise ValueError('Run this installer as root on Linux with systemd')
    destination, data, manager = map(target_path, (args.ca_dir, args.ca_data, args.manager_dir))
    manager_data = target_path(args.manager_data or str(manager / 'data'))
    cache = target_path(args.cache)
    if data.is_relative_to(destination) or destination.is_relative_to(data):
        raise ValueError('CA runtime and account data need separate directories')
    if not (manager / 'server/services/codearts_setup.py').is_file():
        raise ValueError('Update the Manager source first: codearts_setup.py is missing')
    manager_owner = pwd.getpwnam(args.manager_user)
    try:
        owner = pwd.getpwnam('codearts')
    except KeyError:
        command('useradd', '--system', '--user-group', '--home-dir', str(data), '--shell', '/usr/sbin/nologin', 'codearts')
        owner = pwd.getpwnam('codearts')
    unit = Path('/etc/systemd/system/codearts2api.service')
    fresh = not (destination / 'app/dist-server/index.js').is_file()
    if fresh:
        if unit.exists() or (data.exists() and any(data.iterdir())):
            raise ValueError('Existing CA state/service needs its original runtime; no data was changed')
        for port in (8092, 8326):
            with socket.socket() as test:
                test.bind(('127.0.0.1', port))
        destination.mkdir(parents=True, exist_ok=True)
        install_runtime(destination, cache)
    else:
        if not unit.exists() or str(destination / 'app/dist-server/index.js') not in unit.read_text():
            raise ValueError('Existing CA unit uses a different runtime; inspect its paths before installing')
    with restore_on_failure(destination, manager_data / 'codearts-connection.json', unit):
        finish_install(args, destination, data, manager_data, owner, manager_owner, unit, fresh)


def finish_install(args, destination, data, manager_data, owner, manager_owner, unit, fresh):
    command(str(destination / 'runtime/bin/node'), str(HERE / 'patch.mjs'), str(destination / 'app'))
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(data, owner.pw_uid, owner.pw_gid)
    gateway_dir = data / 'openai-gateway'
    gateway_dir.mkdir(exist_ok=True, mode=0o700)
    os.chown(gateway_dir, owner.pw_uid, owner.pw_gid)
    admin = secret(data / 'admin-key', owner)
    gateway = secret(gateway_dir / 'api-key', owner)
    if fresh:
        unit.write_text(f'''[Unit]
Description=CodeArts official v0.1.12 with Manager account scopes
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codearts
Group=codearts
WorkingDirectory={destination}/app
Environment=NODE_ENV=production
Environment=CODEARTS2API_HOME={data}
Environment=HOST=127.0.0.1
Environment=PORT=8092
Environment=PROXY_GATEWAY=1
Environment=DSH_OPENAI_GATEWAY_PORT=8326
Environment=CODEARTS2API_ADMIN_AUTH=1
Environment=DSH_JET_HUB_AUTO_OPEN_BROWSER=0
ExecStart={destination}/runtime/bin/node {destination}/app/dist-server/index.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths={data}

[Install]
WantedBy=multi-user.target
''')
    command('systemctl', 'daemon-reload')
    command('systemctl', 'enable', 'codearts2api.service')
    command('systemctl', 'restart', 'codearts2api.service')
    base = 'http://127.0.0.1:8092'
    ready = None
    for _ in range(60):
        try:
            ready = health(base, admin)
            if ready.get('ok') and ready.get('adminAuth'):
                break
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    if not ready or not ready.get('ok') or not ready.get('adminAuth'):
        raise RuntimeError('CA service failed its authenticated health check; inspect journalctl -u codearts2api')
    scope_health(base, admin, gateway)
    manager_data.mkdir(parents=True, exist_ok=True)
    connection = manager_data / 'codearts-connection.json'
    value = json.dumps({'base_url': base, 'admin_key': admin, 'gateway_key': gateway}) + '\n'
    if not connection.exists() or connection.read_text() != value:
        if connection.exists():
            shutil.copy2(connection, connection.with_name(connection.name + '.backup-' + uuid.uuid4().hex))
        temporary = connection.with_suffix('.tmp')
        with temporary.open('w', encoding='utf-8') as output:
            output.write(value)
        temporary.chmod(0o600)
        os.chown(temporary, manager_owner.pw_uid, manager_owner.pw_gid)
        temporary.replace(connection)
    if not args.no_restart_manager:
        command('systemctl', 'restart', 'workbuddy-web.service')
    print(json.dumps({'ok': True, 'version': '0.1.12', 'scope_version': 1,
                      'fresh_install': fresh, 'listen': base, 'manager_connection_written': True}))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, OSError, KeyError) as exc:
        raise SystemExit('CA installation failed: ' + str(exc)) from None
