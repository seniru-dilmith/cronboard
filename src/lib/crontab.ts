// Everything that touches the system: reading and writing the crontab, running a
// job now, checking the cron service and reading tracked run statuses. The
// crontab and job running go through the Cronboard service over the session
// D-Bus (the extension never starts programs itself). Async only: this also
// runs inside gnome-shell, where a blocking call freezes the desktop.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {lineCommand, splitPercent, type Job} from './parser.ts';

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

export interface Result {
    status: number;
    stderr: string;
}

export interface RunStatus {
    exit: number;
    finished: Date;
}

export function errorMessage(e: unknown): string {
    return e instanceof Error || e instanceof GLib.Error ? e.message : String(e);
}

export function isCancelled(e: unknown): boolean {
    return e instanceof GLib.Error && e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED);
}

/** Where tracked jobs record their last run (the tracked command in parser.ts writes there). */
export function stateDir(): string {
    return GLib.build_filenamev([GLib.get_user_state_dir(), 'cronboard']);
}

/** Calls a method of the Cronboard service; the bus starts the service if it is registered for activation. */
async function call(method: string, args: unknown, replyType: string,
    cancellable: Gio.Cancellable | null, timeout = -1): Promise<GLib.Variant> {
    const bus = await promise(cb => Gio.bus_get(Gio.BusType.SESSION, cancellable, cb), r => Gio.bus_get_finish(r));
    try {
        return await promise(cb => bus.call(SERVICE, SERVICE_PATH, SERVICE, method, args as never, GLib.VariantType.new(replyType) as never,
            Gio.DBusCallFlags.NONE, timeout, cancellable, cb), r => bus.call_finish(r));
    } catch (e) {
        if (!(e instanceof GLib.Error))
            throw e;
        if (e.matches(Gio.dbus_error_quark(), Gio.DBusError.SERVICE_UNKNOWN) ||
            e.matches(Gio.dbus_error_quark(), Gio.DBusError.NAME_HAS_NO_OWNER))
            throw new ServiceMissingError();
        // Errors raised by the service arrive as remote errors named after what went wrong.
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

/** The current crontab text; '' when the user has none. */
export async function read(cancellable: Gio.Cancellable | null = null): Promise<string> {
    const [text] = (await call('Read', null, '(s)', cancellable)).deepUnpack<[string]>();
    return text;
}

/**
 * Installs `text` as the crontab, but only if the crontab still matches
 * `snapshot` (what the caller last read). The service backs up the previous one first.
 */
export async function write(text: string, snapshot: string): Promise<void> {
    // No cancellable on purpose: cutting the call short could leave the caller unsure whether it was saved.
    await call('Write', new GLib.Variant('(ss)', [text, snapshot]), '()', null);
}

/**
 * Runs a job now the way cron would: a minimal environment plus the crontab's
 * own variables, through $SHELL -c, in a transient systemd user unit (started by
 * the service) so it isn't a child of gnome-shell. Its output goes to the user journal.
 * Resolves when the job ends; `status` is the job's exit status, and a
 * non-empty `stderr` means systemd-run itself failed (the job's output goes to the journal).
 */
export async function runNow(job: Job, cancellable: Gio.Cancellable | null): Promise<Result> {
    const env: Record<string, string> = {
        HOME: GLib.get_home_dir(),
        LOGNAME: GLib.get_user_name(),
        USER: GLib.get_user_name(),
        SHELL: '/bin/sh',
        PATH: '/usr/bin:/bin',
        ...job.env,
    };
    const {cmd, stdin} = splitPercent(lineCommand(job.line));
    const argv = stdin === null
        ? [env.SHELL, '-c', cmd]
        : [env.SHELL, '-c', 'printf "%s" "$1" | "$0" -c "$2"', env.SHELL, stdin.endsWith('\n') ? stdin : `${stdin}\n`, cmd];
    const [status, stderr] = (await call('Run', new GLib.Variant('(asa{ss})', [argv, env]), '(is)', cancellable, NO_TIMEOUT))
        .deepUnpack<[number, string]>();
    return {status, stderr};
}

/** False when a known cron service exists but isn't running. */
export async function cronServiceActive(cancellable: Gio.Cancellable | null = null): Promise<boolean> {
    const [active] = (await call('CronActive', null, '(b)', cancellable)).deepUnpack<[boolean]>();
    return active;
}

/** Last recorded run of a tracked job, or null if none (the status is informational, so errors count as none). */
export async function readStatus(id: string, cancellable: Gio.Cancellable | null): Promise<RunStatus | null> {
    try {
        const file = Gio.File.new_for_path(GLib.build_filenamev([stateDir(), `${id}.status`]));
        const [, bytes] = await promise(cb => file.load_contents_async(cancellable, cb),
            r => file.load_contents_finish(r));
        const [exit, finished] = new TextDecoder().decode(bytes).trim().split(/\s+/).map(Number);
        return Number.isInteger(exit) && Number.isFinite(finished) ? {exit, finished: new Date(finished * 1000)} : null;
    } catch {
        return null;
    }
}

export async function readStatuses(ids: string[], cancellable: Gio.Cancellable | null): Promise<Map<string, RunStatus>> {
    const statuses = new Map<string, RunStatus>();
    await Promise.all(ids.map(async id => {
        const status = await readStatus(id, cancellable);
        if (status)
            statuses.set(id, status);
    }));
    return statuses;
}
