// Panel indicator: lists the user's cron jobs with their schedule, next run and
// (for tracked jobs) last result, and toggles or runs them. Kept light because
// it runs inside gnome-shell: the crontab is read only when the menu opens.

import Atk from 'gi://Atk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {NotInstalledError, cronServiceActive, errorMessage, isCancelled, read, readStatuses, runNow, stateDir, write,
    type RunStatus} from './lib/crontab.ts';
import {jobs, parse, serialize, setEnabled, type Job} from './lib/parser.ts';
import {describe, formatWhen, nextRuns} from './lib/schedule.ts';

const esc = (s: string) => GLib.markup_escape_text(s, -1);

// "/home/me/bin/backup.sh --photos" -> "backup.sh --photos", capped in length.
function shorten(command: string): string {
    const short = command.replace(/^\S*\//, '');
    return short.length > 48 ? `${short.slice(0, 47)}…` : short;
}

function infoItem(text: string, styleClass?: string): PopupMenu.PopupMenuItem {
    const item = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
    if (styleClass)
        item.label.add_style_class_name(styleClass);
    return item;
}

class Indicator {
    private readonly button = new PanelMenu.Button(0.0, 'Cronboard', false);
    private readonly menu = this.button.menu as PopupMenu.PopupMenu;
    private readonly icon = new St.Icon({icon_name: 'alarm-symbolic', style_class: 'system-status-icon'});
    private readonly section = new PopupMenu.PopupMenuSection();
    private readonly cancellable = new Gio.Cancellable();
    private monitor: Gio.FileMonitor | null = null;
    private monitorId = 0;
    private snapshot: string | null = null; // the crontab text the menu was built from
    private tracked: string[] = [];
    private generation = 0;

    constructor(ext: Extension) {
        this.button.add_child(this.icon);
        this.menu.addMenuItem(this.section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Add or edit jobs…', () => ext.openPreferences());
        this.menu.connectObject('open-state-changed', (_menu: unknown, open: boolean) => {
            if (open)
                void this.refresh();
        }, this.button);
        Main.panel.addToStatusArea(ext.uuid, this.button);
        this.watchStatuses();
        void this.refresh();
    }

    destroy(): void {
        this.cancellable.cancel();
        if (this.monitor) {
            this.monitor.disconnect(this.monitorId);
            this.monitor.cancel();
            this.monitor = null;
        }
        this.button.destroy();
    }

    private async refresh(): Promise<void> {
        if (this.cancellable.is_cancelled())
            return;
        const generation = ++this.generation;
        let text: string | null = null;
        let warning: string | null = null;
        try {
            const [crontab, active] = await Promise.all([read(this.cancellable), cronServiceActive(this.cancellable)]);
            text = crontab;
            if (!active)
                warning = "The cron service isn't running, so these jobs won't run.";
        } catch (e) {
            if (isCancelled(e))
                return;
            warning = e instanceof NotInstalledError ? e.message : `Could not read the crontab: ${errorMessage(e)}`;
        }
        const list = text === null ? [] : jobs(parse(text));
        const tracked = list.flatMap(j => j.line.track ? [j.line.track.id] : []);
        const statuses = await readStatuses(tracked, this.cancellable);
        // A newer refresh may have started meanwhile; only the latest one renders.
        if (generation !== this.generation || this.cancellable.is_cancelled())
            return;
        this.snapshot = text;
        this.tracked = tracked;
        this.render(list, statuses, warning);
    }

    private render(list: Job[], statuses: Map<string, RunStatus>, warning: string | null): void {
        this.section.removeAll();
        this.showFailed(statuses);
        if (warning)
            this.section.addMenuItem(infoItem(warning, 'cronboard-warning'));
        else if (list.length === 0)
            this.section.addMenuItem(infoItem('No cron jobs yet'));
        const now = new Date();
        for (const job of list)
            this.section.addMenuItem(this.jobItem(job, job.line.track ? statuses.get(job.line.track.id) : undefined, now));
    }

    private showFailed(statuses: Map<string, RunStatus>): void {
        if ([...statuses.values()].some(s => s.exit !== 0))
            this.icon.add_style_class_name('cronboard-failed');
        else
            this.icon.remove_style_class_name('cronboard-failed');
    }

    private jobItem(job: Job, status: RunStatus | undefined, now: Date): PopupMenu.PopupMenuItem {
        const {line} = job;
        const title = job.name ?? shorten(line.command);
        const next = line.enabled ? nextRuns(line.schedule, now, 1)[0] : undefined;
        const details = [describe(line.schedule) +
            (next ? ` · next ${formatWhen(next, now)}` : '') + (line.enabled ? '' : ' · disabled')];
        if (status)
            details.push(`last run ${formatWhen(status.finished, now)}: ${status.exit === 0 ? 'OK' : `failed (exit ${status.exit})`}`);

        const item = new PopupMenu.PopupMenuItem('');
        item.label.clutter_text.set_markup(`${esc(title)}\n<small>${details.map(esc).join('\n')}</small>`);
        item.label.x_expand = true;
        if (!line.enabled)
            item.label.opacity = 160;
        // Announced like PopupSwitchMenuItem: a checkable item that is on when the job is enabled.
        item.accessible_role = Atk.Role.CHECK_MENU_ITEM;
        if (line.enabled)
            item.add_accessible_state(Atk.StateType.CHECKED);

        const run = new St.Button({
            child: new St.Icon({icon_name: 'media-playback-start-symbolic', icon_size: 16}),
            style_class: 'cronboard-run-button',
            can_focus: true,
            accessible_name: `Run ${title} now`,
        });
        run.connect('clicked', () => {
            this.menu.close(true);
            void this.run(job, title);
        });
        item.add_child(run);
        item.add_child(new PopupMenu.Switch(line.enabled));
        item.connect('activate', () => void this.toggle(job));
        return item;
    }

    // The menu closes on activate, and the next open re-reads the crontab, so no local state to update.
    private async toggle(job: Job): Promise<void> {
        const snapshot = this.snapshot;
        if (snapshot === null)
            return;
        try {
            await write(serialize(setEnabled(parse(snapshot), job.index, !job.line.enabled)), snapshot);
        } catch (e) {
            Main.notifyError('Cronboard: could not update the crontab', errorMessage(e));
        }
    }

    private async run(job: Job, title: string): Promise<void> {
        Main.notify('Cronboard', `Running ${title}…`);
        try {
            const r = await runNow(job, this.cancellable);
            if (r.status === 0)
                Main.notify('Cronboard', `${title} finished`);
            else
                Main.notifyError(`Cronboard: ${title} failed (exit ${r.status})`,
                    r.stderr.trim() || 'Its output is in the journal: journalctl --user -u "cronboard-run-*"');
        } catch (e) {
            if (!isCancelled(e))
                Main.notifyError(`Cronboard: could not run ${title}`, errorMessage(e));
        }
    }

    // Tracked jobs write <id>.status when they finish; turn the icon red if one failed.
    private watchStatuses(): void {
        try {
            // GLib's monitor also copes with a folder that doesn't exist yet.
            this.monitor = Gio.File.new_for_path(stateDir()).monitor_directory(Gio.FileMonitorFlags.NONE, this.cancellable);
            this.monitorId = this.monitor.connect('changed', (_monitor, file) => {
                const name = file.get_basename() ?? '';
                if (name.endsWith('.status') && !name.startsWith('.'))
                    void this.updateFailed();
            });
        } catch (e) {
            console.warn(`Cronboard: not watching run statuses: ${errorMessage(e)}`);
        }
    }

    private async updateFailed(): Promise<void> {
        const statuses = await readStatuses(this.tracked, this.cancellable);
        if (!this.cancellable.is_cancelled())
            this.showFailed(statuses);
    }
}

export default class CronboardExtension extends Extension {
    private indicator: Indicator | null = null;

    override enable(): void {
        this.indicator = new Indicator(this);
    }

    override disable(): void {
        this.indicator?.destroy();
        this.indicator = null;
    }
}
