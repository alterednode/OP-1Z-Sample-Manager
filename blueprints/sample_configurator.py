"""
Sample Configurator blueprint.

Provides routes to load, save, and undo edits to OP-1/OP-Z AIFF sample metadata.
"""

import os
import shutil
import subprocess
import tempfile
import uuid

from flask import Blueprint, request, jsonify, current_app, send_file

from blueprints.aiff_utils import read_appl_metadata, write_appl_metadata, validate_aiff_file
from blueprints.devices import OP_1, OP_Z
from blueprints.utils import run_ffmpeg

sample_configurator_bp = Blueprint('sample_configurator', __name__)

# Module-level state (desktop app, single user)
_loaded_files = {}  # file_id -> {"path": str, "is_temp": bool}
_undo_backups = {}  # file_id -> backup file path

BACKUP_DIR = os.path.join(tempfile.gettempdir(), "op1z_sm_configurator_backups")


def _ensure_backup_dir():
    os.makedirs(BACKUP_DIR, exist_ok=True)


@sample_configurator_bp.route('/sampleconfigurator/types')
def get_types():
    """Return FX and LFO type options for each device."""
    def format_types(device):
        return {
            "fx_types": [{"name": n, "value": v} for n, v in device.fx_types],
            "lfo_types": [{"name": n, "value": v} for n, v in device.lfo_types],
        }
    return jsonify({
        "op1": format_types(OP_1),
        "opz": format_types(OP_Z),
    })


@sample_configurator_bp.route('/sampleconfigurator/load', methods=['POST'])
def load_file():
    """Load metadata from a file path (native file dialog)."""
    data = request.get_json()
    if not data or 'path' not in data:
        return jsonify({"error": "No path provided"}), 400

    filepath = data['path']

    is_valid, message = validate_aiff_file(filepath)
    if not is_valid:
        return jsonify({"error": message}), 400

    metadata = read_appl_metadata(filepath)
    if metadata is None:
        return jsonify({"error": "Could not read metadata"}), 400

    file_id = str(uuid.uuid4())
    _loaded_files[file_id] = {"path": filepath, "is_temp": False}

    # Clear any previous undo backup for this file
    _undo_backups.pop(file_id, None)

    return jsonify({
        "file_id": file_id,
        "filename": os.path.basename(filepath),
        "metadata": metadata
    })


@sample_configurator_bp.route('/sampleconfigurator/upload', methods=['POST'])
def upload_file():
    """Accept a file via drag-and-drop upload, save to temp, read metadata."""
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "Empty filename"}), 400

    # Save to temp location
    _ensure_backup_dir()
    ext = os.path.splitext(file.filename)[1] or '.aif'
    temp_path = os.path.join(BACKUP_DIR, f"upload_{uuid.uuid4()}{ext}")
    file.save(temp_path)

    is_valid, message = validate_aiff_file(temp_path)
    if not is_valid:
        os.remove(temp_path)
        return jsonify({"error": message}), 400

    metadata = read_appl_metadata(temp_path)
    if metadata is None:
        os.remove(temp_path)
        return jsonify({"error": "Could not read metadata"}), 400

    file_id = str(uuid.uuid4())
    _loaded_files[file_id] = {"path": temp_path, "is_temp": True}

    return jsonify({
        "file_id": file_id,
        "filename": file.filename,
        "metadata": metadata,
        "is_temp": True
    })


@sample_configurator_bp.route('/sampleconfigurator/save', methods=['POST'])
def save_file():
    """Save updated metadata back to the AIFF file."""
    data = request.get_json()
    if not data or 'file_id' not in data or 'metadata' not in data:
        return jsonify({"error": "Missing file_id or metadata"}), 400

    file_id = data['file_id']
    metadata = data['metadata']

    if file_id not in _loaded_files:
        return jsonify({"error": "File not loaded"}), 404

    file_info = _loaded_files[file_id]
    filepath = file_info['path']

    if file_info['is_temp']:
        # For temp files (drag-and-drop uploads), need a save-as dialog
        # The frontend should call /get-save-location-path first and provide save_path
        save_path = data.get('save_path')
        if not save_path:
            return jsonify({"error": "save_path required for uploaded files"}), 400
        # Copy temp file to save location first
        shutil.copy2(filepath, save_path)
        filepath = save_path
        # Update the loaded file reference to the saved location
        file_info['path'] = save_path
        file_info['is_temp'] = False

    # Create backup for undo
    _ensure_backup_dir()
    backup_path = os.path.join(BACKUP_DIR, f"backup_{file_id}{os.path.splitext(filepath)[1]}")
    shutil.copy2(filepath, backup_path)
    _undo_backups[file_id] = backup_path

    try:
        write_appl_metadata(filepath, metadata)
    except Exception as e:
        current_app.logger.error(f"Error saving metadata: {e}")
        # Restore from backup on failure
        shutil.copy2(backup_path, filepath)
        _undo_backups.pop(file_id, None)
        return jsonify({"error": f"Save failed: {e}"}), 500

    return jsonify({
        "status": "saved",
        "can_undo": True
    })


@sample_configurator_bp.route('/sampleconfigurator/undo', methods=['POST'])
def undo_save():
    """Restore the file from backup and return the original metadata."""
    data = request.get_json()
    if not data or 'file_id' not in data:
        return jsonify({"error": "Missing file_id"}), 400

    file_id = data['file_id']

    if file_id not in _loaded_files:
        return jsonify({"error": "File not loaded"}), 404

    if file_id not in _undo_backups:
        return jsonify({"error": "No backup available"}), 400

    file_info = _loaded_files[file_id]
    filepath = file_info['path']
    backup_path = _undo_backups[file_id]

    # Restore backup
    shutil.copy2(backup_path, filepath)

    # Remove the backup (single undo only)
    os.remove(backup_path)
    del _undo_backups[file_id]

    # Re-read metadata
    metadata = read_appl_metadata(filepath)

    return jsonify({
        "status": "restored",
        "metadata": metadata,
        "can_undo": False
    })


@sample_configurator_bp.route('/sampleconfigurator/audio/<file_id>')
def get_audio(file_id):
    """Serve the loaded AIFF file's audio as WAV for browser playback via FFmpeg."""
    if file_id not in _loaded_files:
        return jsonify({"error": "File not loaded"}), 404

    filepath = _loaded_files[file_id]['path']

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            temp_path = tmp.name

        result = run_ffmpeg([
            "-y",
            "-i", filepath,
            "-acodec", "pcm_s16le",
            "-ar", "44100",
            temp_path
        ], capture_output=True, timeout=10)

        if result.returncode != 0:
            current_app.logger.error(f"FFmpeg conversion failed: {result.stderr.decode()}")
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)
            return jsonify({"error": "Audio conversion failed"}), 500

        response = send_file(
            temp_path,
            mimetype="audio/wav",
            as_attachment=False
        )

        @response.call_on_close
        def cleanup():
            try:
                if temp_path and os.path.exists(temp_path):
                    os.remove(temp_path)
            except Exception:
                pass

        return response

    except subprocess.TimeoutExpired:
        current_app.logger.error("FFmpeg conversion timed out")
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({"error": "Audio conversion timed out"}), 500
    except Exception as e:
        current_app.logger.error(f"Error converting audio: {e}")
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({"error": "Failed to convert audio"}), 500
