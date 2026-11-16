import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from examples import download_dataset
from validator.datasets import write_datasets


class DownloadExampleTests(unittest.TestCase):
    def test_reads_and_verifies_all_shards(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            posts = [{'kind': 'job', 'path': f'indexed/{i:04}', 'title': 'Engineer', 'origin': 'indexed', 'source_url': 'https://example.com'} for i in range(1002)]
            manifest = write_datasets(root, root / 'data', {'generated': '2026-11-15T00:00:00Z', 'source': 'https://github.com/softprobe/openjob', 'posts': posts})
            def read(url):
                return (root / 'data' / ('manifest.json' if url == 'manifest' else url.rsplit('/', 1)[-1])).read_bytes()
            output = io.StringIO()
            with patch.object(download_dataset, 'read', side_effect=read), patch.object(sys, 'argv', ['download_dataset.py', 'jobs', '--manifest', 'manifest']), contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                download_dataset.main()
            self.assertEqual(len([json.loads(line) for line in output.getvalue().splitlines()]), manifest['datasets']['jobs']['count'])
