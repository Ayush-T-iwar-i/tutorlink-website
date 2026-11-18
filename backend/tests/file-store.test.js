const fs = require('fs');
const path = require('path');

jest.mock('../config/db', () => ({ query: jest.fn() }));

const db = require('../config/db');
const fileStore = require('../lib/file-store');

const NAME = `photos/jest_${process.pid}_filestore.png`;
const FILE = path.join(fileStore.ROOT, NAME);
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

beforeEach(() => { db.query.mockReset(); fs.mkdirSync(path.dirname(FILE), { recursive: true }); });
afterAll(() => { try { fs.unlinkSync(FILE); } catch (_) { /* already gone */ } });

describe('file-store', () => {
  test('safeRel accepts upload names and refuses anything that could escape the folder', () => {
    expect(fileStore.safeRel('photos/8_photo_1.jpg')).toBe('photos/8_photo_1.jpg');
    expect(fileStore.safeRel('8_id_proof_1.pdf')).toBe('8_id_proof_1.pdf');
    ['../server.js', 'photos/../x.png', '/etc/passwd', 'a/b.png', 'photos/', '', null, 'x'.repeat(300)]
      .forEach((bad) => expect(fileStore.safeRel(bad)).toBeNull());
  });

  test('persist stores the bytes with the right mime type', async () => {
    fs.writeFileSync(FILE, BYTES);
    db.query.mockResolvedValue([{}]);
    expect(await fileStore.persist(NAME, FILE)).toBe(true);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO uploaded_files/);
    expect(params[0]).toBe(NAME);
    expect(params[1]).toBe('image/png');
    expect(params[2].equals(BYTES)).toBe(true);
  });

  test('persist never throws (database error, missing file, unknown extension)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockRejectedValue(new Error('db down'));
    fs.writeFileSync(FILE, BYTES);
    expect(await fileStore.persist(NAME, FILE)).toBe(false);
    expect(await fileStore.persist(NAME, '/no/such/file')).toBe(false);
    expect(await fileStore.persist('photos/x.exe', FILE)).toBe(false);
    spy.mockRestore();
  });

  test('restore writes a missing file back from the database', async () => {
    try { fs.unlinkSync(FILE); } catch (_) { /* not there */ }
    db.query.mockResolvedValue([[{ data: BYTES }]]);
    expect(await fileStore.restore(NAME)).toBe(true);
    expect(fs.readFileSync(FILE).equals(BYTES)).toBe(true);
  });

  test('restore does not touch the database when the file is already on disk', async () => {
    fs.writeFileSync(FILE, BYTES);
    expect(await fileStore.restore(NAME)).toBe(true);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('restore returns false for unknown files and unsafe names, without throwing', async () => {
    try { fs.unlinkSync(FILE); } catch (_) { /* not there */ }
    db.query.mockResolvedValue([[]]);
    expect(await fileStore.restore(NAME)).toBe(false);
    expect(await fileStore.restore('../server.js')).toBe(false);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});