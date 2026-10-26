#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("migration", Path(__file__).with_name("migrate-keychain-credentials.py"))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "api-credentials.json"

    def test_migration_is_owner_only_and_does_not_repeat_reads(self):
        self.assertEqual(migration.migrate(self.path, lambda service, account: f"test-{account}"), 3)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(migration.migrate(self.path, lambda *_: self.fail("read repeated")), 0)
        self.assertEqual(json.loads(self.path.read_text())["apiKey"], "test-model-api-key")

    def test_existing_and_intentionally_cleared_keys_are_preserved(self):
        self.path.write_text(json.dumps({"apiKey": "existing", "mimoTtsApiKey": None}))
        calls = []
        def read(service, account):
            calls.append((service, account))
            return "embedding-test"
        self.assertEqual(migration.migrate(self.path, read), 1)
        self.assertEqual(calls, [("piko-knowledge-embeddings", "api-key")])
        saved = json.loads(self.path.read_text())
        self.assertEqual(saved["apiKey"], "existing")
        self.assertIsNone(saved["mimoTtsApiKey"])

    def test_denied_access_does_not_partially_overwrite_destination(self):
        self.path.write_text('{"apiKey":"existing"}')
        def read(service, account):
            if account == "api-key":
                raise RuntimeError("denied")
            return "speech-test"
        with self.assertRaises(RuntimeError):
            migration.migrate(self.path, read)
        self.assertEqual(self.path.read_text(), '{"apiKey":"existing"}')

    def test_corruption_is_not_overwritten_or_included_in_error(self):
        self.path.write_text("private-invalid-content")
        with self.assertRaises(RuntimeError) as error:
            migration.migrate(self.path, lambda *_: self.fail("should not read"))
        self.assertNotIn("private-invalid-content", str(error.exception))
        self.assertEqual(self.path.read_text(), "private-invalid-content")

    def test_missing_old_keys_are_recorded_without_repeated_lookup(self):
        self.assertEqual(migration.migrate(self.path, lambda *_: None), 0)
        self.assertEqual(migration.migrate(self.path, lambda *_: self.fail("read repeated")), 0)
        self.assertTrue(all(value is None for value in json.loads(self.path.read_text()).values()))


if __name__ == "__main__":
    unittest.main()
