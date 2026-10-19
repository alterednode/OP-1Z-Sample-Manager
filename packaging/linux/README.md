# Linux development and test builds

The first supported backend is GTK3 / WebKitGTK 4.1 on x86_64. Application
changes live in the shared Python code. This directory contains Linux build
support; it is not a separate packaging branch. Flatpak, RPM, and AppImage are
not implemented and Linux test archives are not published as releases.

## Fedora source environment

Install system dependencies (once):

```sh
sudo dnf install python3 python3-pip python3-gobject python3-cairo gtk3 webkit2gtk4.1 libsndfile ffmpeg
python3 -m venv --system-site-packages .venv
.venv/bin/python -m pip install -r packaging/linux/requirements.txt -r requirements-dev.txt
PYTHONNOUSERSITE=1 .venv/bin/python main.py
```

Use the distribution Python so its GI bindings are visible. A pre-existing
isolated environment without system packages cannot import those bindings.
Do not replace an existing environment; choose a new directory if needed.
FFmpeg must be on PATH, including for frozen builds. No Linux FFmpeg executable
is bundled. Fedora codec/package availability depends on enabled repositories.

If WebKit cannot initialize graphics in a restricted desktop environment, retry
with `LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1`. These are test
workarounds, not application defaults. No WebKit sandbox disabling is required.

## Build and verify locally

```sh
PYTHONNOUSERSITE=1 .venv/bin/python -m pytest -q
python3 packaging/linux/smoke.py "$PWD/.venv/bin/python" "$PWD/main.py"
PYTHONNOUSERSITE=1 .venv/bin/python build.py
mkdir -p artifacts
tar -czf artifacts/op-1z-sample-manager-linux-x86_64.tar.gz -C dist 'OP-1Z Sample Manager'
```

Extract the archive into a temporary directory outside the repository and run:

```sh
python3 packaging/linux/smoke.py '/absolute/extracted/OP-1Z Sample Manager/OP-1Z Sample Manager'
```

The smoke wrapper uses disposable config/work directories, clears PYTHONPATH
and VIRTUAL_ENV, runs from outside the checkout, and enforces a 75-second timeout.
The executable's `--smoke-test` requires directory overrides. It loads the GTK
window, checks page DOM and styles with JavaScript, converts generated stereo
48 kHz audio to mono 44.1 kHz 16-bit AIFF, verifies the result, exercises real GTK selection/cancellation for all four dialog routes, then closes.
For a headless session prefix the wrapper command with `xvfb-run -a`.

## GitHub Actions

Linux development runs on pushes to `linux-support` and manual dispatch. PRs
also require the Linux job in the PR gate. The reusable build uses Ubuntu 24.04
and distribution Python 3.12, system GTK/WebKit, and Xvfb. It tests source,
builds a folder executable, creates a tar archive, extracts it elsewhere, and
smoke-tests the extracted executable with the system PATH. Logs and checksums
are uploaded alongside the test archive. Existing macOS/Windows release jobs
remain separate; Linux archives are not release assets.

These archives depend on the build distribution's native library baseline;
they are not guaranteed portable to every Linux distribution. Test the exact
GHA archive on Fedora before marking this milestone complete.

## Fedora acceptance checklist

Record commit, runner, Python version, archive SHA-256, and outcome for each run.
Use `OP-1Z_SM_CONFIG_DIR` and `OP-1Z_SM_WORKING_DIR` with disposable directories.

- Source and frozen GTK window loads on KDE Wayland and closes cleanly.
- File, multiple-file, folder, and save dialogs select paths with spaces; each cancels cleanly.
- Convert audio and play the result; verify settings persist after reopening.
- Download the GHA archive and repeat the same checks (not just a local build).
- Require Linux, Windows and macOS build checks and the Python test job to pass.
- No real device is currently available. Mount fixtures validate OP-1/OP-Z
  structures and OP-Z upgrade mode. USB hotplug and device writes remain unverified.

Configuration precedence is the existing OP-1Z_SM_CONFIG_DIR override, then an
absolute XDG_CONFIG_HOME, then ~/.config, retaining the existing application
subdirectory. Relative XDG values are ignored. Existing settings are never moved.
