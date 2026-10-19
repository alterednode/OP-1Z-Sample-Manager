#!/usr/bin/env python3
"""Run desktop smoke checks on a private display with disposable settings."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

with tempfile.TemporaryDirectory(prefix='op1z-smoke-') as directory:
    root = Path(directory)
    env = os.environ.copy()
    for name in ('PYTHONPATH', 'VIRTUAL_ENV', 'WAYLAND_DISPLAY'):
        env.pop(name, None)
    env.update({
        'PYTHONNOUSERSITE': '1', 'GSETTINGS_BACKEND': 'memory',
        'GDK_BACKEND': 'x11', 'LIBGL_ALWAYS_SOFTWARE': '1',
        'WEBKIT_DISABLE_DMABUF_RENDERER': '1',
        'OP-1Z_SM_CONFIG_DIR': str(root / 'config'),
        'OP-1Z_SM_WORKING_DIR': str(root / 'work'),
        'XDG_CONFIG_HOME': str(root / 'xdg'),
        'XDG_CACHE_HOME': str(root / 'cache'),
        'XDG_DATA_HOME': str(root / 'data'),
    })
    xvfb = os.environ.get('OP1Z_XVFB') or shutil.which('Xvfb')
    if not xvfb:
        raise SystemExit('Install Xvfb to run isolated GUI smoke tests; the user desktop is never used.')
    with (root / 'display').open('w+b') as display_file:
        display = subprocess.Popen([xvfb, '-displayfd', str(display_file.fileno()),
                                    '-screen', '0', '1280x800x24', '-nolisten', 'tcp'],
                                   pass_fds=(display_file.fileno(),))
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                display_file.seek(0)
                number = display_file.read().decode().strip()
                if number:
                    break
                if display.poll() is not None:
                    raise SystemExit('Xvfb exited before initializing')
                time.sleep(0.1)
            else:
                raise SystemExit('Xvfb failed to initialize')
            env['DISPLAY'] = ':' + number
            completed = subprocess.run(sys.argv[1:] + ['--smoke-test'], env=env, cwd=root, timeout=75)
            raise SystemExit(completed.returncode)
        except subprocess.TimeoutExpired:
            raise SystemExit('Desktop smoke test timed out')
        finally:
            display.terminate()
            try:
                display.wait(timeout=5)
            except subprocess.TimeoutExpired:
                display.kill()
                display.wait()
