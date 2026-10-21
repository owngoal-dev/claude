#!/usr/bin/env python3
"""Check the native entrypoint's installed-path, argv and exit-status contract."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile


root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='claude-entrypoint-') as temporary:
    prefix = Path(temporary) / 'bootstrap with spaces'
    for directory in ['bin', 'usr/bin', 'usr/libexec/claude']:
        (prefix / directory).mkdir(parents=True)
    executable = prefix / 'usr/bin/claude'
    subprocess.run(['cc', '-Wall', '-Wextra', '-Werror', str(root / 'packaging/claude.entrypoint.c'),
                    '-o', str(executable)], check=True)
    shell = prefix / 'bin/sh'
    shell.symlink_to('/bin/sh')
    output = prefix / 'arguments'
    (prefix / 'usr/libexec/claude/launcher.sh').write_text(
        'printf "%s\\0" "$@" > ' + shlex.quote(str(output)) + '\nexit 23\n')
    arguments = ['--version', 'two words', '', '*', '$HOME', 'quote"and\'']
    for path in [executable, prefix / 'alias']:
        if path != executable:
            path.symlink_to(executable)
        result = subprocess.run([str(path), *arguments], capture_output=True)
        assert result.returncode == 23, result.stderr
        assert output.read_bytes().split(b'\0')[:-1] == [os.fsencode(arg) for arg in arguments]
    shell.unlink()
    result = subprocess.run([str(executable)], capture_output=True)
    assert result.returncode == 127 and b'bootstrap shell' in result.stderr
    misplaced = prefix / 'wrong-location'
    executable.rename(misplaced)
    result = subprocess.run([str(misplaced)], capture_output=True)
    assert result.returncode == 127 and b'package location' in result.stderr
print('claude: 4 native entrypoint cases passed (host simulation)')
