// Crontab text <-> lines. Every line keeps its raw text and only the lines the
// user edits are rewritten, so everything Cronboard doesn't manage (comments,
// blank lines, env vars, lines it can't parse) survives byte for byte.
// Pure code (no gi:// imports) so it also runs under Node tests.

import {validate} from './schedule.ts';

export const DISABLED_MARKER = '#cronboard-disabled# ';

export interface Track {
    runner: string; // absolute path of cronboard-run
    id: string;
}

export interface JobLine {
    kind: 'job';
    raw: string;
    schedule: string;
    command: string;
    enabled: boolean;
    track?: Track;
}

export type Line =
    | JobLine
    | {kind: 'env'; raw: string; key: string; value: string}
    | {kind: 'other'; raw: string};

export interface Job {
    index: number;
    line: JobLine;
    name: string | null;
    env: Record<string, string>; // variables in effect at this job's position
}

export interface JobFields {
    schedule: string;
    command: string;
    name: string | null;
    track?: Track;
}

const ENV = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
// Tracked jobs run through the wrapper: <runner> <id> '<command>'
const TRACKED = /^(\S+\/cronboard-run) ([0-9a-f]+) '((?:[^']|'\\'')*)'$/;

function unquote(value: string): string {
    const q = value[0];
    return value.length >= 2 && (q === '"' || q === "'") && value.endsWith(q) ? value.slice(1, -1) : value;
}

function parseJob(text: string): Omit<JobLine, 'kind' | 'raw' | 'enabled'> | null {
    const body = text.replace(/^\s+/, '');
    const m = body.startsWith('@')
        ? /^(@\w+)\s+(\S.*)$/.exec(body)
        : /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S.*)$/.exec(body);
    if (!m || validate(m[1]) !== null)
        return null;
    const schedule = m[1].split(/\s+/).join(' ');
    const t = TRACKED.exec(m[2]);
    if (!t)
        return {schedule, command: m[2]};
    return {schedule, command: t[3].replaceAll("'\\''", "'"), track: {runner: t[1], id: t[2]}};
}

// Same order as Debian cron: env assignment first, then job, else leave it alone.
function parseLine(raw: string): Line {
    const env = ENV.exec(raw);
    if (env)
        return {kind: 'env', raw, key: env[1], value: unquote(env[2])};
    const enabled = !raw.startsWith(DISABLED_MARKER);
    const job = parseJob(enabled ? raw : raw.slice(DISABLED_MARKER.length));
    return job ? {kind: 'job', raw, enabled, ...job} : {kind: 'other', raw};
}

export function parse(text: string): Line[] {
    return text.split('\n').map(parseLine);
}

export function serialize(lines: Line[]): string {
    return lines.map(l => l.raw).join('\n');
}

// A job's name is the plain comment directly above it.
function nameAt(lines: Line[], index: number): string | null {
    const prev = lines[index - 1];
    if (prev?.kind !== 'other' || prev.raw.startsWith(DISABLED_MARKER))
        return null;
    return /^\s*#\s*(\S.*?)\s*$/.exec(prev.raw)?.[1] ?? null;
}

export function jobs(lines: Line[]): Job[] {
    const env: Record<string, string> = {};
    const out: Job[] = [];
    lines.forEach((line, index) => {
        if (line.kind === 'env')
            env[line.key] = line.value;
        else if (line.kind === 'job')
            out.push({index, line, name: nameAt(lines, index), env: {...env}});
    });
    return out;
}

/** The command part of the line as cron sees it (wrapped when tracked). */
export function lineCommand(f: {command: string; track?: Track}): string {
    if (!f.track)
        return f.command;
    return `${f.track.runner} ${f.track.id} '${f.command.replaceAll("'", "'\\''")}'`;
}

export function formatJob(f: JobFields, enabled = true): string {
    return `${enabled ? '' : DISABLED_MARKER}${f.schedule} ${lineCommand(f)}`;
}

/** Null if the command can go on a crontab line, otherwise why not. */
export function checkCommand(command: string): string | null {
    if (!command.trim())
        return 'Enter a command';
    if (/[\r\n]/.test(command))
        return 'The command must be a single line';
    return null;
}

/**
 * The file a command sends its output to (`cmd >> file` or `cmd > file`), as an absolute path,
 * or null if it has none. Cron runs jobs from $HOME, so relative paths and `~` resolve there.
 * ponytail: paths with other variables in them (`$LOGDIR/x.log`) are skipped rather than guessed.
 */
