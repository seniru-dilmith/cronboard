// Preferences window: list, add, edit and delete jobs, with a schedule builder,
// live validation and a preview of the next runs. The Cronboard service does the
// work (parsing, validating, saving); this window shows what it returns.

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ConflictError, addJob, checkSchedule, deleteJob, errorMessage, listJobs, runNow, setEnabled, updateJob, watchJobs,
    type Job, type JobFields} from './lib/service.ts';
import {confirm, sheet} from './lib/dialogs.ts';
import {logDialog} from './logview.ts';

type Preset = 'minute' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'reboot' | 'custom';

const PRESETS: {id: Preset; label: string}[] = [
    {id: 'minute', label: 'Every minute'},
    {id: 'hourly', label: 'Every hour'},
    {id: 'daily', label: 'Every day'},
    {id: 'weekly', label: 'Every week'},
    {id: 'monthly', label: 'Every month'},
    {id: 'reboot', label: 'At startup'},
    {id: 'custom', label: 'Custom'},
];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]; // combo row order, Monday first
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The expression a preset's rows stand for (the service maps expressions back to presets). */
function presetToExpr(preset: Exclude<Preset, 'custom'>, o: {minute: number; hour: number; weekday: number; day: number}): string {
    switch (preset) {
    case 'minute': return '* * * * *';
    case 'hourly': return `${o.minute} * * * *`;
    case 'daily': return `${o.minute} ${o.hour} * * *`;
    case 'weekly': return `${o.minute} ${o.hour} * * ${o.weekday}`;
    case 'monthly': return `${o.minute} ${o.hour} ${o.day} * *`;
    case 'reboot': return '@reboot';
    }
}

/** A log file to suggest for a new job, named after the job or its program. */
function defaultLog(name: string, command: string): string {
    const program = command.trim().split(/\s+/)[0]?.split('/').pop()?.replace(/\.\w+$/, '') ?? '';
    const slug = (name.trim() || program).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `~/.local/state/cronboard/logs/${slug || 'job'}.log`;
}

function flatButton(icon: string, tooltip: string): Gtk.Button {
    return new Gtk.Button({icon_name: icon, tooltip_text: tooltip, valign: Gtk.Align.CENTER, css_classes: ['flat']});
}

// Plain text only: markup is switched off before the text is set, or a "&" in a command makes GTK log a parse error.
function toast(title: string, timeout = 6): Adw.Toast {
    const t = new Adw.Toast({use_markup: false, timeout});
    t.title = title;
    return t;
}

const title = (job: Job) => job.name || job.command;

class JobsPage {
    private readonly window: Adw.PreferencesWindow;
    private readonly page = new Adw.PreferencesPage({title: 'Jobs', icon_name: 'alarm-symbolic'});
    private group: Adw.PreferencesGroup | null = null;
    private readable = false; // whether the last reload got the jobs
    private readonly running = new Set<string>(); // ids of jobs started with Run now

    constructor(window: Adw.PreferencesWindow) {
        this.window = window;
        window.set_default_size(680, 720); // room for the editor's preview without scrolling
        window.add(this.page);
        watchJobs(() => void this.reload(), null).then(unwatch => {
            window.connect('close-request', () => {
                unwatch();
                return false;
            });
        }).catch(e => console.warn(`Cronboard: not watching for job changes: ${errorMessage(e)}`));
        void this.reload();
    }

    private async reload(): Promise<void> {
        let list: Job[] = [];
        let error: string | null = null;
        try {
            list = await listJobs();
        } catch (e) {
            error = `Could not read the crontab: ${errorMessage(e)}`;
        }
        this.readable = error === null;
        this.show(list, error);
    }

    private show(list: Job[], error: string | null): void {
        if (this.group)
            this.page.remove(this.group);
        // GObject rejects `description: undefined`, so the key is only passed when there's an error to show.
        this.group = new Adw.PreferencesGroup({
            title: 'Cron jobs',
            ...(error ? {description: GLib.markup_escape_text(error, -1)} : {}),
        });
        const add = flatButton('list-add-symbolic', 'Add job');
        add.sensitive = this.readable;
        add.connect('clicked', () => this.edit(null));
        this.group.set_header_suffix(add);
        if (list.length === 0 && error === null)
            this.group.add(new Adw.ActionRow({title: 'No cron jobs yet', subtitle: 'Use + to add one.'}));
        for (const job of list)
            this.group.add(this.row(job));
        this.page.add(this.group);
    }

