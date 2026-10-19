import io
import sys
from unittest.mock import Mock

import pytest
from blueprints import config, dialogs, device_monitor, utils


@pytest.mark.parametrize('frozen', [False, True])
def test_linux_ffmpeg(monkeypatch, frozen):
    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(sys, 'frozen', frozen, raising=False)
    monkeypatch.setattr(utils.shutil, 'which', lambda _: '/usr/bin/ffmpeg')
    assert utils.get_ffmpeg_path() == '/usr/bin/ffmpeg'
    monkeypatch.setattr(utils.shutil, 'which', lambda _: None)
    with pytest.raises(FileNotFoundError, match='package manager'):
        utils.get_ffmpeg_path()


@pytest.mark.parametrize('platform,name', [('win32', 'ffmpeg.exe'), ('darwin', 'ffmpeg')])
def test_bundled_ffmpeg_unchanged(monkeypatch, platform, name):
    monkeypatch.setattr(sys, 'platform', platform)
    monkeypatch.setattr(sys, 'frozen', True, raising=False)
    monkeypatch.setattr(sys, '_MEIPASS', '/bundle', raising=False)
    assert utils.get_ffmpeg_path() == '/bundle/bin/' + name


@pytest.mark.parametrize('mode', ['file', 'folder', 'save', 'multi'])
@pytest.mark.parametrize('cancel', [False, True])
def test_linux_dialog(app, monkeypatch, mode, cancel):
    import webview
    window = Mock()
    window.create_file_dialog.return_value = None if cancel else ('/tmp/a b.wav', '/tmp/c.wav')
    monkeypatch.setattr(webview, 'windows', [window])
    monkeypatch.setattr(sys, 'platform', 'linux')
    with app.app_context():
        response = app.make_response(dialogs.run_dialog(mode))
    assert response.status_code == (400 if cancel else 200)
    if not cancel:
        assert response.json == ({'paths': ['/tmp/a b.wav', '/tmp/c.wav']} if mode == 'multi' else {'path': '/tmp/a b.wav'})
    assert window.create_file_dialog.call_args.kwargs['allow_multiple'] == (mode == 'multi')


def test_dialog_without_window(app, monkeypatch):
    import webview
    monkeypatch.setattr(webview, 'windows', [])
    with app.app_context():
        assert app.make_response(dialogs.run_dialog_linux('file')).status_code == 503


@pytest.mark.parametrize('xdg', ['', 'relative', '/absolute'])
def test_xdg(monkeypatch, tmp_path, xdg):
    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.delenv('OP-1Z_SM_CONFIG_DIR')
    monkeypatch.setenv('HOME', str(tmp_path))
    value = str(tmp_path / 'xdg') if xdg == '/absolute' else xdg
    monkeypatch.setenv('XDG_CONFIG_HOME', value)
    expected = tmp_path / ('xdg' if xdg == '/absolute' else '.config') / 'OP-1Z Sample Manager'
    assert config.get_config_dir() == str(expected)
    monkeypatch.setenv('OP-1Z_SM_CONFIG_DIR', str(tmp_path / 'override'))
    assert config.get_config_dir() == str(tmp_path / 'override')


@pytest.mark.parametrize('device,upgrade', [('op1', False), ('opz', False), ('opz', True)])
def test_mount_discovery(monkeypatch, tmp_path, device, upgrade):
    mount = tmp_path / 'Device with spaces'
    mount.mkdir()
    if upgrade:
        (mount / 'how_to_upgrade.txt').touch()
    elif device == 'op1':
        (mount / 'drum').mkdir()
        (mount / 'synth').mkdir()
    else:
        (mount / 'samplepacks' / '1-kick').mkdir(parents=True)
    encoded = str(mount).replace(' ', r'\040')
    lines = f'1 0 8:0 / /missing rw - vfat /dev/fake rw\n2 0 8:1 / {encoded} rw - vfat /dev/fake rw\n'
    monkeypatch.setattr('builtins.open', lambda *a, **k: io.StringIO(lines))
    assert device_monitor.find_device_mount_linux(device) == (str(mount), 'upgrade' if upgrade else 'storage')


def test_mount_errors(monkeypatch):
    def fail(*args, **kwargs):
        raise PermissionError('unavailable')
    monkeypatch.setattr('builtins.open', fail)
    assert device_monitor.find_device_mount_linux('op1') == (None, None)


def test_real_conversion(tmp_path):
    from blueprints.linux_smoke import check_audio
    check_audio(tmp_path)


def test_invalid_and_disappearing_mounts(monkeypatch, tmp_path):
    invalid = tmp_path / 'invalid'
    invalid.mkdir()
    lines = f'broken\n1 0 8:1 / {invalid} rw - vfat /dev/fake rw\n'
    monkeypatch.setattr('builtins.open', lambda *a, **k: io.StringIO(lines))
    assert device_monitor.find_device_mount_linux('opz') == (None, None)
    def gone(*args):
        raise FileNotFoundError('unmounted')
    monkeypatch.setattr(device_monitor, 'validate_device_folder_structure', gone)
    assert device_monitor.find_device_mount_linux('op1') == (None, None)


def test_linux_build_ffmpeg(monkeypatch):
    import build
    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(build.shutil, 'which', lambda _: None)
    assert build.ensure_ffmpeg() is False
    monkeypatch.setattr(build.shutil, 'which', lambda _: '/usr/bin/ffmpeg')
    assert build.ensure_ffmpeg() is True


@pytest.mark.parametrize('original', [None, '/system/libs'])
def test_frozen_system_ffmpeg_library_path(monkeypatch, original):
    import subprocess
    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(sys, 'frozen', True, raising=False)
    monkeypatch.setattr(utils.shutil, 'which', lambda _: '/usr/bin/ffmpeg')
    env = {'LD_LIBRARY_PATH': '/bundle/libs'}
    if original is not None:
        env['LD_LIBRARY_PATH_ORIG'] = original
    run = Mock()
    monkeypatch.setattr(subprocess, 'run', run)
    utils.run_ffmpeg(['-version'], env=env)
    assert run.call_args.kwargs['env'].get('LD_LIBRARY_PATH') == original
    assert env['LD_LIBRARY_PATH'] == '/bundle/libs'