export function logFile(command: string, home: string): string | null {
    const redirect = /(?:^|[^\d&<>])>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
    for (const m of command.matchAll(redirect)) {
        let path = (m[1] ?? m[2] ?? m[3]).replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, home);
        if (path === '/dev/null' || path.includes('$'))
            continue;
        if (!path.startsWith('/'))
            path = `${home}/${path}`;
        return path;
    }
    return null;
}

// A trailing `>> file 2>&1`, the form the editor's Log file field writes.
const LOG_SUFFIX = /\s+>>\s*((?:\\.|[^\s;&|<>'"\\]|'[^']*'|"[^"]*")+)\s+2>&1\s*$/;

/** Splits the editor's log file off a command, or returns log null if it doesn't end in one. */
export function splitLog(command: string): {command: string; log: string | null} {
    const m = LOG_SUFFIX.exec(command);
    if (!m)
        return {command, log: null};
    return {command: command.slice(0, m.index), log: m[1].replace(/'([^']*)'|"([^"]*)"|\\(.)/g, '$1$2$3')};
}

/** Appends `>> log 2>&1`, quoting the path when needed but keeping a leading `~/` so the shell expands it. */
export function withLog(command: string, log: string): string {
    log = log.trim();
    if (!log)
        return command;
    const quote = (s: string) => /^[\w./+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
    const path = log.startsWith('~/') ? `~/${quote(log.slice(2))}` : quote(log);
    return `${command} >> ${path} 2>&1`;
}

/** A log file for a new job, named after the job or its program. */
export function defaultLog(name: string, command: string): string {
    const program = command.trim().split(/\s+/)[0]?.split('/').pop()?.replace(/\.\w+$/, '') ?? '';
    const slug = (name.trim() || program).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `~/.local/state/cronboard/logs/${slug || 'job'}.log`;
}

function spliced(lines: Line[], start: number, remove: number, ...add: string[]): Line[] {
    const copy = lines.slice();
    copy.splice(start, remove, ...add.map(parseLine));
    return copy;
}

function jobAt(lines: Line[], index: number): JobLine {
    const line = lines[index];
    if (line?.kind !== 'job')
        throw new Error(`Line ${index + 1} is not a cron job`);
    return line;
}

/** Adds or strips the disabled marker; toggling back is byte-exact. */
export function setEnabled(lines: Line[], index: number, enabled: boolean): Line[] {
    const line = jobAt(lines, index);
    if (line.enabled === enabled)
        return lines;
    const raw = enabled ? line.raw.slice(DISABLED_MARKER.length) : DISABLED_MARKER + line.raw;
    return spliced(lines, index, 1, raw);
}

/** Rewrites a job and its name comment, keeping raw text for whatever didn't change. */
export function updateJob(lines: Line[], index: number, f: JobFields): Line[] {
    const line = jobAt(lines, index);
    const oldName = nameAt(lines, index);
    const same = line.schedule === f.schedule && line.command === f.command &&
        line.track?.id === f.track?.id && line.track?.runner === f.track?.runner;
    const job = same ? line.raw : formatJob(f, line.enabled);
    const name = !f.name ? [] : f.name === oldName ? [lines[index - 1].raw] : [`# ${f.name}`];
    return oldName !== null
        ? spliced(lines, index - 1, 2, ...name, job)
        : spliced(lines, index, 1, ...name, job);
}

/** Appends a job (new jobs inherit the env vars set above them). */
export function addJob(lines: Line[], f: JobFields): Line[] {
    // Insert before the final empty element so a trailing newline stays last.
    const end = lines.length > 0 && lines[lines.length - 1].raw === '' ? lines.length - 1 : lines.length;
    return spliced(lines, end, 0, ...(f.name ? [`# ${f.name}`] : []), formatJob(f));
}

export function deleteJob(lines: Line[], index: number): Line[] {
    jobAt(lines, index);
    return nameAt(lines, index) !== null ? spliced(lines, index - 1, 2) : spliced(lines, index, 1);
}

/**
 * Cron's % rule: text after the first unescaped % is fed to the command on
 * stdin, with any further % turned into newlines; \% is a literal %.
 */
export function splitPercent(command: string): {cmd: string; stdin: string | null} {
    let cmd = '';
    let stdin: string | null = null;
    for (let i = 0; i < command.length; i++) {
        let c = command[i];
        if (c === '\\' && command[i + 1] === '%') {
            c = '%';
            i++;
        } else if (c === '%') {
            if (stdin === null) {
                stdin = '';
                continue;
            }
            c = '\n';
        }
        if (stdin === null)
            cmd += c;
        else
            stdin += c;
    }
    return {cmd, stdin};
}
