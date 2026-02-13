"""
Cross-platform clipboard utilities for handling file data.
Supports copying and pasting audio files to/from system clipboard.
"""
import sys
import os
import subprocess
from typing import Optional, Tuple


def copy_file_to_clipboard(file_path: str) -> Tuple[bool, Optional[str]]:
    """
    Copy a file to the system clipboard.

    Args:
        file_path: Path to the file to copy

    Returns:
        Tuple of (success: bool, error_message: Optional[str])
    """
    if not os.path.isfile(file_path):
        return False, "File does not exist"

    try:
        if sys.platform == "darwin":  # macOS
            return _copy_file_macos(file_path)
        elif sys.platform == "win32":  # Windows
            return _copy_file_windows(file_path)
        else:  # Linux
            return _copy_file_linux(file_path)
    except Exception as e:
        return False, f"Clipboard operation failed: {str(e)}"


def paste_file_from_clipboard(target_dir: str) -> Tuple[bool, Optional[str], Optional[str]]:
    """
    Paste a file from the system clipboard.

    Args:
        target_dir: Directory where the file should be pasted

    Returns:
        Tuple of (success: bool, file_path: Optional[str], error_message: Optional[str])
    """
    try:
        if sys.platform == "darwin":  # macOS
            return _paste_file_macos(target_dir)
        elif sys.platform == "win32":  # Windows
            return _paste_file_windows(target_dir)
        else:  # Linux
            return _paste_file_linux(target_dir)
    except Exception as e:
        return False, None, f"Clipboard operation failed: {str(e)}"


def has_file_in_clipboard() -> bool:
    """
    Check if the system clipboard contains a file.

    Returns:
        True if clipboard contains a file, False otherwise
    """
    try:
        if sys.platform == "darwin":  # macOS
            return _has_file_macos()
        elif sys.platform == "win32":  # Windows
            return _has_file_windows()
        else:  # Linux
            return _has_file_linux()
    except Exception:
        return False


# ============================================================================
# macOS Implementation
# ============================================================================

def _copy_file_macos(file_path: str) -> Tuple[bool, Optional[str]]:
    """Copy file to macOS clipboard using osascript."""
    try:
        # Use AppleScript to copy file to clipboard
        script = f'''
        set theFile to POSIX file "{file_path}"
        tell application "Finder"
            set the clipboard to {{theFile as alias}}
        end tell
        '''

        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            timeout=5
        )

        if result.returncode == 0:
            return True, None
        else:
            return False, f"AppleScript error: {result.stderr}"

    except subprocess.TimeoutExpired:
        return False, "Clipboard operation timed out"
    except Exception as e:
        return False, str(e)


def _paste_file_macos(target_dir: str) -> Tuple[bool, Optional[str], Optional[str]]:
    """Paste file from macOS clipboard."""
    try:
        # Use AppleScript to get file path from clipboard
        script = '''
        try
            set theItems to the clipboard as «class furl»
            set thePath to POSIX path of theItems
            return thePath
        on error
            return ""
        end try
        '''

        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            timeout=5
        )

        if result.returncode == 0 and result.stdout.strip():
            clipboard_path = result.stdout.strip()
            if os.path.isfile(clipboard_path):
                return True, clipboard_path, None
            else:
                return False, None, "Clipboard does not contain a valid file"
        else:
            return False, None, "No file in clipboard"

    except subprocess.TimeoutExpired:
        return False, None, "Clipboard operation timed out"
    except Exception as e:
        return False, None, str(e)


def _has_file_macos() -> bool:
    """Check if macOS clipboard contains a file."""
    try:
        script = '''
        try
            set theItems to the clipboard as «class furl»
            return "true"
        on error
            return "false"
        end try
        '''

        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            timeout=2
        )

        return result.returncode == 0 and result.stdout.strip() == "true"
    except Exception:
        return False


# ============================================================================
# Windows Implementation
# ============================================================================

def _copy_file_windows(file_path: str) -> Tuple[bool, Optional[str]]:
    """Copy file to Windows clipboard."""
    try:
        import win32clipboard
        import win32con

        # Convert path to Windows format
        windows_path = os.path.abspath(file_path)

        # Open clipboard and set file data
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            # CF_HDROP format for file paths
            win32clipboard.SetClipboardData(win32con.CF_HDROP, [windows_path])
            return True, None
        finally:
            win32clipboard.CloseClipboard()

    except ImportError:
        return False, "win32clipboard not available. Install pywin32: pip install pywin32"
    except Exception as e:
        return False, str(e)


