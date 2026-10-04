#!/usr/bin/env python3
"""Reject a debug APK before it can be distributed as a production build."""
import re
import sys
from pathlib import Path

manifest = Path(sys.argv[1]).read_text()
assert 'E: application' in manifest, 'Missing compiled application manifest'
for line in manifest.splitlines():
    if 'android:debuggable' in line or 'android:testOnly' in line:
        assert re.search(r'\(type 0x12\)0x0(?:\s|$)', line), f'Unsafe release manifest: {line.strip()}'
assert 'org.glowstr.meshbridge.debug' not in manifest, 'Developer package in production build'
print('Production manifest: non-debuggable, non-test package PASS')