    private row(job: Job): Adw.ActionRow {
        const details = [job.description + (job.next_run ? ` · next ${job.next_run}` : '') + (job.enabled ? '' : ' · disabled')];
        if (job.name)
            details.push(job.command);
        if (job.last_run)
            details.push(`Last run ${job.last_run}: ${job.last_exit === 0 ? 'OK' : `failed (exit ${job.last_exit})`}`);
        const row = new Adw.ActionRow({use_markup: false});
        row.title = title(job);
        row.subtitle = details.join('\n');

        const run = flatButton('media-playback-start-symbolic', 'Run now');
        if (this.running.has(job.id)) {
            run.set_child(new Gtk.Spinner({spinning: true}));
            run.sensitive = false;
            run.tooltip_text = 'Running…';
        }
        run.connect('clicked', () => this.confirmRun(job));
        row.add_suffix(run);
        if (job.log_paths.length > 0) {
            const log = flatButton('text-x-generic-symbolic', 'Open log');
            log.connect('clicked', () => this.openLog(job));
            row.add_suffix(log);
        }
        const edit = flatButton('document-edit-symbolic', 'Edit');
        edit.connect('clicked', () => this.edit(job));
        const remove = flatButton('user-trash-symbolic', 'Delete');
        remove.connect('clicked', () => this.confirmDelete(job));
        const enabled = new Gtk.Switch({active: job.enabled, valign: Gtk.Align.CENTER, tooltip_text: 'Enabled'});
        enabled.connect('notify::active', () => void this.applyOrToast(() => setEnabled(job.id, enabled.active)));
        row.add_suffix(edit);
        row.add_suffix(remove);
        row.add_suffix(enabled);
        return row;
    }

    /** Sends a change to the service and reloads. Resolves to an error message, or null on success. */
    private async apply(change: () => Promise<void>): Promise<string | null> {
        if (!this.readable)
            return "Can't save: the crontab couldn't be read.";
        this.page.sensitive = false; // one change at a time
        try {
            await change();
            return null;
        } catch (e) {
            return e instanceof ConflictError ? e.message : `Could not save: ${errorMessage(e)}`;
        } finally {
            await this.reload();
            this.page.sensitive = true;
        }
    }

    private async applyOrToast(change: () => Promise<void>): Promise<void> {
        const error = await this.apply(change);
        if (error)
            this.window.add_toast(toast(error));
    }

    private openLog(job: Job): void {
        const path = job.log_paths.find(p => GLib.file_test(p, GLib.FileTest.EXISTS));
        if (!path) {
            this.window.add_toast(toast(`No log yet: ${job.log_paths[0]} doesn't exist`));
            return;
        }
        try {
            logDialog(title(job), path).present(this.window);
        } catch (e) {
            this.window.add_toast(toast(`Couldn't open ${path}: ${errorMessage(e)}`));
        }
    }

    private confirmRun(job: Job): void {
        confirm(this.window, 'Run this job now?', title(job), 'Run', Adw.ResponseAppearance.SUGGESTED,
            () => void this.run(job));
    }

    // Runs it the way cron would (see runNow). The row shows a spinner until it ends, which can take minutes.
    private async run(job: Job): Promise<void> {
        this.running.add(job.id);
        void this.reload();
        let message: string;
        try {
            const r = await runNow(job.id, null);
            message = r.stderr.trim() ? `Couldn't start ${title(job)}: ${r.stderr.trim()}`
                : r.status === 0 ? `${title(job)} finished` : `${title(job)} failed (exit ${r.status})`;
        } catch (e) {
            message = `Couldn't start ${title(job)}: ${errorMessage(e)}`;
        }
        this.running.delete(job.id);
        void this.reload();
        const done = toast(message, 10);
        if (job.log_paths.length > 0) {
            done.button_label = 'Open log';
            done.connect('button-clicked', () => this.openLog(job));
        }
        this.window.add_toast(done);
    }

    private confirmDelete(job: Job): void {
        confirm(this.window, 'Delete this job?', title(job), 'Delete', Adw.ResponseAppearance.DESTRUCTIVE,
            () => void this.applyOrToast(() => deleteJob(job.id)));
    }

