// Dialogs that also work on libadwaita 1.4 (GNOME 45), which has neither
// Adw.Dialog nor Adw.AlertDialog (both arrived in 1.5). Newer versions get the
// real widgets; GNOME 45 gets a modal Adw.Window / Adw.MessageDialog instead.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

export interface Sheet {
    present(parent: Gtk.Widget): void;
    close(): void;
}

/** A modal sheet with `child` as its content. `onClosed` runs once it has been closed. */
export function sheet(title: string, child: Gtk.Widget, width: number, height?: number, onClosed?: () => void): Sheet {
    if (typeof Adw.Dialog === 'function') {
        const dialog = new Adw.Dialog({title, content_width: width, content_height: height ?? 0, child});
        if (onClosed)
            dialog.connect('closed', onClosed);
        return {present: parent => dialog.present(parent), close: () => dialog.close()};
    }
    const window = new Adw.Window({title, modal: true, default_width: width, default_height: height ?? -1, content: child});
    if (onClosed)
        window.connect('close-request', () => {
            onClosed();
            return false;
        });
    // Adw.Dialog closes on Escape by itself; a plain window needs telling.
    const escape = new Gtk.ShortcutController();
    escape.add_shortcut(new Gtk.Shortcut({
        trigger: Gtk.ShortcutTrigger.parse_string('Escape'),
        action: Gtk.CallbackAction.new(() => {
            window.close();
            return true;
        }),
    }));
    window.add_controller(escape);
    return {
        present: parent => {
            window.set_transient_for(parent.get_root() as Gtk.Window);
            window.present();
        },
        close: () => window.close(),
    };
}

/** Asks "Cancel or <action>?" and calls `onConfirm` only for the action. Cancel is the default. */
export function confirm(parent: Gtk.Widget, heading: string, body: string, action: string,
    appearance: Adw.ResponseAppearance, onConfirm: () => void): void {
    const modern = typeof Adw.AlertDialog === 'function';
    const dialog: Adw.MessageDialog = modern
        ? new Adw.AlertDialog({heading, body}) as unknown as Adw.MessageDialog
        : new Adw.MessageDialog({heading, body, modal: true, transient_for: parent.get_root() as Gtk.Window});
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('action', action);
    dialog.set_response_appearance('action', appearance);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_dialog, response) => {
        if (response === 'action')
            onConfirm();
    });
    if (modern)
        (dialog as unknown as Adw.AlertDialog).present(parent);
    else
        dialog.present();
}
