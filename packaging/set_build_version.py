"""Write a parseable application version without changing artifact labels."""
import os
from pathlib import Path
import re
from packaging.version import Version


def application_version(label, is_tag):
    if is_tag:
        return str(Version(label))
    local = re.sub(r'[^a-z0-9]+', '.', label.lower()).strip('.') or 'build'
    return str(Version('0.0.0.dev0+' + local))


if __name__ == '__main__':
    value = application_version(os.environ['VERSION_LABEL'], os.environ.get('GITHUB_REF_TYPE') == 'tag')
    Path('blueprints/github_version_file.py').write_text(f'VERSION = {value!r}\n')
