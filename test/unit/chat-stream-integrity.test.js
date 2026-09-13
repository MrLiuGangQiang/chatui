'use strict';
const assert = require('assert');
const fs = require('fs');
const parser = require('../../server/jobs/chat-stream-parser');
function job() { return { status:'running', firstTokenMs:null, buffer:'', data:{choices:[{message:{content:'',reasoning_content:''}}]} }; }
function sse(content) { return 'data: ' + JSON.stringify({choices:[{delta:{content}}]}) + '\n\n'; }
function testDefaultParserNotifiesOnlyAfterTheCurrentChunkIsCommitted() {
  const current = job(); const updates = [];
  parser.updateChatJobFromStreamChunk(current, sse('A') + sse('中'), { notifyChatStreamJob: j => updates.push(j.streamDelta?.content || '') });
  assert.deepStrictEqual(updates,['A中']);
}
function testChatStreamOutputLimitStopsBeforeUnboundedAppend() {
  const current = job();
  assert.throws(()=>parser.updateChatJobFromStreamChunk(current,sse('abcde'),{maxOutputBytes:4,notify:false}),e=>e.code==='CHAT_OUTPUT_TOO_LARGE');
  assert.strictEqual(current.data.choices[0].message.content,'');
}
function testUnterminatedUpstreamEventHasABoundedBuffer() {
  const current = job();
  assert.throws(()=>parser.updateChatJobFromStreamChunk(current,'x'.repeat(20),{maxBufferBytes:10,notify:false}),e=>e.code==='CHAT_STREAM_EVENT_TOO_LARGE');
}

function testManagedChatStreamUsesStringDecoderForUpstreamChunks() {
  const source = fs.readFileSync(require.resolve('../../server/jobs/chat'), 'utf8');
  assert.ok(source.includes("new StringDecoder('utf8')"), 'managed chat must decode UTF-8 across upstream Buffer boundaries');
  assert.ok(source.includes('decoder.write(Buffer.from(chunk))'), 'managed chat must not call Buffer.toString per chunk');
}

module.exports=[testDefaultParserNotifiesOnlyAfterTheCurrentChunkIsCommitted,testChatStreamOutputLimitStopsBeforeUnboundedAppend,testUnterminatedUpstreamEventHasABoundedBuffer,testManagedChatStreamUsesStringDecoderForUpstreamChunks];
