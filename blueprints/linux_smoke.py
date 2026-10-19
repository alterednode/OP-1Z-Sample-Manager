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
        result['ok'] = True
        print(json.dumps({'smoke': 'passed', 'page': True, 'javascript': True, 'conversion': True}), flush=True)
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        window.destroy()
