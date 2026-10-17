"""App window tests that need no GTK, display or running host."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('window', ROOT / 'deploy/linux/window.py')
window = importlib.util.module_from_spec(spec)
spec.loader.exec_module(window)


class WindowTests(unittest.TestCase):
    def test_navigation_accepts_only_app_origin_in_window(self):
        self.assertTrue(window.internal_url('http://127.0.0.1:4173/'))
        for uri in ('file:///etc/passwd', 'https://example.org', 'http://127.0.0.1:4173@evil.example', 'http://127.0.0.1:evil/', 'http://localhost:4173/'):
            self.assertFalse(window.internal_url(uri), uri)
        self.assertFalse(window.external_url('javascript:alert(1)'))
        self.assertTrue(window.external_url('https://example.org/login'))

    def test_opens_the_saved_login_link(self):
        with tempfile.TemporaryDirectory() as directory:
            saved = Path(directory) / 'console-url'
            saved.write_text('http://127.0.0.1:4173/#token=abc\n')
            self.assertEqual(window.login_url(saved), 'http://127.0.0.1:4173/#token=abc')

    def test_falls_back_to_the_console_without_a_usable_link(self):
        with tempfile.TemporaryDirectory() as directory:
            saved = Path(directory) / 'console-url'
            self.assertEqual(window.login_url(saved), 'http://127.0.0.1:4173/')
            # A tampered file must not send the signed-in window anywhere else.
            saved.write_text('https://evil.example/#token=abc\n')
            self.assertEqual(window.login_url(saved), 'http://127.0.0.1:4173/')


if __name__ == '__main__':
    unittest.main()
