import sys
import subprocess
from flask import Blueprint, jsonify, current_app

# Create Blueprint for dialog routes
dialog_bp = Blueprint('dialog', __name__)


def run_dialog_macos(mode):
    """Use native macOS dialogs via osascript."""
    if mode == "folder":
        script = 'POSIX path of (choose folder with prompt "Select a folder")'
    elif mode == "file":
        script = 'POSIX path of (choose file with prompt "Select a file")'
    elif mode == "multi":
        script = '''
set selectedFiles to choose file with prompt "Select files" with multiple selections allowed
set output to ""
repeat with f in selectedFiles
    set output to output & POSIX path of f & linefeed
end repeat
return output
'''
    elif mode == "save":
        script = 'POSIX path of (choose file name with prompt "Save as")'
    else:
        return jsonify({"error": f"Unknown mode: {mode}"}), 400

    try:
        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            timeout=60
        )

        if result.returncode != 0:
            # User cancelled the dialog
            return jsonify({"error": "No selection made"}), 400

        output = result.stdout.strip()

        if mode == "multi":
            paths = [line.strip() for line in output.splitlines() if line.strip()]
            current_app.logger.debug("Got multiple paths: %s", paths)
            if paths:
                return jsonify({"paths": paths})
            else:
                return jsonify({"error": "No files selected"}), 400

        # Single path case (file, folder, save)
        if output:
            current_app.logger.debug("Got path of: %s from user.", output)
            return jsonify({"path": output})
        else:
            return jsonify({"error": "No selection made"}), 400

    except subprocess.TimeoutExpired:
        return jsonify({"error": "Dialog timed out"}), 408
    except Exception as e:
        current_app.logger.error("Exception in run_dialog_macos: %s", e, exc_info=True)
        return jsonify({"error": "An internal error has occurred."}), 500


def run_dialog_windows(mode):
    """Use tkinter for Windows file dialogs."""
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()  # Hide the root window
    root.attributes('-topmost', True)  # Bring dialog to front

    try:
        if mode == "folder":
            path = filedialog.askdirectory(title="Select a folder")
        elif mode == "file":
            path = filedialog.askopenfilename(title="Select a file")
        elif mode == "multi":
            paths = filedialog.askopenfilenames(title="Select files")
            root.destroy()
            if paths:
                return jsonify({"paths": list(paths)})
            return jsonify({"error": "No files selected"}), 400
        elif mode == "save":
            path = filedialog.asksaveasfilename(title="Save as")
        else:
            root.destroy()
            return jsonify({"error": f"Unknown mode: {mode}"}), 400

        root.destroy()
        if path:
            return jsonify({"path": path})
        return jsonify({"error": "No selection made"}), 400
    except Exception as e:
        root.destroy()
        raise e


def run_dialog_linux(mode):
    """Let pywebview dispatch native dialogs onto the GTK event loop."""
    import webview

    modes = {"file": webview.FileDialog.OPEN, "multi": webview.FileDialog.OPEN,
             "folder": webview.FileDialog.FOLDER, "save": webview.FileDialog.SAVE}
    if mode not in modes:
        return jsonify({"error": f"Unknown mode: {mode}"}), 400
    if not webview.windows:
        return jsonify({"error": "File dialogs require the desktop application window"}), 503
    paths = webview.windows[0].create_file_dialog(modes[mode], allow_multiple=mode == "multi")
    if not paths:
        message = "No files selected" if mode == "multi" else "No selection made"
        return jsonify({"error": message}), 400
    if isinstance(paths, str):
        paths = [paths]
    return jsonify({"paths": list(paths)} if mode == "multi" else {"path": paths[0]})


def run_dialog(mode):
    """Run a file/folder selection dialog."""
    try:
        if sys.platform == 'darwin':
            return run_dialog_macos(mode)
        elif sys.platform == 'win32':
            return run_dialog_windows(mode)
        elif sys.platform.startswith('linux'):
            return run_dialog_linux(mode)
        else:
            return jsonify({"error": "File dialogs not supported on this platform"}), 501
    except Exception as e:
        current_app.logger.error("Exception in run_dialog: %s", e, exc_info=True)
        return jsonify({"error": "An internal error has occurred."}), 500

# Flask routes to run dialogs for file/folder selection

@dialog_bp.route("/get-user-file-path")
def get_user_file():
    current_app.logger.info("Getting file path from user")
    return run_dialog("file")

@dialog_bp.route("/get-user-folder-path")
def get_user_folder():
    current_app.logger.info("Getting Folder Path from user")
    return run_dialog("folder")

@dialog_bp.route("/get-save-location-path")
def get_save_location():
    current_app.logger.info("Get save location path - redundant?")
    return run_dialog("save")

@dialog_bp.route("/get-user-multiple-file-paths")
def get_user_multiple_files():
    current_app.logger.info("Getting multiple file paths from user")
    return run_dialog("multi")
