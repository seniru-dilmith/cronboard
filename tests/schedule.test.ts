// Run with TZ=UTC (npm test) so local-time results are deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {validate, nextRuns, describe, formatWhen, presetToExpr, exprToPreset} from '../src/lib/schedule.ts';

const at = (s: string) => new Date(s); // no offset = local time
const iso = (dates: Date[]) => dates.map(d => d.toISOString().slice(0, 16));
// 2026-11-01 is a Sunday.

test('validate accepts valid expressions', () => {
    for (const expr of ['* * * * *', '*/15 * * * *', '0 9 * * 1-5', '0 0 1 jan *', '30 4 * * SUN',
        '0 0 * * 7', '0 9-17/2 * * mon-fri', '5,35 * 1,15 * *', '@daily', '@reboot', '@annually'])
        assert.equal(validate(expr), null, expr);
});

test('validate rejects invalid expressions', () => {
    for (const expr of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *',
        '* * * 13 *', '* * * * 8', '5/10 * * * *', '*/0 * * * *', '5-1 * * * *', '* * * foo *',
        '@sometimes', '1,,2 * * * *'])
        assert.notEqual(validate(expr), null, expr);
});

test('nextRuns basics', () => {
    assert.deepEqual(iso(nextRuns('0 9 * * 1-5', at('2026-11-01T12:00'), 3)),
        ['2026-11-02T09:00', '2026-11-03T09:00', '2026-11-04T09:00']);
    assert.deepEqual(iso(nextRuns('* * * * *', at('2026-11-01T12:00:30'), 2)),
        ['2026-11-01T12:01', '2026-11-01T12:02']);
    assert.deepEqual(iso(nextRuns('0 8 * * 7', at('2026-11-01T12:00'), 1)), ['2026-11-08T08:00']);
    assert.deepEqual(iso(nextRuns('0 0 1 1 *', at('2026-11-01T12:00'), 1)), ['2027-01-01T00:00']);
    assert.deepEqual(nextRuns('@reboot', at('2026-11-01T12:00'), 3), []);
});

test('nextRuns: both day fields restricted means either matches', () => {
    assert.deepEqual(iso(nextRuns('0 0 3 * 5', at('2026-11-01T00:00'), 3)),
        ['2026-11-03T00:00', '2026-11-06T00:00', '2026-11-13T00:00']);
});

test('nextRuns: a day field starting with * means both must match', () => {
    assert.deepEqual(iso(nextRuns('0 0 */2 * 5', at('2026-11-01T00:00'), 3)),
        ['2026-11-13T00:00', '2026-11-27T00:00', '2026-12-11T00:00']);
});

test('nextRuns: rare and impossible dates', () => {
    assert.deepEqual(iso(nextRuns('0 0 29 2 *', at('2026-11-01T00:00'), 1)), ['2028-02-29T00:00']);
    assert.deepEqual(nextRuns('0 0 30 2 *', at('2026-11-01T00:00'), 1), []);
});

test('describe', () => {
    const cases: [string, string][] = [
        ['* * * * *', 'every minute'],
        ['*/15 * * * *', 'every 15 minutes'],
        ['0 * * * *', 'every hour'],
        ['30 * * * *', 'every hour at :30'],
        ['0 */2 * * *', 'every 2 hours'],
        ['0 9 * * *', 'every day at 09:00'],
        ['0 9 * * 1-5', 'every weekday at 09:00'],
        ['30 18 * * mon,wed,fri', 'every Monday, Wednesday and Friday at 18:30'],
        ['0 0 * * 0', 'every Sunday at 00:00'],
        ['0 0 1 * *', 'on the 1st of every month at 00:00'],
        ['@yearly', 'on the 1st of January at 00:00'],
        ['0 9,17 * * *', 'every day at 09:00 and 17:00'],
        ['*/10 * * * 1-5', 'every 10 minutes on weekdays'],
        ['0 9 * 6 *', 'every day at 09:00 in June'],
        ['0 9 13 * 5', 'on the 13th of every month and every Friday at 09:00'],
        ['@reboot', 'at startup'],
        ['not valid', 'not valid'],
    ];
    for (const [expr, text] of cases)
        assert.equal(describe(expr), text, expr);
});

test('formatWhen', () => {
    const now = at('2026-11-01T12:00');
    assert.equal(formatWhen(at('2026-11-01T18:05'), now), 'today 18:05');
    assert.equal(formatWhen(at('2026-11-02T09:00'), now), 'tomorrow 09:00');
    assert.equal(formatWhen(at('2026-10-31T09:00'), now), 'yesterday 09:00');
    assert.equal(formatWhen(at('2026-11-05T09:00'), now), 'Thu 09:00');
    assert.equal(formatWhen(at('2026-12-24T09:00'), now), '24 Dec 09:00');
    assert.equal(formatWhen(at('2027-01-01T00:00'), now), '1 Jan 2027 00:00');
});

test('presets round-trip', () => {
    const options = {minute: 15, hour: 7, weekday: 3, day: 20};
    for (const preset of ['minute', 'hourly', 'daily', 'weekly', 'monthly', 'reboot'] as const) {
        const expr = presetToExpr(preset, options);
        assert.equal(validate(expr), null, expr);
        assert.equal(exprToPreset(expr).preset, preset, expr);
    }
    assert.deepEqual(exprToPreset('15 7 * * 3'), {preset: 'weekly', options: {minute: 15, hour: 7, weekday: 3, day: 1}});
    assert.equal(exprToPreset('@daily').preset, 'daily');
    assert.equal(exprToPreset('0 9 * * 1-5').preset, 'custom');
    assert.equal(exprToPreset('0 0 1 1 *').preset, 'custom');
});
