// Preferences window: list, add, edit and delete jobs, with a schedule builder,
// live validation and a preview of the next runs. This runs in its own process,
// so the few small blocking file operations here don't affect the shell.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ConflictError, errorMessage, read, readStatuses, runnerPath, stateDir, write,
    type RunStatus} from './lib/crontab.ts';
import {addJob, checkCommand, deleteJob, jobs, parse, serialize, setEnabled, updateJob,
    type Job, type JobFields, type Line, type Track} from './lib/parser.ts';
import {describe, exprToPreset, formatWhen, nextRuns, presetToExpr, validate, type Preset} from './lib/schedule.ts';

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

function flatButton(icon: string, tooltip: string): Gtk.Button {
    return new Gtk.Button({icon_name: icon, tooltip_text: tooltip, valign: Gtk.Align.CENTER, css_classes: ['flat']});
}

function toast(title: string): Adw.Toast {
    return new Adw.Toast({title, use_markup: false, timeout: 6});
}

/** Copies the bundled wrapper to ~/.local/share/cronboard so tracked jobs keep working without the extension. */
function installRunner(source: Gio.File): string {
    const path = runnerPath();
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    const dest = Gio.File.new_for_path(path);
    source.copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
    dest.set_attribute_uint32('unix::mode', 0o755, Gio.FileQueryInfoFlags.NONE, null);
    return path;
}

function forgetRuns(id: string): void {
    for (const ext of ['status', 'log']) {
        try {
            Gio.File.new_for_path(GLib.build_filenamev([stateDir(), `${id}.${ext}`])).delete(null);
        } catch {
            // Best effort: usually the file just doesn't exist.
        }
    }
}

const newTrackId = () => GLib.uuid_string_random().replaceAll('-', '').slice(0, 8);

class JobsPage {
    private readonly window: Adw.PreferencesWindow;
    private readonly runnerSource: Gio.File;
    private readonly page = new Adw.PreferencesPage({title: 'Jobs', icon_name: 'alarm-symbolic'});
    private group: Adw.PreferencesGroup | null = null;
    private snapshot: string | null = null; // the crontab text the rows were built from

    constructor(window: Adw.PreferencesWindow, runnerSource: Gio.File) {
        this.window = window;
        this.runnerSource = runnerSource;
        window.add(this.page);
        void this.reload();
    }

    private async reload(): Promise<void> {
        let list: Job[] = [];
        let error: string | null = null;
        try {
            this.snapshot = await read();
            list = jobs(parse(this.snapshot));
        } catch (e) {
            this.snapshot = null;
            error = `Could not read the crontab: ${errorMessage(e)}`;
        }
        const statuses = await readStatuses(list.flatMap(j => j.line.track ? [j.line.track.id] : []), null);
        this.show(list, statuses, error);
    }

    private show(list: Job[], statuses: Map<string, RunStatus>, error: string | null): void {
        if (this.group)
            this.page.remove(this.group);
        this.group = new Adw.PreferencesGroup({
            title: 'Cron jobs',
            description: GLib.markup_escape_text(error ??
                "Your crontab. Comments, variables and lines Cronboard doesn't understand are kept as they are.", -1),
        });
        const add = flatButton('list-add-symbolic', 'Add job');
        add.sensitive = this.snapshot !== null;
        add.connect('clicked', () => this.edit(null));
        this.group.set_header_suffix(add);
        if (list.length === 0 && error === null)
            this.group.add(new Adw.ActionRow({title: 'No cron jobs yet', subtitle: 'Add one with the + button.'}));
        const now = new Date();
        for (const job of list)
            this.group.add(this.row(job, job.line.track ? statuses.get(job.line.track.id) : undefined, now));
        this.page.add(this.group);
    }

