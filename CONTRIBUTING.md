# Contributing

Thanks for taking an interest in Cronboard. Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and suggesting features

Open an issue and pick the matching template. For bugs, the GNOME Shell version and any errors from the log help the most. You can watch the log while reproducing the problem with:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Setting up

You need Node.js 22.6 or newer, Python 3.10 or newer and GNOME Shell 46.

The extension talks to the companion service in `service/`, so install that too:

```bash
pip install -e service
cronboard-service install
```

Then the extension:

```bash
npm install
npm run build
npm run install-dev
```

`install-dev` links the `dist` folder into your extensions directory. After a rebuild, log out and back in (or use `npm run nested` to try it in a nested session) to load the changes.

## Before opening a pull request

```bash
npm run build
npm test
python -m unittest service/tests/test_core.py
```

All three run in CI on every pull request, so they need to pass.

- Keep a pull request focused on one change.
- Add or update tests in `tests/` when you change logic.
- Match the style of the surrounding code.
- Explain what changed and why in the description. Screenshots help for UI changes.

## Releases

Releases are cut by the maintainer from the Release workflow in the Actions tab. Please don't bump versions in pull requests.
