#!/usr/bin/env python3
"""Build a signed release using the reviewed signing identity and OAuth client."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ('manifest.json', 'service-worker.js', 'sidepanel.js', 'sidepanel.html', 'sidepanel.css')
ASSET = 'google-docs-translator.crx'


def extension_id(public_key):
    return ''.join(chr(97 + int(c, 16)) for c in hashlib.sha256(public_key).hexdigest()[:32])


def release_manifest(source, public_key, expected_id, repository, oauth_client):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid owner/repository')
    if extension_id(public_key) != expected_id:
        raise ValueError('Signing key does not match expected extension ID')
    version = source['version']
    parts = version.split('.')
    if (not re.fullmatch(r'(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,3}', version)
            or any(int(p) > 65535 for p in parts) or not any(int(p) for p in parts)):
        raise ValueError('Invalid Chrome extension version')
    if not re.fullmatch(r'[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com', oauth_client):
        raise ValueError('Supply the Chrome Extension OAuth client for the NEW extension ID')
    manifest = json.loads(json.dumps(source))
    owner, repo = repository.split('/')
    manifest['key'] = base64.b64encode(public_key).decode()
    manifest['oauth2']['client_id'] = oauth_client
    manifest['update_url'] = f'https://{owner.lower()}.github.io/{repo}/updates.xml'
    return manifest


def update_xml(extid, repository, version):
    ns = 'http://www.google.com/update2/response'
    ET.register_namespace('', ns)
    root = ET.Element(f'{{{ns}}}gupdate', protocol='2.0')
    app = ET.SubElement(root, f'{{{ns}}}app', appid=extid)
    ET.SubElement(app, f'{{{ns}}}updatecheck', version=version,
                  codebase=f'https://github.com/{repository}/releases/download/v{version}/{ASSET}')
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--key', required=True)
    parser.add_argument('--chrome', required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--expected-id', required=True)
    parser.add_argument('--oauth-client-id', help='Override the public client ID in release-identity.json')
    parser.add_argument('--output', type=Path, default=ROOT / '.dist')
    args = parser.parse_args()
    public_key = subprocess.check_output(
        ['openssl', 'pkey', '-in', str(Path(args.key).resolve()), '-pubout', '-outform', 'DER'],
        stderr=subprocess.DEVNULL)
    identity = json.loads((ROOT / 'release-identity.json').read_text())
    if args.expected_id != identity['extension_id'] or base64.b64encode(public_key).decode() != identity['public_key']:
        raise ValueError('Signing identity differs from the reviewed release-identity.json')
    manifest = release_manifest(json.loads((ROOT / 'manifest.json').read_text()), public_key,
                                args.expected_id, args.repository, args.oauth_client_id or identity.get('oauth_client_id', ''))
    with tempfile.TemporaryDirectory() as temp:
        stage = Path(temp) / 'extension'
        stage.mkdir()
        for filename in FILES:
            shutil.copy2(ROOT / filename, stage / filename)
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        subprocess.run([str(Path(args.chrome).resolve()), '--headless=new', '--no-sandbox',
                        f'--user-data-dir={temp}/profile', f'--pack-extension={stage}',
                        f'--pack-extension-key={Path(args.key).resolve()}'],
                       check=True, timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        crx = stage.with_suffix('.crx').read_bytes()
        magic, version, size = struct.unpack('<4sII', crx[:12])
        if magic != b'Cr24' or version != 3:
            raise ValueError('Expected a Chrome-signed CRX3')
        with zipfile.ZipFile(io.BytesIO(crx[12 + size:])) as archive:
            if json.loads(archive.read('manifest.json')) != manifest or set(archive.namelist()) != set(FILES):
                raise ValueError('Unexpected package content')
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / ASSET).write_bytes(crx)
    (args.output / 'SHA256SUMS').write_text(hashlib.sha256(crx).hexdigest() + f'  {ASSET}\n')
    (args.output / 'extension-id.txt').write_text(args.expected_id + '\n')
    pages = args.output / 'pages'
    pages.mkdir(exist_ok=True)
    (pages / 'updates.xml').write_bytes(update_xml(args.expected_id, args.repository, manifest['version']))
    (pages / '.nojekyll').touch()
    print(f"Built {ASSET} {manifest['version']}; extension ID {args.expected_id}")


if __name__ == '__main__':
    main()