    private row(job: Job, status: RunStatus | undefined, now: Date): Adw.ActionRow {
        const {line} = job;
        const next = line.enabled ? nextRuns(line.schedule, now, 1)[0] : undefined;
        const details = [describe(line.schedule) +
            (next ? ` · next ${formatWhen(next, now)}` : '') + (line.enabled ? '' : ' · disabled')];
        if (job.name)
            details.push(line.command);
        if (status)
            details.push(`Last run ${formatWhen(status.finished, now)}: ${status.exit === 0 ? 'OK' : `failed (exit ${status.exit})`}`);
        const row = new Adw.ActionRow({title: job.name ?? line.command, subtitle: details.join('\n'), use_markup: false});

        if (line.track) {
            const id = line.track.id;
            const output = flatButton('text-x-generic-symbolic', 'Open last output');
            output.connect('clicked', () => this.openOutput(id));
            row.add_suffix(output);
        }
        const edit = flatButton('document-edit-symbolic', 'Edit');
        edit.connect('clicked', () => this.edit(job));
        const remove = flatButton('user-trash-symbolic', 'Delete');
        remove.connect('clicked', () => this.confirmDelete(job));
        const enabled = new Gtk.Switch({active: line.enabled, valign: Gtk.Align.CENTER, tooltip_text: 'Enabled'});
        enabled.connect('notify::active', () => void this.applyOrToast(lines => setEnabled(lines, job.index, enabled.active)));
        row.add_suffix(edit);
        row.add_suffix(remove);
        row.add_suffix(enabled);
        return row;
    }

    /** Applies a change to the crontab and reloads. Resolves to an error message, or null on success. */
    private async apply(change: (lines: Line[]) => Line[]): Promise<string | null> {
        const snapshot = this.snapshot;
        if (snapshot === null)
            return 'The crontab could not be read, so it cannot be changed.';
        this.page.sensitive = false; // one write at a time
        try {
            await write(serialize(change(parse(snapshot))), snapshot);
            return null;
        } catch (e) {
            return e instanceof ConflictError ? e.message : `Could not save: ${errorMessage(e)}`;
        } finally {
            await this.reload();
            this.page.sensitive = true;
        }
    }

    private async applyOrToast(change: (lines: Line[]) => Line[]): Promise<void> {
        const error = await this.apply(change);
        if (error)
            this.window.add_toast(toast(error));
    }

    private openOutput(id: string): void {
        const log = Gio.File.new_for_path(GLib.build_filenamev([stateDir(), `${id}.log`]));
        try {
            if (!log.query_exists(null))
                throw new Error("this job hasn't run since tracking was turned on");
            Gio.AppInfo.launch_default_for_uri(log.get_uri(), null);
        } catch (e) {
            this.window.add_toast(toast(`Could not open the output: ${errorMessage(e)}`));
        }
    }

