// Cron schedules: validation, next run times, readable descriptions and the
// editor presets. Pure code (no gi:// imports) so it also runs under Node tests.

export const SPECIALS: Readonly<Record<string, string>> = {
    '@reboot': '',
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
    '@monthly': '0 0 1 * *',
    '@weekly': '0 0 * * 0',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@hourly': '0 * * * *',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Field {
    name: string;
    min: number;
    max: number;
    names?: string[];
    first?: number; // value of names[0]
}

const FIELDS: Field[] = [
    {name: 'minute', min: 0, max: 59},
    {name: 'hour', min: 0, max: 23},
    {name: 'day of month', min: 1, max: 31},
    {name: 'month', min: 1, max: 12, names: MONTHS, first: 1},
    {name: 'day of week', min: 0, max: 7, names: WEEKDAYS, first: 0},
];

export interface Cron {
    reboot: boolean;
    minute: Set<number>;
    hour: Set<number>;
    dom: Set<number>;
    month: Set<number>;
    dow: Set<number>;
    // Vixie cron rule: if either day field starts with '*', a day must match
    // both fields; if both are restricted, matching either one is enough.
    domStar: boolean;
    dowStar: boolean;
}

const sorted = (values: Iterable<number>) => [...values].sort((a, b) => a - b);

function expand(expr: string): string[] {
    return (Object.hasOwn(SPECIALS, expr) ? SPECIALS[expr] : expr).split(/\s+/);
}

function value(token: string, f: Field): number {
    if (/^\d+$/.test(token))
        return Number(token);
    const i = f.names?.findIndex(n => n.slice(0, 3).toLowerCase() === token.toLowerCase()) ?? -1;
    return i < 0 ? NaN : i + (f.first ?? 0);
}

function parseField(text: string, f: Field): Set<number> | string {
    const out = new Set<number>();
    for (const part of text.split(',')) {
        const m = /^(?:\*|(\w+)(?:-(\w+))?)(?:\/(\d+))?$/.exec(part);
        if (!m)
            return `Invalid ${f.name}: "${part}"`;
        const [, from, to, stepText] = m;
        // ponytail: "N/S" (a step without a range) is rejected; some crons accept it as N-max/S.
        if (from !== undefined && to === undefined && stepText !== undefined)
            return `Invalid ${f.name}: "${part}" (a step needs a range or *)`;
        const lo = from === undefined ? f.min : value(from, f);
        const hi = from === undefined ? f.max : to === undefined ? lo : value(to, f);
        const step = stepText === undefined ? 1 : Number(stepText);
        if (Number.isNaN(lo) || Number.isNaN(hi) || lo < f.min || hi > f.max || lo > hi)
            return `Invalid ${f.name}: "${part}" (allowed ${f.min}-${f.max})`;
        if (step < 1)
            return `Invalid ${f.name}: "${part}" (step must be at least 1)`;
        for (let v = lo; v <= hi; v += step)
            out.add(v);
    }
    return out;
}

/** Parses a 5-field expression or @special. Returns an error message on failure. */
export function parseSchedule(expr: string): Cron | string {
    const text = expr.trim();
    if (text === '@reboot') {
        return {reboot: true, minute: new Set(), hour: new Set(), dom: new Set(),
            month: new Set(), dow: new Set(), domStar: false, dowStar: false};
    }
    if (text.startsWith('@') && !Object.hasOwn(SPECIALS, text))
        return `Unknown schedule "${text}"`;
    const fields = expand(text);
    if (fields.length !== 5)
        return 'A cron expression needs 5 fields: minute, hour, day of month, month, day of week';
    const sets: Set<number>[] = [];
    for (let i = 0; i < 5; i++) {
        const set = parseField(fields[i], FIELDS[i]);
        if (typeof set === 'string')
            return set;
        sets.push(set);
    }
    const [minute, hour, dom, month, dow] = sets;
    if (dow.has(7))
        dow.add(0);
    return {reboot: false, minute, hour, dom, month, dow,
        domStar: fields[2].startsWith('*'), dowStar: fields[4].startsWith('*')};
}

