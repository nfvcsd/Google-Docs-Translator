import base64
import importlib.util
import json
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build', ROOT / 'scripts/build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.source = json.loads((ROOT / 'manifest.json').read_text())
        self.identity = json.loads((ROOT / 'release-identity.json').read_text())
        self.public = base64.b64decode(self.identity['public_key'])

    def manifest(self, **changes):
        args = dict(source=self.source, public_key=self.public,
                    expected_id=self.identity['extension_id'], repository='nfvcsd/Google-Docs-Translator',
                    oauth_client='123-test.apps.googleusercontent.com')
        args.update(changes)
        return build.release_manifest(**args)

    def test_identity_and_source_isolation(self):
        before = json.dumps(self.source)
        result = self.manifest()
        self.assertEqual(build.extension_id(self.public), self.identity['extension_id'])
        self.assertEqual(json.dumps(self.source), before)
        self.assertEqual(result['key'], self.identity['public_key'])
        self.assertEqual(result['update_url'], 'https://nfvcsd.github.io/Google-Docs-Translator/updates.xml')

    def test_wrong_key_is_rejected(self):
        with self.assertRaises(ValueError):
            self.manifest(public_key=b'wrong key')

    def test_missing_oauth_is_rejected(self):
        for client in ['', 'REPLACE_WITH_CLIENT.apps.googleusercontent.com']:
            with self.subTest(client=client), self.assertRaises(ValueError):
                self.manifest(oauth_client=client)

    def test_invalid_versions_rejected(self):
        for version in ['0', '01.2', '1.65536', '1.2.3.4.5', '1.2-beta']:
            with self.subTest(version=version), self.assertRaises(ValueError):
                self.manifest(source={**self.source, 'version': version})

    def test_feed_matches_versioned_release(self):
        root = ET.fromstring(build.update_xml(self.identity['extension_id'], 'nfvcsd/Google-Docs-Translator', '1.1.3'))
        app = root[0]
        self.assertEqual(app.attrib['appid'], self.identity['extension_id'])
        self.assertEqual(app[0].attrib['version'], '1.1.3')
        self.assertEqual(app[0].attrib['codebase'], 'https://github.com/nfvcsd/Google-Docs-Translator/releases/download/v1.1.3/google-docs-translator.crx')


if __name__ == '__main__':
    unittest.main()