    private confirmDelete(job: Job): void {
        const dialog = new Adw.AlertDialog({heading: 'Delete this job?', body: job.name ?? job.line.command});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_dialog, response) => {
            if (response === 'delete')
                void this.remove(job);
        });
        dialog.present(this.window);
    }

    private async remove(job: Job): Promise<void> {
        const error = await this.apply(lines => deleteJob(lines, job.index));
        if (error)
            this.window.add_toast(toast(error));
        else if (job.line.track)
            forgetRuns(job.line.track.id);
    }

    private edit(job: Job | null): void {
        const dialog = new Adw.Dialog({title: job ? 'Edit job' : 'Add job', content_width: 560});
        const cancel = new Gtk.Button({label: 'Cancel'});
        const save = new Gtk.Button({label: 'Save', css_classes: ['suggested-action']});
        const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
        header.pack_start(cancel);
        header.pack_end(save);
        const page = new Adw.PreferencesPage();
        const view = new Adw.ToolbarView({content: page});
        view.add_top_bar(header);
        const overlay = new Adw.ToastOverlay({child: view});
        dialog.set_child(overlay);

        const name = new Adw.EntryRow({title: 'Name (optional)', text: job?.name ?? ''});
        const command = new Adw.EntryRow({title: 'Command', text: job?.line.command ?? ''});
        const track = new Adw.SwitchRow({
            title: 'Track runs',
            subtitle: 'Record the last exit status and output, shown in the panel menu',
            active: Boolean(job?.line.track),
        });
        const jobGroup = new Adw.PreferencesGroup();
        jobGroup.add(name);
        jobGroup.add(command);
        jobGroup.add(track);

        const preset = new Adw.ComboRow({title: 'Repeat', model: Gtk.StringList.new(PRESETS.map(p => p.label))});
        const hour = new Adw.SpinRow({title: 'Hour', adjustment: new Gtk.Adjustment({lower: 0, upper: 23, step_increment: 1})});
        const minute = new Adw.SpinRow({title: 'Minute', adjustment: new Gtk.Adjustment({lower: 0, upper: 59, step_increment: 1})});
        const weekday = new Adw.ComboRow({title: 'Day of the week', model: Gtk.StringList.new(WEEKDAY_NAMES)});
        const day = new Adw.SpinRow({title: 'Day of the month', adjustment: new Gtk.Adjustment({lower: 1, upper: 31, step_increment: 1})});
        const expr = new Adw.EntryRow({title: 'Cron expression', text: job?.line.schedule ?? '0 9 * * *'});
        const preview = new Adw.ActionRow({title: '', use_markup: false});
        const scheduleGroup = new Adw.PreferencesGroup({title: 'Schedule'});
        for (const row of [preset, hour, minute, weekday, day, expr, preview])
            scheduleGroup.add(row);
        page.add(jobGroup);
        page.add(scheduleGroup);

        // The preset rows and the expression update each other; `syncing` stops the echo.
        let syncing = false;
        const showOptions = (p: Preset) => {
            hour.visible = p === 'daily' || p === 'weekly' || p === 'monthly';
            minute.visible = hour.visible || p === 'hourly';
            weekday.visible = p === 'weekly';
            day.visible = p === 'monthly';
        };
        const validity = () => {
            const scheduleError = validate(expr.text);
            const commandError = checkCommand(command.text);
            if (scheduleError) {
                expr.add_css_class('error');
                preview.title = scheduleError;
                preview.subtitle = '';
            } else {
                expr.remove_css_class('error');
                const now = new Date();
                const runs = nextRuns(expr.text, now, 5);
                preview.title = describe(expr.text);
                preview.subtitle = runs.length > 0 ? `Next: ${runs.map(d => formatWhen(d, now)).join(', ')}`
                    : expr.text.trim() === '@reboot' ? 'Runs when the computer starts' : 'Never runs: no date matches';
            }
            if (commandError && command.text !== '')
                command.add_css_class('error');
            else
                command.remove_css_class('error');
            save.sensitive = !scheduleError && !commandError;
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
            validity();
        };
        const fromExpr = () => {
            if (!syncing) {
                const {preset: p, options} = exprToPreset(expr.text);
                syncing = true;
                preset.selected = PRESETS.findIndex(x => x.id === p);
                hour.value = options.hour;
                minute.value = options.minute;
                day.value = options.day;
                weekday.selected = WEEKDAYS.indexOf(options.weekday);
                syncing = false;
                showOptions(p);
            }
            validity();
        };
        preset.connect('notify::selected', fromPreset);
        weekday.connect('notify::selected', fromPreset);
        for (const spin of [hour, minute, day])
            spin.connect('notify::value', fromPreset);
        expr.connect('changed', fromExpr);
        command.connect('changed', validity);
        fromExpr();

        const onSave = async () => {
            let tracking: Track | undefined;
            try {
                if (track.active)
                    tracking = {runner: installRunner(this.runnerSource), id: job?.line.track?.id ?? newTrackId()};
            } catch (e) {
                overlay.add_toast(toast(`Could not install cronboard-run: ${errorMessage(e)}`));
                return;
            }
            const fields: JobFields = {
                schedule: expr.text.trim().split(/\s+/).join(' '),
                command: command.text.trim(),
                name: name.text.replace(/\s+/g, ' ').trim() || null,
                track: tracking,
            };
            const error = await this.apply(lines => {
                // After a failed save the crontab is reloaded; make sure this is still the same line.
                if (job && lines[job.index]?.raw !== job.line.raw)
                    throw new Error('this job was changed outside Cronboard. Close this dialog and edit it again.');
                return job ? updateJob(lines, job.index, fields) : addJob(lines, fields);
            });
            if (error) {
                overlay.add_toast(toast(error));
                return;
            }
            const oldId = job?.line.track?.id;
            if (oldId && !tracking)
                forgetRuns(oldId);
            dialog.close();
        };
        save.connect('clicked', () => void onSave());
        cancel.connect('clicked', () => dialog.close());
        dialog.present(this.window);
    }
}

export default class CronboardPreferences extends ExtensionPreferences {
    override fillPreferencesWindow(window: Adw.PreferencesWindow): void {
        new JobsPage(window, this.dir.get_child('cronboard-run'));
    }
}
