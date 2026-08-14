'use strict';

const assert = require('assert');
const imageRouteContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');
const submitHelpers = require('../../client/app/submit-workflow.helpers');

function attachmentContext(files) {
  return JSON.stringify({
    attachments: files.map(file => ({
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size || 1024,
      inputFile: true,
      persistedSrc: `indexeddb://${file.id}`,
    })),
  });
}

function file(id, name, type = 'application/octet-stream') {
  return { id, name, type };
}

function publicRouteInput({ input, messages }) {
  const context = imageRouteContext.buildRouteContext({ messages });
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input,
    attachments: [],
    context,
    currentTurn: { messageIndex: messages.length },
  });
  return { context, payload: JSON.parse(payload.messages[1].content) };
}

function testSubjectlessFileFollowupPublishesBoundedFilesAndPreviousExecutionEvidence() {
  const workbook = file(
    'workbook-current',
    'AI需求&BUG跟踪表.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  const messages = [
    {
      id: 'file-lineage:user:0', role: 'user', content: '这是什么', rawText: '这是什么',
      attachmentContext: attachmentContext([file(
        'document-old',
        '引言.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )]),
    },
    { id: 'file-lineage:assistant:1', role: 'assistant', content: '这是一份需求设计文档。', rawText: '这是一份需求设计文档。' },
    {
      id: 'file-lineage:user:2', role: 'user', content: '这是什么', rawText: '这是什么',
      attachmentContext: attachmentContext([workbook]),
    },
    { id: 'file-lineage:assistant:3', role: 'assistant', content: '这是一个 Excel 项目看板。', rawText: '这是一个 Excel 项目看板。' },
    { id: 'file-lineage:user:4', role: 'user', content: '具体有什么内容', rawText: '具体有什么内容' },
  ];

  const { context, payload } = publicRouteInput({ input: '具体有什么内容', messages });
  assert.deepStrictEqual(context.previous_resource_execution.files, [{
    resource_id: '', file_id: workbook.id, index: 1,
  }]);
  assert.strictEqual(context.previous_resource_execution.operation, 'file_qa');
  assert.strictEqual(context.previous_resource_execution.inferred_from_adjacent_attachments, true);
  assert.strictEqual(context.conversation_focus.kind, 'file');
  assert.deepStrictEqual(
    payload.resource_candidates.filter(candidate => candidate.type === 'file').map(candidate => candidate.label),
    [workbook.name, '引言.docx'],
    'the model receives the bounded file catalog for file follow-up routing',
  );
  assert.strictEqual(payload.context.conversation_focus.kind, 'file');

  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'file_qa',
    relation: 'followup',
    goal: '读取并说明上一份 Excel 表格的具体内容',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'f1', role: 'attachment' }],
  }), {
    input: '具体有什么内容',
    attachments: [],
    context,
    currentTurn: { messageIndex: messages.length },
  });
  assert.ok(inspected.route, `${inspected.reason}: ${inspected.error || ''}`);
  assert.strictEqual(inspected.route.needClarification, false);
  assert.strictEqual(inspected.route.dispatchAuthorized, true);
  assert.deepStrictEqual(inspected.route.resources.map(resource => [resource.type, resource.role, resource.id]), [
    ['file', 'attachment', workbook.id],
  ]);
}

function testExecutedFileBindingsPersistAsAResourceAnchor() {
  const marker = submitHelpers.routeExecutionAnchor({
    operationType: 'file_qa',
    executionResources: {
      files: [{
        source: 'current',
        id: 'workbook-anchor',
        resource_id: 'res:file:workbook-anchor',
        index: 1,
      }],
    },
  });
  assert.deepStrictEqual(marker, {
    schema_version: 'route_execution_anchor.v1',
    operation: 'file_qa',
    file_bindings: [{
      source: 'current',
      resource_id: 'res:file:workbook-anchor',
      file_id: 'workbook-anchor',
      index: 1,
    }],
  });

  const messages = [
    {
      role: 'user', content: '分析这个表格', rawText: '分析这个表格', routeExecutionAnchor: marker,
      attachmentContext: attachmentContext([file('workbook-anchor', 'roadmap.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')]),
    },
    { role: 'assistant', content: '分析完成。', rawText: '分析完成。' },
    { role: 'user', content: '展开讲讲', rawText: '展开讲讲' },
  ];
  const context = imageRouteContext.buildRouteContext({ messages });
  assert.strictEqual(context.previous_resource_execution.inferred_from_adjacent_attachments, false);
  assert.deepStrictEqual(context.previous_resource_execution.files, [{
    resource_id: 'res:file:workbook-anchor',
    file_id: 'workbook-anchor',
    index: 1,
  }]);
}

function testLatestMultiFileTurnPublishesAllBoundedFiles() {
  const messages = [
    {
      role: 'user', content: '旧文件', rawText: '旧文件',
      attachmentContext: attachmentContext([file('old-pdf', '旧报告.pdf', 'application/pdf')]),
    },
    { role: 'assistant', content: '旧报告摘要。', rawText: '旧报告摘要。' },
    {
      role: 'user', content: '比较这两个文件', rawText: '比较这两个文件',
      attachmentContext: attachmentContext([
        file('latest-xlsx', '需求表.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        file('latest-csv', '缺陷表.csv', 'text/csv'),
      ]),
    },
    { role: 'assistant', content: '两个文件的概览。', rawText: '两个文件的概览。' },
    { role: 'user', content: '具体有什么内容', rawText: '具体有什么内容' },
  ];
  const { payload } = publicRouteInput({ input: '具体有什么内容', messages });
  assert.deepStrictEqual(
    payload.resource_candidates.filter(candidate => candidate.type === 'file').map(candidate => candidate.label),
    ['需求表.xlsx', '缺陷表.csv', '旧报告.pdf'],
    'all bounded files remain candidates; the model owns selection of the latest execution group',
  );
}

function testLaterOrdinaryTextAnswerDoesNotHideBoundedFileEvidence() {
  const messages = [
    {
      role: 'user', content: '分析这个表格', rawText: '分析这个表格',
      attachmentContext: attachmentContext([file('shadowed-workbook', '历史表格.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')]),
    },
    { role: 'assistant', content: '表格分析完成。', rawText: '表格分析完成。' },
    { role: 'user', content: '写一句欢迎语', rawText: '写一句欢迎语' },
    { role: 'assistant', content: '欢迎使用。', rawText: '欢迎使用。' },
    { role: 'user', content: '再具体一点', rawText: '再具体一点' },
  ];
  const { context, payload } = publicRouteInput({ input: '再具体一点', messages });
  assert.strictEqual(context.previous_resource_execution, null);
  assert.strictEqual(context.conversation_focus.kind, 'text');
  assert.ok(payload.resource_candidates.some(candidate => candidate.type === 'file'),
    'text focus is evidence only and must not remove a bounded file before model routing');
  assert.strictEqual(payload.context.conversation_focus.kind, 'text');
}

module.exports = [
  testSubjectlessFileFollowupPublishesBoundedFilesAndPreviousExecutionEvidence,
  testExecutedFileBindingsPersistAsAResourceAnchor,
  testLatestMultiFileTurnPublishesAllBoundedFiles,
  testLaterOrdinaryTextAnswerDoesNotHideBoundedFileEvidence,
];