    private edit(job: Job | null): void {
        const cancel = new Gtk.Button({label: 'Cancel'});
        const save = new Gtk.Button({label: 'Save', css_classes: ['suggested-action']});
        const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
        header.pack_start(cancel);
        header.pack_end(save);
        const page = new Adw.PreferencesPage();
        const view = new Adw.ToolbarView({content: page});
        view.add_top_bar(header);
        const overlay = new Adw.ToastOverlay({child: view});
        // A height is needed: Adw.Dialog (GNOME 46+) otherwise shrinks to the scrolled page's tiny natural height.
        const dialog = sheet(job ? 'Edit job' : 'Add job', overlay, 560, 640);

        const name = new Adw.EntryRow({title: 'Name (optional)', text: job?.name ?? ''});
        const command = new Adw.EntryRow({title: 'Command', text: job?.edit_command ?? ''});
        const log = new Adw.EntryRow({title: 'Log file (optional)', text: job?.edit_log ?? ''});
        const track = new Adw.SwitchRow({
            title: 'Track runs',
            subtitle: 'Show the last result in the panel menu',
            active: job?.tracked ?? false,
        });
        const jobGroup = new Adw.PreferencesGroup();
        jobGroup.add(name);
        jobGroup.add(command);
        jobGroup.add(log);
        jobGroup.add(track);

        const preset = new Adw.ComboRow({title: 'Repeat', model: Gtk.StringList.new(PRESETS.map(p => p.label))});
        const hour = new Adw.SpinRow({title: 'Hour', adjustment: new Gtk.Adjustment({lower: 0, upper: 23, step_increment: 1})});
        const minute = new Adw.SpinRow({title: 'Minute', adjustment: new Gtk.Adjustment({lower: 0, upper: 59, step_increment: 1})});
        const weekday = new Adw.ComboRow({title: 'Day of the week', model: Gtk.StringList.new(WEEKDAY_NAMES)});
        const day = new Adw.SpinRow({title: 'Day of the month', adjustment: new Gtk.Adjustment({lower: 1, upper: 31, step_increment: 1})});
        const expr = new Adw.EntryRow({title: 'Cron expression', text: job?.schedule ?? '0 9 * * *'});
        const preview = new Adw.ActionRow({title: '', use_markup: false});
        const scheduleGroup = new Adw.PreferencesGroup({title: 'Schedule'});
        for (const row of [preset, hour, minute, weekday, day, expr, preview])
            scheduleGroup.add(row);
        page.add(jobGroup);
        page.add(scheduleGroup);

        // The preset rows and the expression update each other; `syncing` stops the echo.
        let syncing = false;
        let scheduleOk = false;
        let checks = 0; // only the answer to the latest check is shown
        const showOptions = (p: Preset) => {
            hour.visible = p === 'daily' || p === 'weekly' || p === 'monthly';
            minute.visible = hour.visible || p === 'hourly';
            weekday.visible = p === 'weekly';
            day.visible = p === 'monthly';
        };
        // The service has the final say on save; this only greys out Save for an empty command.
        const validity = () => {
            const commandOk = command.text.trim() !== '';
            if (!commandOk && command.text !== '')
                command.add_css_class('error');
            else
                command.remove_css_class('error');
            save.sensitive = scheduleOk && commandOk;
        };
        const fromPreset = () => {
            if (syncing)
                return;
            const p = PRESETS[preset.selected].id;
            showOptions(p);
            if (p === 'custom')
                return; // keep the expression as typed
            syncing = true;
            expr.text = presetToExpr(p, {
                minute: Math.round(minute.value),
                hour: Math.round(hour.value),
                weekday: WEEKDAYS[weekday.selected],
                day: Math.round(day.value),
            });
            syncing = false;
        };
        const fromExpr = async () => {
            const typed = !syncing; // typed by hand, rather than written by fromPreset
            const id = ++checks;
            let check;
            try {
                check = await checkSchedule(expr.text);
            } catch (e) {
                if (id === checks) {
                    scheduleOk = false;
                    preview.title = errorMessage(e);
                    preview.subtitle = '';
                    validity();
                }
                return;
            }
            if (id !== checks)
                return;
            scheduleOk = !check.error;
            if (check.error)
                expr.add_css_class('error');
            else
                expr.remove_css_class('error');
            preview.title = check.error || check.description;
            preview.subtitle = check.next;
            if (typed) {
                const p = check.preset as Preset;
                syncing = true;
                preset.selected = PRESETS.findIndex(x => x.id === p);
                hour.value = check.hour;
                minute.value = check.minute;
                day.value = check.day;
                weekday.selected = WEEKDAYS.indexOf(check.weekday);
                syncing = false;
                showOptions(p);
            }
            validity();
        };
        preset.connect('notify::selected', fromPreset);
        weekday.connect('notify::selected', fromPreset);
        for (const spin of [hour, minute, day])
            spin.connect('notify::value', fromPreset);
        expr.connect('changed', () => void fromExpr());
        command.connect('changed', validity);
        save.sensitive = false;
        void fromExpr();

        // New jobs get a suggested log file that follows the name until the field is edited.
        let logFollows = !job;
        const suggestLog = () => {
            if (!logFollows)
                return;
            log.text = defaultLog(name.text, command.text);
            logFollows = true; // setting the text above fires 'changed'
        };
        log.connect('changed', () => (logFollows = false));
        name.connect('changed', suggestLog);
        command.connect('changed', suggestLog);
        suggestLog();

        const onSave = async () => {
            const fields: JobFields = {
                name: name.text,
                command: command.text,
                log: log.text,
                schedule: expr.text,
                tracked: track.active,
            };
            const error = await this.apply(() => job ? updateJob(job.id, fields) : addJob(fields));
            if (error)
                overlay.add_toast(toast(error));
            else
                dialog.close();
        };
        save.connect('clicked', () => void onSave());
        cancel.connect('clicked', () => dialog.close());
        dialog.present(this.window);
    }
}

export default class CronboardPreferences extends ExtensionPreferences {
    override fillPreferencesWindow(window: Adw.PreferencesWindow): void {
        new JobsPage(window);
    }
}
