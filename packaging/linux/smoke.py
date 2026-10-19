#!/usr/bin/env python3
"""Run a desktop command with disposable settings and a bounded lifetime."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix='op1z-smoke-') as directory:
    root = Path(directory)
    env = os.environ.copy()
    env.pop('PYTHONPATH', None)
    env.pop('VIRTUAL_ENV', None)
    env['PYTHONNOUSERSITE'] = '1'
    env['XDG_CACHE_HOME'] = str(root / 'cache')
    env['XDG_DATA_HOME'] = str(root / 'data')
    env['OP-1Z_SM_CONFIG_DIR'] = str(root / 'config')
    env['OP-1Z_SM_WORKING_DIR'] = str(root / 'work')
    env['XDG_CONFIG_HOME'] = str(root / 'xdg')
    try:
        completed = subprocess.run(sys.argv[1:] + ['--smoke-test'], env=env, cwd=root, timeout=75)
        raise SystemExit(completed.returncode)
    except subprocess.TimeoutExpired:
        raise SystemExit('Desktop smoke test timed out')
