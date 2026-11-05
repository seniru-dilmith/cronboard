// Everything that touches the system: reading and writing the crontab (with
// backups), running a job now, checking the cron service and reading tracked
// run statuses. Async only: this also runs inside gnome-shell, where a
// blocking call freezes the desktop.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {lineCommand, splitPercent, type Job} from './parser.ts';

const BACKUPS_KEPT = 20;

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

export interface Result {
    status: number;
    stdout: string;
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

async function run(argv: string[], input: string | null, cancellable: Gio.Cancellable | null,
    env: Record<string, string> = {}): Promise<Result> {
    const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE |
        (input === null ? Gio.SubprocessFlags.NONE : Gio.SubprocessFlags.STDIN_PIPE);
    const launcher = new Gio.SubprocessLauncher({flags});
    launcher.setenv('LC_ALL', 'C', true); // stable error messages to match on
    for (const [key, value] of Object.entries(env))
        launcher.setenv(key, value, true);
    const proc = launcher.spawnv(argv);
    const [, stdout, stderr] = await promise(cb => proc.communicate_utf8_async(input, cancellable, cb),
        r => proc.communicate_utf8_finish(r));
    return {status: proc.get_exit_status(), stdout: stdout ?? '', stderr: stderr ?? ''};
}

/** The current crontab text; '' when the user has none. */
export async function read(cancellable: Gio.Cancellable | null = null): Promise<string> {
    let r: Result;
    try {
        r = await run(['crontab', '-l'], null, cancellable);
    } catch (e) {
        if (e instanceof GLib.Error && e.matches(GLib.spawn_error_quark(), GLib.SpawnError.NOENT))
            throw new NotInstalledError();
        throw e;
    }
    if (r.status === 0)
        return r.stdout;
    if (r.stderr.startsWith('no crontab for '))
        return '';
    throw new Error(r.stderr.trim() || `crontab -l exited with status ${r.status}`);
}

/**
 * Installs `text` as the crontab, but only if the crontab still matches
 * `snapshot` (what the caller last read). The previous crontab is backed up first.
 * ponytail: the re-read and the install aren't atomic; flock(1) on a lock file would close that gap.
 */
export async function write(text: string, snapshot: string): Promise<void> {
    const current = await read();
    if (current !== snapshot)
        throw new ConflictError();
    if (text === current)
        return;
    if (current !== '')
        await backup(current);
    const input = text === '' || text.endsWith('\n') ? text : `${text}\n`; // cron needs a final newline
    // No cancellable on purpose: cutting stdin short would install a truncated crontab.
    const r = await run(['crontab', '-'], input, null);
    if (r.status !== 0)
        throw new Error(r.stderr.trim() || `crontab exited with status ${r.status}`);
}

async function backup(text: string): Promise<void> {
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'cronboard', 'backups']);
    if (GLib.mkdir_with_parents(dir, 0o700) !== 0)
        throw new Error(`Could not create the backup folder ${dir}`);
    const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S-%f');
    const file = Gio.File.new_for_path(GLib.build_filenamev([dir, `crontab-${stamp}.txt`]));
    // GJS turns the Uint8Array into a GLib.Bytes that lives as long as the write.
    await promise(cb => file.replace_contents_bytes_async(new TextEncoder().encode(text), null, false,
        Gio.FileCreateFlags.PRIVATE, null, cb), r => file.replace_contents_finish(r));
    await prune(Gio.File.new_for_path(dir));
}

async function prune(dir: Gio.File): Promise<void> {
    const enumerator = await promise(cb => dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT, null, cb), r => dir.enumerate_children_finish(r));
    const names: string[] = [];
    for (;;) {
        const infos = await promise(cb => enumerator.next_files_async(100, GLib.PRIORITY_DEFAULT, null, cb),
            r => enumerator.next_files_finish(r));
        if (infos.length === 0)
            break;
        names.push(...infos.map(info => info.get_name()));
    }
    const old = names.filter(n => /^crontab-.*\.txt$/.test(n)).sort().slice(0, -BACKUPS_KEPT);
    await Promise.all(old.map(n => {
        const file = dir.get_child(n);
        return promise(cb => file.delete_async(GLib.PRIORITY_DEFAULT, null, cb), r => file.delete_finish(r));
    }));
}

/**
 * Runs a job now the way cron would: a minimal environment plus the crontab's
 * own variables, through $SHELL -c, in a transient systemd user unit so it
 * isn't a child of gnome-shell. Its output goes to the user journal.
 * Resolves when the job ends; `status` is the job's exit status, and a
 * non-empty `stderr` means systemd-run itself failed (the job's output goes to the journal).
 */
export function runNow(job: Job, cancellable: Gio.Cancellable | null): Promise<Result> {
    const env: Record<string, string> = {
        HOME: GLib.get_home_dir(),
        LOGNAME: GLib.get_user_name(),
        USER: GLib.get_user_name(),
        SHELL: '/bin/sh',
        PATH: '/usr/bin:/bin',
        ...job.env,
    };
    const {cmd, stdin} = splitPercent(lineCommand(job.line));
    const command = stdin === null
        ? [env.SHELL, '-c', cmd]
        : [env.SHELL, '-c', 'printf "%s" "$1" | "$0" -c "$2"', env.SHELL, stdin.endsWith('\n') ? stdin : `${stdin}\n`, cmd];
    // systemd-run reaches the user's systemd over the user bus. Name it explicitly: shells started
    // with dbus-run-session (nested or test sessions) have a private session bus without systemd on it.
    const userBus = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'bus']);
    const busEnv: Record<string, string> = GLib.file_test(userBus, GLib.FileTest.EXISTS)
        ? {DBUS_SESSION_BUS_ADDRESS: `unix:path=${userBus}`} : {};
    return run(['systemd-run', '--user', '--wait', '--collect', '--quiet',
        `--unit=cronboard-run-${GLib.get_real_time()}`, `--working-directory=${env.HOME}`,
        '--', '/usr/bin/env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...command],
    null, cancellable, busEnv);
}

/** False when a known cron service exists but isn't running. */
export async function cronServiceActive(cancellable: Gio.Cancellable | null = null): Promise<boolean> {
    let r: Result;
    try {
        r = await run(['systemctl', 'is-active', 'cron.service', 'crond.service', 'cronie.service'], null, cancellable);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return true; // no systemctl: we can't tell, so don't warn
    }
    return /^active$/m.test(r.stdout);
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
