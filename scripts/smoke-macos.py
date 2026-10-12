#!/usr/bin/env python3
"""Smoke a newly downloaded copy; never run an installed Claude or real login.

The OS sandbox denies network, keychain IPC, other executables, and reads outside
the temporary tree and system libraries. Failure is not a reason to relax it.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def smoke(source):
    root = Path(__file__).resolve().parent.parent
    expected = root / 'build/upstream/package/claude'
    if source.resolve() != expected.resolve() or source.is_symlink():
        sys.exit('Only the repository download may be used; installed binaries are refused')
    before = sha256(source)
    with tempfile.TemporaryDirectory(prefix='claude-isolated-smoke-') as temporary:
        work = Path(temporary).resolve()
        binary = work / 'claude'
        shutil.copyfile(source, binary)
        binary.chmod(0o700)
        subprocess.run(['node', str(root / 'scripts/patch-binary.mjs'), str(binary),
                        '15.0', '--macos-smoke'], check=True)
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(binary)], check=True)
        for directory in ['home', 'tmp', 'credentials', 'bin']:
            (work / directory).mkdir(mode=0o700)
        # No caller environment, PATH programs, login, or home files are inherited.
        env = {'HOME': str(work / 'home'), 'TMPDIR': str(work / 'tmp'),
               'CLAUDE_CONFIG_DIR': str(work / 'home/.claude'),
               'CLAUDE_SECURESTORAGE_CONFIG_DIR': str(work / 'credentials'),
               'PATH': str(work / 'bin'), 'USER': 'fixture', 'LOGNAME': 'fixture',
               'DISABLE_AUTOUPDATER': '1', 'BUN_JSC_useJIT': 'false', 'TERM': 'dumb'}
        profile = f'''(version 1)
(deny default)
(allow process-exec (literal {json.dumps(str(binary))}))
(allow process-fork)
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (subpath "/System") (subpath "/usr/lib")
 (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
 (subpath {json.dumps(str(work))}))
(allow file-write* (subpath {json.dumps(str(work))}) (literal "/dev/null"))
'''
        for arguments in [['--version'], ['--help']]:
            result = subprocess.run(['/usr/bin/sandbox-exec', '-p', profile,
                                     str(binary), *arguments], env=env, cwd=work,
                                    capture_output=True, text=True, timeout=45)
            if result.returncode != 0:
                sys.exit(f'Isolated smoke failed ({result.returncode}); sandbox remains unchanged: '
                         + result.stderr[:1200])
            if not result.stdout.strip():
                sys.exit('Smoke produced no output')
            print('sandboxed macOS copy:', ' '.join(arguments), 'passed')
    if sha256(source) != before:
        sys.exit('Download changed during smoke')
    print('Upstream download unchanged; no installed binary or login used')


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.platform != 'darwin':
        sys.exit('usage (macOS only): smoke-macos.py build/upstream/package/claude')
    smoke(Path(sys.argv[1]))