/** Returns null when the expression is valid, otherwise an error message. */
export function validate(expr: string): string | null {
    const cron = parseSchedule(expr);
    return typeof cron === 'string' ? cron : null;
}

function dayMatches(c: Cron, d: Date): boolean {
    const dom = c.dom.has(d.getDate());
    const dow = c.dow.has(d.getDay());
    return c.domStar || c.dowStar ? dom && dow : dom || dow;
}

const SEARCH_LIMIT_MS = 5 * 366 * 24 * 3600 * 1000;

/**
 * The next `count` run times strictly after `from`, in local time.
 * ponytail: cron's DST special cases are ignored; these times are for display.
 */
export function nextRuns(expr: string, from: Date, count: number): Date[] {
    const c = parseSchedule(expr);
    if (typeof c === 'string' || c.reboot)
        return [];
    const runs: Date[] = [];
    const d = new Date(from.getTime());
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    const limit = from.getTime() + SEARCH_LIMIT_MS;
    while (runs.length < count && d.getTime() < limit) {
        if (!c.month.has(d.getMonth() + 1)) {
            d.setMonth(d.getMonth() + 1, 1);
            d.setHours(0, 0);
        } else if (!dayMatches(c, d)) {
            d.setDate(d.getDate() + 1);
            d.setHours(0, 0);
        } else if (!c.hour.has(d.getHours())) {
            d.setHours(d.getHours() + 1, 0);
        } else if (!c.minute.has(d.getMinutes())) {
            d.setMinutes(d.getMinutes() + 1);
        } else {
            runs.push(new Date(d.getTime()));
            d.setMinutes(d.getMinutes() + 1);
        }
    }
    return runs;
}

const pad = (n: number) => String(n).padStart(2, '0');
const num = (s: string) => /^\d+$/.test(s) ? Number(s) : null;
const stepOf = (s: string) => /^\*\/(\d+)$/.exec(s)?.[1];
const rangeOf = (s: string) => /^(\d+)-(\d+)$/.exec(s);

