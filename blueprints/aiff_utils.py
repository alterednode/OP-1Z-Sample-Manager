"""
AIFF APPL chunk read/write utility for OP-1/OP-Z sample metadata.

OP-1 and OP-Z AIFF files embed JSON metadata in an APPL chunk with an 'op-1' marker.
This module provides functions to read, write, and validate that metadata.
"""

import json
import os
import struct


def read_appl_metadata(filepath):
    """
    Read OP-1/OP-Z metadata from the APPL chunk of an AIFF file.

    Args:
        filepath: Path to the AIFF file.

    Returns:
        Parsed dict of metadata, or None if no APPL/op-1 chunk found.
    """
    with open(filepath, 'rb') as f:
        data = f.read()

    if len(data) < 12:
        return None

    # Verify FORM/AIFF or FORM/AIFC header
    if data[:4] != b'FORM' or data[8:12] not in (b'AIFF', b'AIFC'):
        return None

    # Walk chunks starting after the 12-byte FORM header
    offset = 12
    while offset + 8 <= len(data):
        chunk_id = data[offset:offset + 4]
        chunk_size = struct.unpack('>I', data[offset + 4:offset + 8])[0]
        chunk_data_start = offset + 8
        chunk_data_end = chunk_data_start + chunk_size

        if chunk_id == b'APPL' and chunk_size >= 4:
            marker = data[chunk_data_start:chunk_data_start + 4]
            if marker == b'op-1':
                # Find JSON via brace-counting
                json_start = data.find(b'{', chunk_data_start + 4)
                if json_start == -1 or json_start >= chunk_data_end:
                    offset = chunk_data_end + (chunk_size % 2)  # pad to even
                    continue

                brace_count = 0
                json_end = json_start
                for i in range(json_start, min(chunk_data_end, len(data))):
                    if data[i:i + 1] == b'{':
                        brace_count += 1
                    elif data[i:i + 1] == b'}':
                        brace_count -= 1
                        if brace_count == 0:
                            json_end = i + 1
                            break

                json_str = data[json_start:json_end].decode('utf-8', errors='ignore')
                return json.loads(json_str)

        # Advance to next chunk (chunks are padded to even byte boundaries)
        offset = chunk_data_end + (chunk_size % 2)

    return None


def write_appl_metadata(filepath, metadata):
    """
    Write OP-1/OP-Z metadata back into the APPL chunk of an AIFF file.

    Replaces the existing APPL/op-1 chunk with updated JSON metadata.

    Args:
        filepath: Path to the AIFF file.
        metadata: Dict of metadata to serialize as JSON.
    """
    with open(filepath, 'rb') as f:
        data = f.read()

    if len(data) < 12 or data[:4] != b'FORM' or data[8:12] not in (b'AIFF', b'AIFC'):
        raise ValueError("Not a valid AIFF file")

    # Find the APPL/op-1 chunk
    offset = 12
    appl_start = None
    appl_end = None

    while offset + 8 <= len(data):
        chunk_id = data[offset:offset + 4]
        chunk_size = struct.unpack('>I', data[offset + 4:offset + 8])[0]
        chunk_data_start = offset + 8
        chunk_data_end = chunk_data_start + chunk_size
        # Total chunk bytes including pad
        chunk_total_end = chunk_data_end + (chunk_size % 2)

        if chunk_id == b'APPL' and chunk_size >= 4:
            marker = data[chunk_data_start:chunk_data_start + 4]
            if marker == b'op-1':
                appl_start = offset
                appl_end = chunk_total_end
                break

        offset = chunk_total_end

    if appl_start is None:
        raise ValueError("No APPL/op-1 chunk found in file")

    # Build new APPL chunk
    json_bytes = json.dumps(metadata, separators=(',', ':')).encode('utf-8')
    appl_payload = b'op-1' + json_bytes
    appl_chunk_size = len(appl_payload)
    new_appl = b'APPL' + struct.pack('>I', appl_chunk_size) + appl_payload
    # Pad to even boundary if needed
    if appl_chunk_size % 2 != 0:
        new_appl += b'\x00'

    # Reconstruct file
    new_data = data[:appl_start] + new_appl + data[appl_end:]

    # Update FORM header size (bytes 4-7, big-endian, = total file size - 8)
    form_size = len(new_data) - 8
    new_data = new_data[:4] + struct.pack('>I', form_size) + new_data[8:]

    with open(filepath, 'wb') as f:
        f.write(new_data)


def validate_aiff_file(filepath):
    """
    Validate that a file is a valid AIFF with OP-1/OP-Z metadata.

    Args:
        filepath: Path to the file to validate.

    Returns:
        Tuple of (is_valid: bool, message: str).
    """
    if not os.path.exists(filepath):
        return False, "File does not exist"

    try:
        with open(filepath, 'rb') as f:
            header = f.read(12)
    except Exception as e:
        return False, f"Cannot read file: {e}"

    if len(header) < 12:
        return False, "File too small to be AIFF"

    if header[:4] != b'FORM':
        return False, "Not a FORM file"

    if header[8:12] not in (b'AIFF', b'AIFC'):
        return False, "Not an AIFF file"

    try:
        metadata = read_appl_metadata(filepath)
    except Exception as e:
        return False, f"Error reading metadata: {e}"

    if metadata is None:
        return False, "No OP-1/OP-Z metadata found in file"

    return True, "Valid"
