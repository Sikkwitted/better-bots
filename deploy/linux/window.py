#!/usr/bin/python3 -I
"""The Better Bots app window: the console in its own window, already signed in.

The host keeps running as a service when the window closes, so bots keep working.
"""
from pathlib import Path
import urllib.error
import urllib.request
from urllib.parse import urlsplit

APP_URL = 'http://127.0.0.1:4173'
# Written by the installer for the person who installed it; it holds the console token.
LOGIN_FILE = Path.home() / '.config/better-bots/console-url'
ICON = '/opt/better-bots/icon.png'
STARTING = ('<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;display:grid;'
            'place-items:center;height:90vh;color:#555">Starting Better Bots…</body>')


def internal_url(uri):
    try:
        url = urlsplit(uri)
        return url.scheme == 'http' and url.hostname == '127.0.0.1' and url.port == 4173 and not url.username and not url.password
    except ValueError:
        return False


def external_url(uri):
    try:
        url = urlsplit(uri)
        return url.scheme in ('http', 'https') and bool(url.hostname) and not url.username and not url.password
    except ValueError:
        return False


def login_url(path=LOGIN_FILE):
    """The saved login link, or the plain console address if there is none."""
    try:
        saved = path.read_text().strip()
    except OSError:
        return APP_URL + '/'
    return saved if internal_url(saved) else APP_URL + '/'


def host_answers():
    try:
        with urllib.request.urlopen(APP_URL + '/healthz', timeout=2):
            return True
    except urllib.error.HTTPError:
        return True  # 503 means running but degraded; the console explains why.
    except OSError:
        return False


def main(argv):
    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('WebKit2', '4.1')
    from gi.repository import Gtk, Gio, GLib, WebKit2

    GLib.set_prgname('better-bots')
    GLib.set_application_name('Better Bots')

    class Window(Gtk.Application):
        def __init__(self):
            super().__init__(application_id='org.betterbots.BetterBots', flags=Gio.ApplicationFlags.FLAGS_NONE)
            self.connect('activate', self.activate_window)

        def activate_window(self, _app):
            if self.get_active_window():
                self.get_active_window().present()
                return
            window = Gtk.ApplicationWindow(application=self, title='Better Bots')
            window.set_default_size(1240, 820)
            if Path(ICON).is_file():
                window.set_icon_from_file(ICON)
            self.web = WebKit2.WebView()
            self.web.get_settings().set_enable_developer_extras(False)
            self.web.connect('decide-policy', self.navigation)
            self.web.connect('permission-request', lambda _view, request: (request.deny(), True)[1])
            self.web.connect('load-failed', self.load_failed)
            window.add(self.web)
            window.show_all()
            self.web.load_html(STARTING, None)
            self.wait_for_host()

        def wait_for_host(self):
            # The service may still be starting right after login or install.
            if host_answers():
                self.web.load_uri(login_url())
                return False
            GLib.timeout_add_seconds(2, self.wait_for_host)
            return False

        def load_failed(self, _view, _event, uri, _error):
            if internal_url(uri):
                self.web.load_html(STARTING, None)
                GLib.timeout_add_seconds(2, self.wait_for_host)
                return True
            return False

        def navigation(self, _view, decision, kind):
            if kind not in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
                return False
            action = decision.get_navigation_action()
            uri = action.get_request().get_uri()
            if uri.startswith('about:') or (internal_url(uri) and kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION):
                return False
            # Sign-in pages and other sites open in the person's own browser. The
            # console opens a sign-in page only after the server answers, which
            # WebKit no longer counts as the click that asked for it, so a
            # window.open from the console goes through; a page load still needs a click.
            decision.ignore()
            asked = action.is_user_gesture() or kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION
            if asked and external_url(uri):
                Gio.AppInfo.launch_default_for_uri(uri, None)
            return True

    return Window().run(argv)


if __name__ == '__main__':
    import sys
    raise SystemExit(main(sys.argv))
