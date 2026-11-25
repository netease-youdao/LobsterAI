#!/usr/bin/env python3
"""Build the bundled common-Chinese WOFF2 subset of Noto Serif SC Medium.

Usage:
    uv run --with fonttools --with brotli python3 scripts/build-home-serif-font.py
    uv run --with fonttools --with brotli python3 scripts/build-home-serif-font.py \
        --source /path/to/NotoSerifSC-Medium.otf --license /path/to/LICENSE

Outputs under src/renderer/assets/fonts/:
    - LobsterHomeSerif-Medium.woff2
    - OFL-NotoSerifSC.txt
    - sources.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / 'src/renderer/assets/fonts'
I18N_PATH = REPO_ROOT / 'src/renderer/services/i18n.ts'

UPSTREAM_COMMIT = 'f8d157532fbfaeda587e826d4cd5b21a49186f7c'
FONT_URL = (
    f'https://raw.githubusercontent.com/notofonts/noto-cjk/{UPSTREAM_COMMIT}/'
    'Serif/SubsetOTF/SC/NotoSerifSC-Medium.otf'
)
FONT_SHA256 = 'e4e9beb5aaeb951e101aa8f122e2a6801ea9e48ac9f9b6bdfeef2436b55bc8ee'
LICENSE_URL = (
    f'https://raw.githubusercontent.com/notofonts/noto-cjk/{UPSTREAM_COMMIT}/'
    'Serif/LICENSE'
)
LICENSE_SHA256 = '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2'

OUTPUT_FONT_NAME = 'LobsterHomeSerif-Medium.woff2'
OUTPUT_LICENSE_NAME = 'OFL-NotoSerifSC.txt'
OUTPUT_SOURCES_NAME = 'sources.json'

# Common conversational / UI Chinese characters that can appear in headlines
# outside GB2312 Level 1.
MODERN_CONVERSATIONAL_CJK = '嗨嗯呗哒啥嘞啰喵咻哇噢咦呃哟嘛吖咧喏喔诶'


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch_verified(url: str, expected_sha256: str, local_path: Path | None) -> bytes:
    if local_path is not None:
        data = local_path.read_bytes()
    else:
        with urllib.request.urlopen(url, timeout=60) as resp:
            data = resp.read()
    actual = sha256_bytes(data)
    if actual != expected_sha256:
        raise ValueError(
            f'SHA-256 mismatch for {local_path or url}: expected {expected_sha256}, got {actual}'
        )
    return data


def collect_target_unicodes() -> set[int]:
    # 1. GB2312 Level 1 (3,755 most common Simplified Chinese characters)
    unicodes: set[int] = set()
    for b1 in range(0xB0, 0xD8):
        for b2 in range(0xA1, 0xFF):
            if b1 == 0xD7 and b2 >= 0xFA:
                continue
            try:
                ch = bytes([b1, b2]).decode('gb2312')
                unicodes.add(ord(ch))
            except UnicodeDecodeError:
                pass

    # 2. All CJK Unified Ideographs currently referenced in renderer i18n
    if I18N_PATH.exists():
        for ch in I18N_PATH.read_text(encoding='utf-8'):
            cp = ord(ch)
            if 0x4E00 <= cp <= 0x9FFF:
                unicodes.add(cp)

    # 3. Extra common conversational characters
    for ch in MODERN_CONVERSATIONAL_CJK:
        unicodes.add(ord(ch))

    # 4. Printable ASCII, common Latin punctuation, General Punctuation,
    #    CJK Symbols & Punctuation, and Fullwidth Forms
    unicodes.update(range(0x0020, 0x007F))
    unicodes.update({0x00A0, 0x00B7, 0x00D7, 0x00F7})
    unicodes.update(range(0x2010, 0x2028))
    unicodes.update(range(0x3000, 0x3020))
    unicodes.update(range(0xFF01, 0xFF5F))
    return unicodes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=None, help='Cached NotoSerifSC-Medium.otf path')
    parser.add_argument('--license', type=Path, default=None, help='Cached Serif/LICENSE path')
    args = parser.parse_args()

    font_bytes = fetch_verified(FONT_URL, FONT_SHA256, args.source)
    license_bytes = fetch_verified(LICENSE_URL, LICENSE_SHA256, args.license)
    license_text = license_bytes.decode('utf-8').strip()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp_otf = OUT_DIR / '.tmp-NotoSerifSC-Medium.otf'
    try:
        tmp_otf.write_bytes(font_bytes)
        font = TTFont(tmp_otf)

        unicodes = collect_target_unicodes()
        options = Options()
        options.flavor = 'woff2'
        options.drop_tables += ['vhea', 'vmtx', 'VORG', 'DSIG']
        options.layout_features = ['kern', 'locl', 'ccmp', 'liga', 'palt', 'halt', 'fwid', 'hwid']
        options.name_IDs = ['*']
        options.name_languages = [0x0409]
        options.desubroutinize = False

        subsetter = Subsetter(options=options)
        subsetter.populate(unicodes=unicodes)
        subsetter.subset(font)

        # Rename the modified subset while preserving Adobe/Google copyright and
        # embedding the complete SIL OFL 1.1 license text in nameID 13.
        name_table = font['name']
        updates = {
            1: 'Lobster Home Serif',
            2: 'Medium',
            3: '2.003;LOBSTER;LobsterHomeSerif-Medium',
            4: 'Lobster Home Serif Medium',
            6: 'LobsterHomeSerif-Medium',
            13: license_text,
            16: 'Lobster Home Serif',
            17: 'Medium',
        }
        for name_id, value in updates.items():
            name_table.setName(value, name_id, 3, 1, 0x0409)

        out_font_path = OUT_DIR / OUTPUT_FONT_NAME
        font.flavor = 'woff2'
        font.save(out_font_path)
        cmap = font.getBestCmap() or {}
        glyph_count = len(font.getGlyphOrder())
        codepoint_count = len(cmap)
    finally:
        tmp_otf.unlink(missing_ok=True)

    out_license_path = OUT_DIR / OUTPUT_LICENSE_NAME
    out_license_path.write_bytes(license_bytes)

    out_font_bytes = out_font_path.read_bytes()
    sources = [
        {
            'file': OUTPUT_FONT_NAME,
            'upstreamFile': 'NotoSerifSC-Medium.otf',
            'url': FONT_URL,
            'upstreamSha256': FONT_SHA256,
            'sha256': sha256_bytes(out_font_bytes),
            'bytes': len(out_font_bytes),
            'glyphCount': glyph_count,
            'codepointCount': codepoint_count,
            'subset': 'GB2312 Level 1 + renderer i18n CJK + modern conversational CJK + ASCII + CJK/General punctuation',
            'generator': 'uv run --with fonttools --with brotli python3 scripts/build-home-serif-font.py',
            'license': 'OFL-1.1',
        },
        {
            'file': OUTPUT_LICENSE_NAME,
            'url': LICENSE_URL,
            'sha256': LICENSE_SHA256,
            'bytes': len(license_bytes),
            'license': 'OFL-1.1',
        },
    ]
    (OUT_DIR / OUTPUT_SOURCES_NAME).write_text(
        json.dumps(sources, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8',
    )

    print(
        f'Generated {out_font_path.relative_to(REPO_ROOT)}: '
        f'{len(out_font_bytes):,} bytes ({glyph_count} glyphs, {codepoint_count} codepoints)'
    )


if __name__ == '__main__':
    main()
