'use strict';

const assert = require('assert');
const { Readable } = require('stream');
const { readBody } = require('../../server/http/body');

function requestFromChunks(chunks) {
  const request = Readable.from(chunks);
  request.headers = {};
  return request;
}

async function testReadBodyRejectsInvalidUtf8AcrossChunkBoundaries() {
  await assert.rejects(
    readBody(requestFromChunks([Buffer.from([0xc3]), Buffer.from([0x28])])),
    error => error?.statusCode === 400 && error?.code === 'INVALID_UTF8',
  );
}

async function testReadBodyAcceptsValidReplacementCharacterAndSplitMultibyteInput() {
  const replacementJsonText = '{"text":"\uFFFD"}';
  const replacementJson = Buffer.from(replacementJsonText, 'utf8');
  assert.strictEqual(await readBody(requestFromChunks([replacementJson])), replacementJsonText);

  const encoded = Buffer.from('{"text":"你"}', 'utf8');
  const splitAt = encoded.indexOf(Buffer.from('你', 'utf8')) + 1;
  assert.strictEqual(
    await readBody(requestFromChunks([encoded.subarray(0, splitAt), encoded.subarray(splitAt)])),
    '{"text":"你"}',
  );
}


async function testReadBodyAcceptsUint8ArrayChunksWithoutStringCoercion() {
  const encoded = new TextEncoder().encode('{"text":"typed-array"}');
  assert.strictEqual(
    await readBody(requestFromChunks([encoded])),
    '{"text":"typed-array"}',
  );
}

module.exports = [
  testReadBodyRejectsInvalidUtf8AcrossChunkBoundaries,
  testReadBodyAcceptsValidReplacementCharacterAndSplitMultibyteInput,
  testReadBodyAcceptsUint8ArrayChunksWithoutStringCoercion,
];
