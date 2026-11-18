// The Cronboard service, over the session D-Bus. It owns the crontab and all the
// job logic; the extension and the preferences only show what it returns and send
// actions back. Async only: this also runs inside gnome-shell, where a blocking
// call freezes the desktop.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SERVICE = 'io.github.seniru_dilmith.Cronboard';
const SERVICE_PATH = '/io/github/seniru_dilmith/Cronboard';
const NO_TIMEOUT = 0x7fffffff; // a job run lasts as long as the job; the default would give up after 25 s

// Wraps a GIO *_async/*_finish pair in a Promise. Used instead of
// Gio._promisify because the @girs types only declare the callback form.
function promise<T>(start: (callback: (source: unknown, result: Gio.AsyncResult) => void) => void,
    finish: (result: Gio.AsyncResult) => T): Promise<T> {
    return new Promise((resolve, reject) => start((_source, result) => {
        try {
            resolve(finish(result));
        } catch (e) {
            reject(e);
        }
    }));
}

export class ConflictError extends Error {
    constructor() {
        super('The crontab changed outside Cronboard, so nothing was saved. Check the list and try again.');
    }
}

export class NotInstalledError extends Error {
    constructor() {
        super('cron is not installed: the crontab command was not found.');
    }
}

export class ServiceMissingError extends Error {
    constructor() {
        super('The Cronboard service is not running. Install it with "pipx install cronboard-service" and then run "cronboard-service install".');
    }
}

/** A job as the service lists it; the texts are ready to show. */
export interface Job {
    id: string; // changes whenever the job's line changes, so a stale id is refused
    name: string; // '' when it has none
    command: string;
    edit_command: string; // command and log file as the editor shows them
    edit_log: string;
    schedule: string;
    description: string; // "every weekday at 09:00"
    next_run: string; // "tomorrow 09:00", '' when it won't run
    enabled: boolean;
    tracked: boolean;
    last_run: string; // tracked jobs only, '' before the first run
    last_exit: number;
    log_paths: string[];
}

/** What the editor sends for a new or changed job. */
export interface JobFields {
    name: string;
    command: string;
    log: string;
    schedule: string;
    tracked: boolean;
}

/** What the editor shows about the schedule being typed. */
export interface ScheduleCheck {
    error: string; // '' when valid
    description: string;
    next: string;
    preset: string;
    minute: number;
    hour: number;
    weekday: number;
    day: number;
}

export interface Result {
    status: number;
    stderr: string;
}

export function errorMessage(e: unknown): string {
    return e instanceof Error || e instanceof GLib.Error ? e.message : String(e);
}

export function isCancelled(e: unknown): boolean {
    return e instanceof GLib.Error && e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED);
}

const bus = (cancellable: Gio.Cancellable | null) =>
    promise(cb => Gio.bus_get(Gio.BusType.SESSION, cancellable, cb), r => Gio.bus_get_finish(r));

/** Calls a method of the Cronboard service; the bus starts the service if it is registered for activation. */
async function call(method: string, args: GLib.Variant | null, replyType: string,
    cancellable: Gio.Cancellable | null = null, timeout = -1): Promise<GLib.Variant> {
    const connection = await bus(cancellable);
    try {
        return await promise(cb => connection.call(SERVICE, SERVICE_PATH, SERVICE, method, args as never, GLib.VariantType.new(replyType) as never,
            Gio.DBusCallFlags.NONE, timeout, cancellable, cb), r => connection.call_finish(r));
    } catch (e) {
        if (!(e instanceof GLib.Error))
            throw e;
        if (e.matches(Gio.dbus_error_quark(), Gio.DBusError.SERVICE_UNKNOWN) ||
            e.matches(Gio.dbus_error_quark(), Gio.DBusError.NAME_HAS_NO_OWNER))
            throw new ServiceMissingError();
        // Errors raised by the service arrive as remote errors named after what went wrong;
        // the rest (an invalid schedule, say) carry a message that is shown as is.
        // The cast only bridges two copies of the GLib typings in @girs; at runtime it's the same GLib.Error.
        const remote = e as unknown as Parameters<typeof Gio.DBusError.get_remote_error>[0];
        const name = Gio.DBusError.get_remote_error(remote);
        Gio.DBusError.strip_remote_error(remote);
        if (name === `${SERVICE}.Error.Conflict`)
            throw new ConflictError();
        if (name === `${SERVICE}.Error.NotInstalled`)
            throw new NotInstalledError();
        throw e;
    }
}

const dict = (fields: JobFields) => Object.fromEntries(Object.entries(fields).map(([key, value]) =>
    [key, new GLib.Variant(typeof value === 'boolean' ? 'b' : 's', value)]));

export async function listJobs(cancellable: Gio.Cancellable | null = null): Promise<Job[]> {
    const [jobs] = (await call('ListJobs', null, '(aa{sv})', cancellable)).recursiveUnpack() as [Job[]];
    return jobs;
}

// No cancellable on the changes on purpose: cutting the call short could leave the caller unsure whether it was saved.
export async function setEnabled(id: string, enabled: boolean): Promise<void> {
    await call('SetEnabled', new GLib.Variant('(sb)', [id, enabled]), '()');
}

export async function addJob(fields: JobFields): Promise<void> {
    await call('AddJob', new GLib.Variant('(a{sv})', [dict(fields)]), '()');
}

export async function updateJob(id: string, fields: JobFields): Promise<void> {
    await call('UpdateJob', new GLib.Variant('(sa{sv})', [id, dict(fields)]), '()');
}

export async function deleteJob(id: string): Promise<void> {
    await call('DeleteJob', new GLib.Variant('(s)', [id]), '()');
}

/**
 * Runs a job now the way cron would, in a transient systemd user unit started by the service.
 * Resolves when the job ends; `status` is the job's exit status, and a non-empty `stderr`
 * means systemd-run itself failed (the job's output goes to the journal).
 */
export async function runNow(id: string, cancellable: Gio.Cancellable | null): Promise<Result> {
    const [status, stderr] = (await call('RunNow', new GLib.Variant('(s)', [id]), '(is)', cancellable, NO_TIMEOUT))
        .deepUnpack<[number, string]>();
    return {status, stderr};
}

export async function checkSchedule(expr: string): Promise<ScheduleCheck> {
    const [check] = (await call('CheckSchedule', new GLib.Variant('(s)', [expr]), '(a{sv})')).recursiveUnpack() as [ScheduleCheck];
    return check;
}

/** False when a known cron service exists but isn't running. */
export async function cronServiceActive(cancellable: Gio.Cancellable | null = null): Promise<boolean> {
    const [active] = (await call('CronActive', null, '(b)', cancellable)).deepUnpack<[boolean]>();
    return active;
}

/** Calls `callback` whenever the jobs change (a save, or a tracked job finishing). Resolves to the unsubscribe. */
export async function watchJobs(callback: () => void, cancellable: Gio.Cancellable | null): Promise<() => void> {
    const connection = await bus(cancellable);
    const id = connection.signal_subscribe(SERVICE, SERVICE, 'JobsChanged', SERVICE_PATH, null,
        Gio.DBusSignalFlags.NONE, () => callback());
    return () => connection.signal_unsubscribe(id);
}