function list(items: string[]): string {
    return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function every(n: number, unit: string): string {
    return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}

function ordinal(n: number): string {
    const teen = n % 100 >= 11 && n % 100 <= 13;
    return n + (teen ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
}

// Schedules that repeat within a day: "every 15 minutes", "every 2 hours at :30".
function timePhrase(mi: string, h: string): string {
    const M = num(mi), H = num(h);
    const mStep = stepOf(mi), hStep = stepOf(h), hRange = rangeOf(h);
    const minutes = mi === '*' ? 'every minute' : mStep ? every(Number(mStep), 'minute') : null;
    if (minutes && h === '*')
        return minutes;
    if (minutes && H !== null)
        return `${minutes} from ${pad(H)}:00 to ${pad(H)}:59`;
    if (minutes && hRange)
        return `${minutes} from ${pad(Number(hRange[1]))}:00 to ${pad(Number(hRange[2]))}:59`;
    const past = M ? ` at :${pad(M)}` : '';
    if (M !== null && h === '*')
        return `every hour${past}`;
    if (M !== null && hStep)
        return `${every(Number(hStep), 'hour')}${past}`;
    if (M !== null && hRange)
        return `every hour from ${pad(Number(hRange[1]))}:${pad(M)} to ${pad(Number(hRange[2]))}:${pad(M)}`;
    return `at minute ${mi} past hour ${h}`;
}

// "every weekday" / "on weekdays", "on the 1st of every month", ...
function dayPhrase(c: Cron, dom: string, dow: string, months: string): {every: string; on: string} {
    if (dom === '*' && dow === '*')
        return {every: 'every day', on: ''};
    const weekdays = [...new Set([...c.dow].map(d => d % 7))].sort((a, b) => (a + 6) % 7 - (b + 6) % 7);
    const workweek = weekdays.join() === '1,2,3,4,5';
    const names = list(weekdays.map(d => WEEKDAYS[d]));
    const dowEvery = workweek ? 'every weekday' : `every ${names}`;
    const dowOn = workweek ? 'on weekdays' : `on ${names}`;
    if (dom === '*')
        return {every: dowEvery, on: dowOn};
    const domText = c.dom.size <= 5 ? `the ${list(sorted(c.dom).map(ordinal))}` : `day ${dom}`;
    const onDom = `on ${domText} of ${months || 'every month'}`;
    if (dow === '*')
        return {every: onDom, on: onDom};
    if (c.domStar || c.dowStar)
        return {every: `${onDom}, only ${dowOn}`, on: `${onDom}, only ${dowOn}`};
    return {every: `${onDom} and ${dowEvery}`, on: `${onDom} and ${dowOn}`};
}

/** Human-readable text, e.g. "every weekday at 09:00". Invalid input is returned as is. */
export function describe(expr: string): string {
    const text = expr.trim();
    const c = parseSchedule(text);
    if (typeof c === 'string')
        return text;
    if (c.reboot)
        return 'at startup';
    const [mi, h, dom, mon, dow] = expand(text);
    const months = mon === '*' ? '' : list(sorted(c.month).map(m => MONTHS[m - 1]));
    const days = dayPhrase(c, dom, dow, months);
    const inMonths = months && dom === '*' ? ` in ${months}` : '';
    const M = num(mi), H = num(h);
    if (M !== null && H !== null)
        return `${days.every} at ${pad(H)}:${pad(M)}${inMonths}`;
    if (M !== null && /^\d+(,\d+)+$/.test(h) && c.hour.size <= 4)
        return `${days.every} at ${list(sorted(c.hour).map(x => `${pad(x)}:${pad(M)}`))}${inMonths}`;
    return `${timePhrase(mi, h)}${days.on ? ` ${days.on}` : ''}${inMonths}`;
}

/** Short relative date: "today 09:00", "tomorrow 09:00", "Mon 09:00", "12 Nov 09:00". */
export function formatWhen(date: Date, now: Date): string {
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((midnight(date) - midnight(now)) / 86400000);
    if (days === 0)
        return `today ${time}`;
    if (days === 1)
        return `tomorrow ${time}`;
    if (days === -1)
        return `yesterday ${time}`;
    if (Math.abs(days) < 7)
        return `${WEEKDAYS[date.getDay()].slice(0, 3)} ${time}`;
    const year = date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`;
    return `${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)}${year} ${time}`;
}

export type Preset = 'minute' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'reboot' | 'custom';

export interface PresetOptions {
    minute: number;
    hour: number;
    weekday: number; // 0 = Sunday
    day: number;
}

export function presetToExpr(preset: Exclude<Preset, 'custom'>, o: PresetOptions): string {
    switch (preset) {
    case 'minute': return '* * * * *';
    case 'hourly': return `${o.minute} * * * *`;
    case 'daily': return `${o.minute} ${o.hour} * * *`;
    case 'weekly': return `${o.minute} ${o.hour} * * ${o.weekday}`;
    case 'monthly': return `${o.minute} ${o.hour} ${o.day} * *`;
    case 'reboot': return '@reboot';
    }
}

/** Which preset (and options) an expression corresponds to; 'custom' if none. */
export function exprToPreset(expr: string): {preset: Preset; options: PresetOptions} {
    const options = {minute: 0, hour: 9, weekday: 1, day: 1};
    const text = expr.trim();
    if (text === '@reboot')
        return {preset: 'reboot', options};
    if (validate(text) !== null)
        return {preset: 'custom', options};
    const fields = expand(text);
    if (fields.join(' ') === '* * * * *')
        return {preset: 'minute', options};
    const [mi, h, dom, mon, dow] = fields;
    const minute = num(mi), hour = num(h), day = num(dom), weekday = num(dow);
    if (minute === null || mon !== '*')
        return {preset: 'custom', options};
    options.minute = minute;
    if (h === '*' && dom === '*' && dow === '*')
        return {preset: 'hourly', options};
    if (hour === null)
        return {preset: 'custom', options};
    options.hour = hour;
    if (dom === '*' && dow === '*')
        return {preset: 'daily', options};
    if (dom === '*' && weekday !== null) {
        options.weekday = weekday % 7;
        return {preset: 'weekly', options};
    }
    if (dow === '*' && day !== null) {
        options.day = day;
        return {preset: 'monthly', options};
    }
    return {preset: 'custom', options};
}
