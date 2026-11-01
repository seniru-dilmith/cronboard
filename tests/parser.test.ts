import test from 'node:test';
import assert from 'node:assert/strict';
import {parse, serialize, jobs, setEnabled, updateJob, addJob, deleteJob, splitPercent, DISABLED_MARKER}
    from '../src/lib/parser.ts';

const RUNNER = '/home/me/.local/share/cronboard/cronboard-run';
const SAMPLE_LINES = [
    '# m h  dom mon dow   command',                                              // 0
    'SHELL=/bin/bash',                                                           // 1
    'MAILTO = "me@example.com"',                                                 // 2
    'PATH=/usr/local/bin:/usr/bin:/bin',                                         // 3
    '',                                                                          // 4
    '# Backup photos',                                                           // 5
    '0 2 * * * /home/me/bin/backup.sh --photos',                                 // 6
    '*/15 9-17 * * mon-fri curl -s https://example.com/ping > /dev/null 2>&1',   // 7
    '#cronboard-disabled# 30 6 * * 1 /home/me/bin/weekly.sh',                    // 8
    '@reboot sleep 30 && /home/me/bin/start.sh',                                 // 9
    '@yearly echo yearly',                                                       // 10
    '@annually echo annually',                                                   // 11
    '@monthly echo monthly',                                                     // 12
    '@weekly echo weekly',                                                       // 13
    '@daily echo daily',                                                         // 14
    '@midnight echo midnight',                                                   // 15
    '@hourly echo hourly',                                                       // 16
    'FOO=late',                                                                  // 17
    '0 9 * * * root /usr/bin/system-style',                                      // 18
    'this is not a cron line',                                                   // 19
    '61 * * * * bad minute',                                                     // 20
    '   0 3 * * * indented',                                                     // 21
    '0 4 * * * date +\\%F % input',                                              // 22
    `0 5 * * * ${RUNNER} 1a2b3c4d 'echo it'\\''s fine'`,                         // 23
    '#cronboard-disabled# not a job',                                            // 24
];
const SAMPLE = SAMPLE_LINES.join('\n') + '\n';

function edited(change: (lines: string[]) => void): string {
    const lines = SAMPLE_LINES.slice();
    change(lines);
    return lines.join('\n') + '\n';
}

test('round trip is byte-identical', () => {
    for (const text of [SAMPLE, SAMPLE.slice(0, -1), '', '\n', '\n\n', 'just text', SAMPLE.replaceAll('\n', '\r\n')])
        assert.equal(serialize(parse(text)), text);
});

test('classifies lines', () => {
    const kinds = parse(SAMPLE).map(l => l.kind[0]).join('');
    assert.equal(kinds, 'oeeeooj' + 'jjjjjjjjjj' + 'ejoojjjoo');
});

test('jobs: commands, names, disabled, tracked', () => {
    const list = jobs(parse(SAMPLE));
    assert.deepEqual(list.map(j => j.index), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 21, 22, 23]);
    assert.deepEqual(list.map(j => j.line.command), [
        '/home/me/bin/backup.sh --photos',
        'curl -s https://example.com/ping > /dev/null 2>&1',
        '/home/me/bin/weekly.sh',
        'sleep 30 && /home/me/bin/start.sh',
        'echo yearly', 'echo annually', 'echo monthly', 'echo weekly', 'echo daily', 'echo midnight', 'echo hourly',
        'root /usr/bin/system-style',
        'indented',
        'date +\\%F % input',
        "echo it's fine",
    ]);
    assert.equal(list[0].name, 'Backup photos');
    assert.equal(list[1].name, null);
    assert.equal(list[1].line.schedule, '*/15 9-17 * * mon-fri');
    assert.equal(list[2].line.enabled, false);
    assert.equal(list[2].line.schedule, '30 6 * * 1');
    assert.equal(list[12].line.schedule, '0 3 * * *');
    assert.deepEqual(list[14].line.track, {runner: RUNNER, id: '1a2b3c4d'});
});

test('env vars apply to the jobs below them', () => {
    const list = jobs(parse(SAMPLE));
    assert.deepEqual(list[0].env, {SHELL: '/bin/bash', MAILTO: 'me@example.com', PATH: '/usr/local/bin:/usr/bin:/bin'});
    assert.equal(list[0].env.FOO, undefined);
    assert.equal(list[11].env.FOO, 'late');
});

