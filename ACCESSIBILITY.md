# Accessibility

Cronboard should work for anyone who uses GNOME, whether they use a mouse, only a keyboard, a screen reader, a high-contrast theme or large text. That goes for contributing too. This page covers what we aim for, what we expect from changes, how to tell us about a barrier and what we already know doesn't work well.

If you're here because something got in your way, skip to [Reporting accessibility issues](#reporting-accessibility-issues).

## Priorities

Cronboard has two parts you can see: a menu in the top panel and a preferences window. Both are built from GNOME's own widgets so they pick up the desktop's keyboard handling, theme, text size and screen reader support. We try not to break that with custom drawing or styling.

In order, we care most about:

- **Keyboard.** Everything you can do with a mouse, you should be able to do with the keyboard: opening the menu, switching jobs on and off, and adding, editing, running and deleting jobs.
- **Screen readers.** Every control should be announced with a name that says what it does, and its state should be announced too, such as whether a job is on or off. Job names, schedules and results are written as text, not shown only as icons or colours.
- **Not relying on colour.** A colour can back up a message but should never be the only way to get it.
- **Plain wording.** Schedules are shown as "Every day at 09:00" next to the cron expression, so you don't need to read cron syntax.
- **Avoiding mistakes.** Running or deleting a job always asks first, so a stray click or key press can't start or remove one.

We don't claim conformance with any accessibility standard. Cronboard hasn't been through a formal evaluation.

## Contributor expectations

If your change affects something people see or use:

- Use GNOME's standard widgets (from St in the panel menu, from GTK and libadwaita in the preferences) rather than building your own, unless there's no other way.
- Give every icon-only button a tooltip that says what it does.
- Don't use colour alone to show a state. Put it in the text as well.
- Don't hard-code font sizes in pixels. Use relative sizes like `em` so text follows the user's settings.
- Check that the change works with the keyboard alone. If you can, also try it with the Orca screen reader (<kbd>Super</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> turns it on and off) and with High Contrast turned on in Settings → Accessibility.

In the pull request, say what you checked under "How it was tested", for example "keyboard only" or "Orca reads the new button as Delete". Screenshots help but aren't required. If you couldn't test something, say so. That's fine, and it's better than leaving it unsaid.

There are no automated accessibility checks in CI yet, so this depends on manual testing.

## Reporting accessibility issues

[Open an issue](https://github.com/seniru-dilmith/cronboard/issues/new/choose) and describe the barrier. The `accessibility` label will be added during triage if you can't add it yourself.

These details help, but leave out anything you don't know or don't want to share:

- what you were trying to do, such as "turn off a job from the panel menu"
- what happened, and what you expected to happen
- your GNOME Shell version (`gnome-shell --version`) and distribution
- any assistive technology you use and its version, such as Orca, a screen magnifier, or a keyboard or switch setup
- any settings that might matter, such as High Contrast, Large Text or a different text scale

Screenshots or recordings are welcome but optional. You never need to tell us about a disability.

If you'd rather not report in public, use the contact details on the maintainer's [GitHub profile](https://github.com/seniru-dilmith).

### Severity

You don't need to choose a severity. The maintainer sets it during triage, using these levels:

- **Blocker:** you can't do the task at all. For example, a job can't be turned off using the keyboard, or a screen reader announces nothing for a button.
- **Serious:** you can do the task, but only with real difficulty or a workaround. For example, whether a job is on or off is only announced after you change it.
- **Minor:** it's awkward or confusing, but doesn't stop you. For example, an unclear button name, or focus landing somewhere unexpected after a dialog closes.

### How we respond

- You'll get a first reply within two days. It will either confirm the problem or ask for more details.
- If there's a workaround, we'll post it in the issue.
- Blockers are fixed before other work and go into the next release. Serious and minor issues are scheduled with the other work, and the issue stays open with its status until the fix ships.
- When there's a fix, we'll ask you to try it if you'd like to. You don't have to.

## Ownership and maintenance

The maintainers are responsible for accessibility in Cronboard. That means triaging reports, reviewing pull requests against the expectations above, and keeping this page accurate.

This page is checked before any release that changes the panel menu or the preferences window, and at least once a year otherwise. If someone else becomes maintainer, they take over this responsibility and their name replaces the one above.

## Supported environments

- **GNOME Shell 46**, on Wayland or X11.
- **Input:** keyboard and mouse or touchpad.
- **Assistive technology:** Orca, plus GNOME's built-in High Contrast, Large Text and Zoom settings. Other tools that work with GNOME's accessibility support should also work, but we haven't tested them.

Not every combination has been tested. If you use something not listed here, a report about how well it works is still useful.

## Known limitations

- **A failed job is shown only as a colour change on the panel icon.** The icon turns red when a tracked job's last run failed. Neither the icon's name nor any announcement changes, so a screen reader user won't know about it, and it's easy to miss in some themes. Workaround: open the menu. Each tracked job says "failed (exit …)" in text under its name.
- **The warning and failure colours are fixed.** The red icon and the yellow warning text don't follow the High Contrast theme. The warning is always written out, so this affects how it looks but not what it says.
- **The job log viewer is a large plain-text area.** Long logs can be slow to move through with a screen reader. Use the "Open in editor" button to read the log in your usual text editor.
- **Screen reader testing has been limited.** We haven't checked every control in the preferences window with Orca. Icon-only buttons have tooltips, but we haven't confirmed that each one is announced by name.

## Feedback and improvements

If you have ideas for making Cronboard easier to use, or think this page is unclear or wrong, open an issue or a pull request. Changes to this file are reviewed like any other change. If something is stopping you from using Cronboard right now, report it as described under [Reporting accessibility issues](#reporting-accessibility-issues) so it's tracked and fixed.
