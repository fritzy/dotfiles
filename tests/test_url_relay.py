import importlib.machinery
import importlib.util
import io
from pathlib import Path
import socket
import subprocess
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader('relay', str(ROOT / 'worklaptop/.scripts/url-dispatch'))
spec = importlib.util.spec_from_loader(loader.name, loader)
relay = importlib.util.module_from_spec(spec)
loader.exec_module(relay)


class RelayTests(unittest.TestCase):
    def test_callbacks(self):
        self.assertEqual(relay.callback_forwards('https://github.com/login/device'), [])
        self.assertEqual(relay.callback_forwards(
            'https://issuer.test/auth?redirect_uri=http%3A%2F%2Flocalhost%3A45678%2Fcallback'),
            ['127.0.0.1:45678:localhost:45678', '[::1]:45678:localhost:45678'])
        self.assertEqual(relay.callback_forwards('http://127.0.0.1:45678/path'),
                         ['127.0.0.1:45678:127.0.0.1:45678'])
        self.assertEqual(relay.callback_forwards('http://[::1]:45678/path'),
                         ['[::1]:45678:[::1]:45678'])
        self.assertEqual(relay.callback_forwards(
            'https://issuer.test/?redirect_uri=http://private.test:45678/'), [])

    def test_invalid_urls(self):
        for url in ('file:///etc/passwd', 'https://example.com/\nhttps://other.test',
                    'http://localhost/', 'http://localhost:invalid/', 'https:///path'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                relay.callback_forwards(url)

    def make_relay(self):
        server = relay.Relay(socket.socket(socket.AF_UNIX))
        self.addCleanup(server.socket.close)
        return server

    def test_forward_reuse_and_expiry(self):
        server = self.make_relay()
        with patch.object(server, 'refresh_control'), patch.object(relay, 'ssh_forward') as forward:
            server.prepare('http://127.0.0.1:45678/')
            server.prepare('http://127.0.0.1:45678/')
            forward.assert_called_once_with('forward', '127.0.0.1:45678:127.0.0.1:45678')
            server.leases = {key: time.monotonic() - 1 for key in server.leases}
            server.service_actions()
            self.assertEqual(server.leases, {})
            self.assertEqual(forward.call_args.args[0], 'cancel')

    def test_partial_forward_failure_rolls_back(self):
        server = self.make_relay()
        with patch.object(server, 'refresh_control'), patch.object(relay, 'ssh_forward') as forward:
            forward.side_effect = [None, ValueError('port conflict'), None]
            with self.assertRaisesRegex(ValueError, 'port conflict'):
                server.prepare('http://localhost:45678/')
            self.assertEqual(forward.call_args.args[0], 'cancel')
            self.assertEqual(server.leases, {})

    def test_tunnel_restart_forgets_old_leases(self):
        server = self.make_relay()
        server.leases['old'] = 1
        with patch.object(relay.os, 'stat') as stat:
            stat.return_value.st_dev = 1
            stat.return_value.st_ino = 2
            stat.return_value.st_mtime_ns = 3
            server.refresh_control()
        self.assertEqual(server.leases, {})

    def test_acknowledgement_and_browser_failure(self):
        for code, expected in ((0, b'OK\n'), (1, b'ERROR:')):
            server = self.make_relay()
            client, accepted = socket.socketpair()
            with client, accepted, patch.object(relay.subprocess, 'run') as run:
                run.return_value.returncode = code
                thread = threading.Thread(target=relay.Handler, args=(accepted, '', server))
                thread.start()
                client.sendall(b'https://example.com/\n')
                self.assertTrue(client.recv(4096).startswith(expected))
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())

    def test_client_rejects_invalid_urls(self):
        result = subprocess.run([str(ROOT / 'workstation/.scripts/url-open'), 'file:///tmp/test'],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('expected an HTTP(S) URL', result.stderr)

    def test_timeout_does_not_log_oauth_url(self):
        server = self.make_relay()
        client, accepted = socket.socketpair()
        url = 'https://issuer.test/?state=private-value'
        with client, accepted, patch.object(relay.subprocess, 'run') as run, patch.object(relay.sys, 'stderr', new_callable=io.StringIO) as log:
            run.side_effect = subprocess.TimeoutExpired(['xdg-open', url], 10)
            thread = threading.Thread(target=relay.Handler, args=(accepted, '', server))
            thread.start()
            client.sendall((url + '\n').encode())
            response = client.recv(4096)
            thread.join(timeout=2)
            self.assertIn(b'timed out', response)
            self.assertNotIn('private-value', log.getvalue())
            self.assertNotIn(b'private-value', response)


if __name__ == '__main__':
    unittest.main()
