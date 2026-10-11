import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffImage, gradeAnswers, shuffle, csvCell, isUuid, normalizeExamSchedule } from '../src/lib.js';

test('sniffImage accepts real signatures and rejects others', () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
  assert.equal(sniffImage(jpg), 'image/jpeg');
  assert.equal(sniffImage(png), 'image/png');
  assert.equal(sniffImage(Buffer.from('<script>alert(1)</script>')), null);
  assert.equal(sniffImage(Buffer.from('%PDF-1.4 hello world')), null);
});

test('gradeAnswers handles correct, wrong, unanswered and negative marking', () => {
  const rows = [
    { marks: 2, correct_index: 1, selected_index: 1 },
    { marks: 2, correct_index: 0, selected_index: 3 },
    { marks: 1, correct_index: 2, selected_index: null },
  ];
  const r = gradeAnswers(rows, 0.5);
  assert.deepEqual(r, { score: 1.5, total: 5, correct: 1, wrong: 1, unanswered: 1 });
});

test('shuffle keeps all elements', () => {
  const a = [1, 2, 3, 4, 5, 6];
  assert.deepEqual([...shuffle(a)].sort(), a);
});

test('csvCell neutralises formulas and quotes', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
});

test('isUuid', () => {
  assert.equal(isUuid('3f2b8c7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'), true);
  assert.equal(isUuid('1; DROP TABLE'), false);
});

test('normalizeExamSchedule requires ordered, timezone-qualified values', () => {
  const schedule = normalizeExamSchedule({
    examStartAt: '2026-10-12T07:30:00.000Z',
    loginDeadlineAt: '2026-10-12T07:37:00.000Z',
    finalSubmissionAt: '2026-10-12T08:05:00.000Z',
  });
  assert.equal(schedule.valid, true);
  assert.equal(schedule.schedule.examStartAt, '2026-10-12T07:30:00.000Z');
  assert.equal(normalizeExamSchedule({ examStartAt: '2026-10-12T07:30' }).valid, false);
  assert.equal(normalizeExamSchedule({
    examStartAt: '2026-02-31T07:30:00Z',
    loginDeadlineAt: '2026-03-01T07:37:00Z',
    finalSubmissionAt: '2026-03-01T08:05:00Z',
  }).valid, false);
  assert.equal(normalizeExamSchedule({
    examStartAt: '2026-10-12T07:37:00Z',
    loginDeadlineAt: '2026-10-12T07:37:00Z',
    finalSubmissionAt: '2026-10-12T08:05:00Z',
  }).valid, false);
  assert.equal(normalizeExamSchedule({}).valid, true);
});