test('toggling a job and back is byte-exact', () => {
    const lines = parse(SAMPLE);
    for (const {index, line} of jobs(lines)) {
        const back = setEnabled(setEnabled(lines, index, !line.enabled), index, line.enabled);
        assert.equal(serialize(back), SAMPLE, `line ${index}`);
    }
    assert.equal(serialize(setEnabled(lines, 6, false)), edited(l => {
        l[6] = DISABLED_MARKER + l[6];
    }));
    assert.equal(serialize(setEnabled(lines, 8, true)), edited(l => {
        l[8] = '30 6 * * 1 /home/me/bin/weekly.sh';
    }));
});

test('updateJob only touches the target lines', () => {
    const lines = parse(SAMPLE);
    const backup = {schedule: '0 2 * * *', command: '/home/me/bin/backup.sh --photos', name: 'Backup photos'};
    assert.equal(serialize(updateJob(lines, 6, backup)), SAMPLE);
    assert.equal(serialize(updateJob(lines, 6, {...backup, schedule: '0 3 * * *'})), edited(l => {
        l[6] = '0 3 * * * /home/me/bin/backup.sh --photos';
    }));
    assert.equal(serialize(updateJob(lines, 6, {...backup, name: 'Photos'})), edited(l => {
        l[5] = '# Photos';
    }));
    assert.equal(serialize(updateJob(lines, 6, {...backup, name: null})), edited(l => {
        l.splice(5, 1);
    }));
    assert.equal(serialize(updateJob(lines, 7, {
        schedule: '*/15 9-17 * * mon-fri', command: 'curl -s https://example.com/ping > /dev/null 2>&1', name: 'Ping',
    })), edited(l => {
        l.splice(7, 0, '# Ping');
    }));
    assert.equal(serialize(updateJob(lines, 21, {schedule: '0 3 * * *', command: 'indented', name: null})), SAMPLE);
    assert.equal(serialize(updateJob(lines, 8, {schedule: '0 7 * * 1', command: '/home/me/bin/weekly.sh', name: null})),
        edited(l => {
            l[8] = `${DISABLED_MARKER}0 7 * * 1 /home/me/bin/weekly.sh`;
        }));
});

test('updateJob handles tracked jobs', () => {
    const lines = parse(SAMPLE);
    const fields = {schedule: '0 5 * * *', command: "echo it's fine", name: null};
    assert.equal(serialize(updateJob(lines, 23, {...fields, track: {runner: RUNNER, id: '1a2b3c4d'}})), SAMPLE);
    assert.equal(serialize(updateJob(lines, 23, fields)), edited(l => {
        l[23] = "0 5 * * * echo it's fine";
    }));
    const tracked = updateJob(lines, 21, {schedule: '0 3 * * *', command: "say 'hi'", name: null, track: {runner: RUNNER, id: 'ff'}});
    assert.equal(tracked[21].raw, `0 3 * * * ${RUNNER} ff 'say '\\''hi'\\'''`);
    assert.equal(tracked[21].kind === 'job' && tracked[21].command, "say 'hi'");
});

test('addJob appends before the trailing newline', () => {
    const job = {schedule: '* * * * *', command: 'echo hi', name: null};
    assert.equal(serialize(addJob(parse(''), {...job, name: 'Hello'})), '# Hello\n* * * * * echo hi\n');
    assert.equal(serialize(addJob(parse(SAMPLE), job)), SAMPLE + '* * * * * echo hi\n');
    assert.equal(serialize(addJob(parse('a'), job)), 'a\n* * * * * echo hi');
    const added = jobs(addJob(parse(SAMPLE), job));
    assert.equal(added[added.length - 1].env.FOO, 'late');
});

test('deleteJob removes the job and its name comment', () => {
    const lines = parse(SAMPLE);
    assert.equal(serialize(deleteJob(lines, 6)), edited(l => {
        l.splice(5, 2);
    }));
    assert.equal(serialize(deleteJob(lines, 7)), edited(l => {
        l.splice(7, 1);
    }));
    assert.throws(() => deleteJob(lines, 19));
});

test('splitPercent follows cron rules', () => {
    assert.deepEqual(splitPercent('echo hi'), {cmd: 'echo hi', stdin: null});
    assert.deepEqual(splitPercent('date +\\%F'), {cmd: 'date +%F', stdin: null});
    assert.deepEqual(splitPercent('mail -s hi me%line1%line2'), {cmd: 'mail -s hi me', stdin: 'line1\nline2'});
    assert.deepEqual(splitPercent('a\\%b%c\\%d'), {cmd: 'a%b', stdin: 'c%d'});
});
