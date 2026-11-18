// Panel indicator: lists the user's cron jobs with their schedule, next run and
// (for tracked jobs) last result, and toggles them. Kept light because it runs
// inside gnome-shell: it only shows what the Cronboard service sends, refreshing
// when the menu opens and when the service says the jobs changed.

import Atk from 'gi://Atk';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {NotInstalledError, ServiceMissingError, cronServiceActive, errorMessage, isCancelled, listJobs, setEnabled, watchJobs,
    type Job} from './lib/service.ts';

interface Row {
    job: Job;
    title: string;
    details: string;
}

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
    private icon: St.Icon | null;
    private readonly section = new PopupMenu.PopupMenuSection();
    private readonly cancellable = new Gio.Cancellable();
    private unwatch: (() => void) | null = null;
    private generation = 0;
    private renderedKey: string | null = null;

    constructor(ext: Extension) {
        // A "-symbolic" SVG is recoloured to match the panel, like the stock icons.
        const gicon = Gio.icon_new_for_string(`${ext.path}/icons/cronboard-symbolic.svg`);
        // The cast only bridges two copies of the Gio typings in @girs; at runtime it's the same Gio.Icon.
        this.icon = new St.Icon({gicon: gicon as unknown as St.Icon['gicon'], style_class: 'system-status-icon'});
        this.button.add_child(this.icon);
        this.menu.addMenuItem(this.section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Add or edit jobs…', () => ext.openPreferences());
        this.menu.connectObject('open-state-changed', (_menu: unknown, open: boolean) => {
            if (open)
                void this.refresh();
        }, this.button);
        Main.panel.addToStatusArea(ext.uuid, this.button);
        this.watch();
        void this.refresh();
    }

    destroy(): void {
        this.cancellable.cancel();
        this.unwatch?.();
        this.unwatch = null;
        this.icon?.destroy();
        this.icon = null;
        this.button.destroy();
    }

    private async refresh(): Promise<void> {
        if (this.cancellable.is_cancelled())
            return;
        const generation = ++this.generation;
        let list: Job[] = [];
        let warning: string | null = null;
        try {
            const [jobs, active] = await Promise.all([listJobs(this.cancellable), cronServiceActive(this.cancellable)]);
            list = jobs;
            if (!active)
                warning = "The cron service isn't running, so these jobs won't run.";
        } catch (e) {
            if (isCancelled(e))
                return;
            warning = e instanceof NotInstalledError || e instanceof ServiceMissingError ? e.message : `Could not read the crontab: ${errorMessage(e)}`;
        }
        // A newer refresh may have started meanwhile; only the latest one renders.
        if (generation !== this.generation || this.cancellable.is_cancelled())
            return;
        this.render(list, warning);
    }

    private render(list: Job[], warning: string | null): void {
        if (list.some(j => j.last_run && j.last_exit !== 0))
            this.icon?.add_style_class_name('cronboard-failed');
        else
            this.icon?.remove_style_class_name('cronboard-failed');
        const rows = list.map(job => this.row(job));
        // Rebuilding destroys the item under the pointer and drops the click, so only rebuild on real changes.
        const key = JSON.stringify([warning, rows.map(r => [r.job.id, r.title, r.details])]);
        if (key === this.renderedKey)
            return;
        this.renderedKey = key;
        this.section.removeAll();
        if (warning)
            this.section.addMenuItem(infoItem(warning, 'cronboard-warning'));
        else if (rows.length === 0)
            this.section.addMenuItem(infoItem('No cron jobs yet'));
        for (const row of rows)
            this.section.addMenuItem(this.jobItem(row));
    }

    private row(job: Job): Row {
        const details = [job.description + (job.next_run ? ` · next ${job.next_run}` : '') + (job.enabled ? '' : ' · disabled')];
        if (job.last_run)
            details.push(`last run ${job.last_run}: ${job.last_exit === 0 ? 'OK' : `failed (exit ${job.last_exit})`}`);
        return {job, title: job.name || shorten(job.command), details: details.join('\n')};
    }

    private jobItem({job, title, details}: Row): PopupMenu.PopupMenuItem {
        const item = new PopupMenu.PopupMenuItem(title);
        // Title above a smaller details line; the title stays item.label, which screen readers announce.
        const text = new St.BoxLayout({vertical: true, x_expand: true});
        item.remove_child(item.label);
        text.add_child(item.label);
        text.add_child(new St.Label({text: details, style_class: 'cronboard-details'}));
        item.insert_child_at_index(text, 1); // after the ornament
        if (!job.enabled)
            text.opacity = 140;
        // Announced like PopupSwitchMenuItem: a checkable item that is on when the job is enabled.
        item.accessible_role = Atk.Role.CHECK_MENU_ITEM;
        if (job.enabled)
            item.add_accessible_state(Atk.StateType.CHECKED);

        // Run now lives in the preferences, behind a confirmation, so a stray click here can't start a job.
        item.add_child(new PopupMenu.Switch(job.enabled));
        item.connect('activate', () => void this.toggle(job));
        return item;
    }

    // On success the service's JobsChanged rebuilds the rows, so the next open has nothing to rebuild.
    private async toggle(job: Job): Promise<void> {
        try {
            await setEnabled(job.id, !job.enabled);
        } catch (e) {
            Main.notifyError('Cronboard: could not update the crontab', errorMessage(e));
            void this.refresh();
        }
    }

    // The service says when jobs change: a save here or in the preferences, or a tracked job finishing.
    private watch(): void {
        watchJobs(() => void this.refresh(), this.cancellable).then(unwatch => {
            if (this.cancellable.is_cancelled())
                unwatch();
            else
                this.unwatch = unwatch;
        }).catch(e => {
            if (!isCancelled(e))
                console.warn(`Cronboard: not watching for job changes: ${errorMessage(e)}`);
        });
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