def _paste_file_windows(target_dir: str) -> Tuple[bool, Optional[str], Optional[str]]:
    """Paste file from Windows clipboard."""
    try:
        import win32clipboard
        import win32con

        win32clipboard.OpenClipboard()
        try:
            if win32clipboard.IsClipboardFormatAvailable(win32con.CF_HDROP):
                files = win32clipboard.GetClipboardData(win32con.CF_HDROP)
                if files and len(files) > 0:
                    clipboard_path = files[0]
                    if os.path.isfile(clipboard_path):
                        return True, clipboard_path, None
                    else:
                        return False, None, "Clipboard does not contain a valid file"
            return False, None, "No file in clipboard"
        finally:
            win32clipboard.CloseClipboard()

    except ImportError:
        return False, None, "win32clipboard not available. Install pywin32: pip install pywin32"
    except Exception as e:
        return False, None, str(e)


def _has_file_windows() -> bool:
    """Check if Windows clipboard contains a file."""
    try:
        import win32clipboard
        import win32con

        win32clipboard.OpenClipboard()
        try:
            return win32clipboard.IsClipboardFormatAvailable(win32con.CF_HDROP)
        finally:
            win32clipboard.CloseClipboard()
    except Exception:
        return False


# ============================================================================
# Linux Implementation
# ============================================================================

def _copy_file_linux(file_path: str) -> Tuple[bool, Optional[str]]:
    """Copy file to Linux clipboard using xclip."""
    try:
        # Check if xclip is available
        which_result = subprocess.run(['which', 'xclip'], capture_output=True)
        if which_result.returncode != 0:
            return False, "xclip not installed. Install with: sudo apt-get install xclip"

        # Copy file path as text (most compatible)
        # Some file managers can paste from text paths
        file_uri = f"file://{os.path.abspath(file_path)}"

        result = subprocess.run(
            ['xclip', '-selection', 'clipboard', '-t', 'text/uri-list'],
            input=file_uri.encode(),
            capture_output=True,
            timeout=5
        )

        if result.returncode == 0:
            return True, None
        else:
            return False, f"xclip error: {result.stderr.decode()}"

    except subprocess.TimeoutExpired:
        return False, "Clipboard operation timed out"
    except FileNotFoundError:
        return False, "xclip not found. Install with: sudo apt-get install xclip"
    except Exception as e:
        return False, str(e)


def _paste_file_linux(target_dir: str) -> Tuple[bool, Optional[str], Optional[str]]:
    """Paste file from Linux clipboard."""
    try:
        # Check if xclip is available
        which_result = subprocess.run(['which', 'xclip'], capture_output=True)
        if which_result.returncode != 0:
            return False, None, "xclip not installed"

        # Try to get file URI from clipboard
        result = subprocess.run(
            ['xclip', '-selection', 'clipboard', '-t', 'text/uri-list', '-o'],
            capture_output=True,
            text=True,
            timeout=5
        )

        if result.returncode == 0 and result.stdout.strip():
            file_uri = result.stdout.strip()
            # Remove file:// prefix if present
            if file_uri.startswith('file://'):
                clipboard_path = file_uri[7:]
            else:
                clipboard_path = file_uri

            if os.path.isfile(clipboard_path):
                return True, clipboard_path, None
            else:
                return False, None, "Clipboard does not contain a valid file"
        else:
            return False, None, "No file in clipboard"

    except subprocess.TimeoutExpired:
        return False, None, "Clipboard operation timed out"
    except Exception as e:
        return False, None, str(e)


def _has_file_linux() -> bool:
    """Check if Linux clipboard contains a file."""
    try:
        result = subprocess.run(
            ['xclip', '-selection', 'clipboard', '-t', 'text/uri-list', '-o'],
            capture_output=True,
            text=True,
            timeout=2
        )

        if result.returncode == 0 and result.stdout.strip():
            file_uri = result.stdout.strip()
            if file_uri.startswith('file://'):
                path = file_uri[7:]
            else:
                path = file_uri
            return os.path.isfile(path)
        return False
    except Exception:
        return False
