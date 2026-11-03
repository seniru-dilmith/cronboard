// The live log window: shows a log file and keeps up as a job appends to it.
// GTK-only (no Shell imports), so the preferences window and tests can both load it.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

const LOG_TAIL_BYTES = 256 * 1024; // how much of a long log to show when the window opens

export function openInEditor(path: string): void {
    Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(path).get_uri(), null);
}

// Length of `b` without a UTF-8 character cut off at its end (that part waits for the next read).
function completeLength(b: Uint8Array): number {
    for (let i = b.length - 1; i >= Math.max(0, b.length - 4); i--) {
        if ((b[i] & 0xc0) === 0x80)
            continue; // a continuation byte: keep looking for the character's first byte
        const need = b[i] >= 0xf0 ? 4 : b[i] >= 0xe0 ? 3 : b[i] >= 0xc0 ? 2 : 1;
        return b.length - i < need ? i : b.length;
    }
    return b.length;
}

/** A window showing a log file that keeps up as the job appends to it, like `tail -f`. */
export function logDialog(title: string, path: string): Adw.Dialog {
    const file = Gio.File.new_for_path(path);
    const view = new Gtk.TextView({
        editable: false, cursor_visible: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR,
        top_margin: 12, bottom_margin: 12, left_margin: 12, right_margin: 12,
    });
    const scroller = new Gtk.ScrolledWindow({child: view, vexpand: true});
    const adj = scroller.vadjustment;
    const buffer = view.buffer;
    let offset = 0;
    let pending = new Uint8Array(0); // GJS's TextDecoder has no {stream: true}, so split characters wait here
    const decoder = new TextDecoder();

    // Reads whatever was appended since last time. A smaller file means it was replaced or truncated.
    const readNew = () => {
        let size: number;
        try {
            size = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
        } catch {
            return; // between a rename and its replacement; the next event catches up
        }
        if (size < offset) {
            buffer.set_text('', -1);
            offset = 0;
            pending = new Uint8Array(0);
        }
        if (size === offset)
            return;
        const following = adj.value >= adj.upper - adj.page_size - 24; // at the bottom: keep following
        const stream = file.read(null);
        try {
            if (offset === 0)
                offset = Math.max(0, size - LOG_TAIL_BYTES);
            // The cast only bridges two copies of the GLib typings in @girs; at runtime it's the same enum.
            stream.seek(offset, GLib.SeekType.SET as unknown as Parameters<typeof stream.seek>[1], null);
            while (offset < size) {
                const data = stream.read_bytes(Math.min(size - offset, 65536), null).get_data();
                if (!data || data.length === 0)
                    break;
                offset += data.length;
                const bytes = new Uint8Array(pending.length + data.length);
                bytes.set(pending);
                bytes.set(data, pending.length);
                const n = completeLength(bytes);
                pending = bytes.slice(n);
                buffer.insert(buffer.get_end_iter(), decoder.decode(bytes.subarray(0, n)), -1);
            }
        } finally {
            stream.close(null);
        }
        if (following)
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                adj.value = adj.upper - adj.page_size;
                return GLib.SOURCE_REMOVE;
            });
    };

    const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
    monitor.set_rate_limit(250);
    const changedId = monitor.connect('changed', readNew);

    const editor = new Gtk.Button({icon_name: 'document-open-symbolic', tooltip_text: 'Open in editor'});
    editor.connect('clicked', () => openInEditor(path));
    const header = new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title, subtitle: path})});
    header.pack_start(editor);
    const toolbar = new Adw.ToolbarView({content: scroller});
    toolbar.add_top_bar(header);
    const dialog = new Adw.Dialog({title, content_width: 860, content_height: 600, child: toolbar});
    dialog.connect('closed', () => {
        monitor.disconnect(changedId);
        monitor.cancel();
    });
    readNew();
    return dialog;
}
