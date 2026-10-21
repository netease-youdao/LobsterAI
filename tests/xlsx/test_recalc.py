"""Unit regression tests for Windows recalculation; no Office process is started."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('xlsx_recalc', ROOT / 'SKILLs/xlsx/recalc.py')
recalc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recalc)


class WindowsRecalculationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name) / 'project.xlsx'
        self.source.write_bytes(b'original workbook')

    @patch.object(recalc.shutil, 'which', return_value='soffice.com')
    @patch.object(recalc.subprocess, 'Popen')
    def test_timeout_preserves_original_and_stops_only_its_process_tree(self, popen, _which):
        process = popen.return_value
        process.pid = 12345
        process.communicate.side_effect = [subprocess.TimeoutExpired('soffice', 2), (b'', b'')]
        with patch.object(recalc.subprocess, 'run') as run:
            result = recalc.recalc_windows(self.source, 2)
        self.assertIn('timed out', result['error'])
        self.assertEqual(self.source.read_bytes(), b'original workbook')
        self.assertEqual(run.call_args.args[0], ['taskkill', '/PID', '12345', '/T', '/F'])
        self.assertEqual(process.communicate.call_args_list[0].kwargs['timeout'], 2)
        process.kill.assert_called_once()

    def test_unsupported_format_is_not_converted_or_overwritten(self):
        source = self.source.with_suffix('.xlsm')
        source.write_bytes(b'keep macros')
        with patch.object(recalc.subprocess, 'Popen') as popen:
            self.assertIn('.xlsx only', recalc.recalc_windows(source, 30)['error'])
        popen.assert_not_called()
        self.assertEqual(source.read_bytes(), b'keep macros')

    def convert(self, *, mutate_source=False, invalid=False):
        def start(command, **_kwargs):
            self.assertIn('--headless', command)
            self.assertTrue(any(arg.startswith('-env:UserInstallation=file:') for arg in command))
            self.assertNotIn('RecalculateAndSave', ' '.join(command))
            output = Path(command[command.index('--outdir') + 1]) / self.source.name
            output.write_bytes(b'calculated workbook')
            if mutate_source:
                self.source.write_bytes(b'user changed the workbook while conversion ran')
            process = Mock(returncode=0)
            process.communicate.return_value = (b'converted', b'')
            return process
        with patch.object(recalc.shutil, 'which', return_value='soffice.com'), \
             patch.object(recalc.subprocess, 'Popen', side_effect=start), \
             patch.object(recalc, 'load_workbook', side_effect=ValueError('corrupt output') if invalid else None):
            return recalc.recalc_windows(self.source, 30)

    def test_success_validates_and_replaces_the_workbook(self):
        self.assertIsNone(self.convert())
        self.assertEqual(self.source.read_bytes(), b'calculated workbook')
        self.assertEqual(list(Path(self.directory.name).iterdir()), [self.source])

    def test_concurrent_user_edit_is_preserved(self):
        self.assertIn('changed during', self.convert(mutate_source=True)['error'])
        self.assertEqual(self.source.read_bytes(), b'user changed the workbook while conversion ran')

    def test_invalid_converted_workbook_never_replaces_source(self):
        with self.assertRaisesRegex(ValueError, 'corrupt output'):
            self.convert(invalid=True)
        self.assertEqual(self.source.read_bytes(), b'original workbook')


if __name__ == '__main__':
    unittest.main()
