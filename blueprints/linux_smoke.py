"""Opt-in desktop smoke check shared by source and frozen builds."""
import json
import math
import os
from pathlib import Path
import struct
import tempfile
import time
import wave


def check_audio(directory):
    import soundfile
    from .sample_converter import convert_audio_file

    source = Path(directory) / 'input.wav'
    target = Path(directory) / 'output.aif'
    with wave.open(str(source), 'wb') as audio:
        audio.setparams((2, 2, 48000, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<hh', value, value) for value in
                         (int(10000 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(4800))))
    convert_audio_file(str(source), str(target), 'drum', auto_pitch=False)
    info = soundfile.info(target)
    assert (info.format, info.samplerate, info.channels, info.subtype) == ('AIFF', 44100, 1, 'PCM_16'), info
    assert abs(info.duration - 0.1) < 0.01, info


def check_dialogs(url, directory):
    """Exercise real GTK dialogs through HTTP, including GUI-thread dispatch."""
    import urllib.error
    import urllib.request
    from gi.repository import GLib, Gtk

    root = Path(directory) / 'dialogs'
    root.mkdir()
    files = [root / 'first sample.wav', root / 'second sample.wav']
    for path in files:
        path.touch()
    routes = {'file': '/get-user-file-path', 'multi': '/get-user-multiple-file-paths',
              'folder': '/get-user-folder-path', 'save': '/get-save-location-path'}
    for mode, route in routes.items():
        for cancel in (False, True):
            state = {'ticks': 0, 'dialog': None}

            def respond():
                state['ticks'] += 1
                candidates = [w for w in Gtk.Window.list_toplevels()
                              if isinstance(w, Gtk.FileChooserDialog) and w.get_visible()]
                if not candidates:
                    return state['ticks'] < 100
                dialog = candidates[0]
                if cancel:
                    dialog.response(Gtk.ResponseType.CANCEL)
                    return False
                if state['dialog'] is None:
                    state['dialog'] = dialog
                    dialog.set_current_folder(str(root))
                    if mode == 'save':
                        dialog.set_current_name('saved sample.wav')
                    state['ticks'] = 0
                    return True
                if state['ticks'] == 5 and mode in ('file', 'multi'):
                    dialog.select_filename(str(files[0]))
                    if mode == 'multi':
                        dialog.select_all()
                if state['ticks'] < 10:
                    return True
                dialog.response(Gtk.ResponseType.OK)
                return False

            GLib.timeout_add(100, respond)
            try:
                with urllib.request.urlopen(url + route, timeout=15) as response:
                    payload = json.load(response)
                assert not cancel, (mode, payload)
                if mode == 'multi':
                    assert set(payload['paths']) == set(map(str, files)), payload
                else:
                    expected = root if mode == 'folder' else root / 'saved sample.wav' if mode == 'save' else files[0]
                    assert payload['path'] == str(expected), payload
            except urllib.error.HTTPError as error:
                assert cancel and error.code == 400, (mode, error.read())


def run(window, url, result):
    """Called on pywebview's worker thread, never on the GUI thread."""
    try:
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if window.get_current_url() == url + '/':
                state = window.evaluate_js("({ready: document.readyState, text: document.body.innerText, assets: [...document.styleSheets].length})")
                if state and state['ready'] == 'complete' and state['text'].strip() and state['assets']:
                    break
            time.sleep(0.2)
        else:
            raise RuntimeError('Application page did not load in GTK within 45 seconds')
        with tempfile.TemporaryDirectory() as directory:
            check_audio(directory)
            check_dialogs(url, directory)
            # Decode/play silently: do not make noise on the user's desktop.
            import base64
            encoded = base64.b64encode((Path(directory) / 'input.wav').read_bytes()).decode()
            window.evaluate_js("""window.smokeAudio = new Audio();
                window.smokeAudio.muted = true;
                window.smokeAudioResult = 'pending';
                window.smokeAudio.onended = () => window.smokeAudioResult = 'ended';
                window.smokeAudio.onerror = () => window.smokeAudioResult = 'error';
                window.smokeAudio.src = 'data:audio/wav;base64,""" + encoded + """';
                window.smokeAudio.play().catch(e => window.smokeAudioResult = String(e));""")
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                playback = window.evaluate_js('window.smokeAudioResult')
                if playback != 'pending':
                    break
                time.sleep(0.1)
            assert playback == 'ended', playback
        from .config import get_config_setting, set_config_setting
        if os.environ.get('OP1Z_SMOKE_EXPECT_RESTART') == '1':
            assert get_config_setting('LINUX_SMOKE_PERSISTENCE') == 'saved'
        set_config_setting('LINUX_SMOKE_PERSISTENCE', 'saved')
        result['ok'] = True
        print(json.dumps({'smoke': 'passed', 'page': True, 'javascript': True, 'conversion': True, 'dialogs': True, 'silent_playback': True, 'settings': True}), flush=True)
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        window.destroy()
