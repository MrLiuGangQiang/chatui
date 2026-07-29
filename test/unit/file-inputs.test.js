const assert = require('assert');

const fileInputs = require('../../shared/file-inputs');

function testFileInputCategoriesAndMimeInference() {
  const cases = [
    { file: { name: 'report.PDF' }, category: 'pdf', mime: 'application/pdf' },
    {
      file: { name: 'budget.xlsx' },
      category: 'spreadsheet',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
    {
      file: { name: 'proposal.docx' },
      category: 'document',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    {
      file: { name: 'briefing.pptx' },
      category: 'presentation',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
    { file: { name: 'notes.md' }, category: 'text', mime: 'text/markdown' },
    { file: { name: 'script.py' }, category: 'text', mime: 'text/x-python' },
    { file: { name: 'Main.java' }, category: 'text', mime: 'text/x-java' },
    { file: { name: 'worker.go' }, category: 'text', mime: 'text/x-go' },
    { file: { name: 'query.sql' }, category: 'text', mime: 'text/x-sql' },
    { file: { name: 'settings.ini' }, category: 'text', mime: 'text/x-ini' },
    { file: { name: 'Dockerfile' }, category: 'text', mime: 'text/x-dockerfile' },
  ];

  for (const { file, category, mime } of cases) {
    assert.strictEqual(fileInputs.isAcceptedFile(file), true, `${file.name} should be accepted`);
    assert.strictEqual(fileInputs.categoryForFile(file), category, `${file.name} category`);
    assert.strictEqual(fileInputs.inferMimeType(file.name, 'application/octet-stream'), mime, `${file.name} MIME`);
  }

  assert.strictEqual(fileInputs.categoryForFile({ type: 'text/csv; charset=utf-8' }), 'spreadsheet');
  assert.strictEqual(fileInputs.categoryForFile({ type: 'application/msword' }), 'document');
  assert.strictEqual(fileInputs.categoryForFile({ type: 'application/vnd.ms-powerpoint' }), 'presentation');
  assert.strictEqual(fileInputs.categoryForFile({ type: 'text/plain; charset=utf-8' }), 'text');
  assert.strictEqual(fileInputs.inferMimeType('unknown.bin', 'TEXT/PLAIN; charset=utf-8'), 'text/plain');
  for (const extension of fileInputs.ALL_EXTENSIONS) {
    assert.notStrictEqual(
      fileInputs.inferMimeType(`attachment${extension}`, ''),
      'application/octet-stream',
      `${extension} should have a usable MIME when the browser leaves File.type empty`
    );
  }
}

function testFileInputSizeLimitsAreStrictlyBelowFiftyMegabytes() {
  const justBelowLimit = {
    name: 'largest-valid.txt',
    type: 'text/plain',
    size: fileInputs.MAX_FILE_BYTES - 1,
  };
  assert.strictEqual(fileInputs.validateFile(justBelowLimit).size, fileInputs.MAX_FILE_BYTES - 1);

  assert.throws(
    () => fileInputs.validateFile({ ...justBelowLimit, name: 'too-large.txt', size: fileInputs.MAX_FILE_BYTES }),
    error => error?.code === 'FILE_INPUT_TOO_LARGE' && error?.statusCode === 413
  );

  const aggregateBelowLimit = fileInputs.validateRequestFiles([
    { name: 'part-one.txt', type: 'text/plain', size: Math.floor(fileInputs.MAX_REQUEST_BYTES / 2) },
    { name: 'part-two.txt', type: 'text/plain', size: Math.ceil(fileInputs.MAX_REQUEST_BYTES / 2) - 1 },
  ]);
  assert.strictEqual(aggregateBelowLimit.totalBytes, fileInputs.MAX_REQUEST_BYTES - 1);

  assert.throws(
    () => fileInputs.validateRequestFiles([
      { name: 'part-one.txt', type: 'text/plain', size: fileInputs.MAX_REQUEST_BYTES / 2 },
      { name: 'part-two.txt', type: 'text/plain', size: fileInputs.MAX_REQUEST_BYTES / 2 },
    ]),
    error => error?.code === 'FILE_INPUT_REQUEST_TOO_LARGE' && error?.statusCode === 413
  );
}

function testPdfDetailNormalization() {
  assert.strictEqual(fileInputs.normalizePdfDetail('auto'), 'auto');
  assert.strictEqual(fileInputs.normalizePdfDetail(' LOW '), 'low');
  assert.strictEqual(fileInputs.normalizePdfDetail('HIGH'), 'high');
  assert.strictEqual(fileInputs.normalizePdfDetail('original'), 'auto');
  assert.strictEqual(fileInputs.normalizePdfDetail(''), 'auto');
}

module.exports = [
  testFileInputCategoriesAndMimeInference,
  testFileInputSizeLimitsAreStrictlyBelowFiftyMegabytes,
  testPdfDetailNormalization,
];
