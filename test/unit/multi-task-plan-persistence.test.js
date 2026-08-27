'use strict';

const assert = require('assert');
const sessionDisplay = require('../../client/app/session-display');

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function makeWorkflow({ state, storage }) {
  return sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => state.sessions.find(session => session.id === state.activeSessionId),
    deriveSessionTitle: session => session.title || '新对话',
    readJsonStorage: (key, fallback) => {
      const raw = storage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    },
    compactDisplayItems: items => items,
    compactAdjacentDuplicateMessages: items => items,
    sanitizeStoredDisplayItem: item => item,
    sanitizeStoredMessage: item => item,
    renderSessionList: () => {},
    localStorage: storage,
    messageRecords: {},
    sessionStoreApi: {
      buildSessionSnapshot: current => ({
        id: current.id,
        snapshotVersion: 2,
        updatedAt: current.updatedAt,
        messages: current.messages || [],
        pendingDisplay: current.display || [],
        lastGeneratedImage: null,
      }),
    },
    snapshotStore: { supported: false },
    constants: { SESSIONS_KEY: 'chatui-sessions', ACTIVE_SESSION_KEY: 'chatui-active-session' },
  });
}

function testMultiTaskPlanSurvivesSessionMetaPersistenceAndReload() {
  const plan = {
    schema_version: 'multi_task_plan.v1',
    tasks: [
      { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
      { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
    ],
  };
  const storage = memoryStorage();
  const session = {
    id: 'persist-plan', title: '计划持久化', messages: [], display: [],
    multiTaskPlan: plan, pendingClarification: null, createdAt: 1, updatedAt: 1,
  };
  const state = { sessions: [session], activeSessionId: session.id, messages: [], models: [] };
  const workflow = makeWorkflow({ state, storage });
  assert.strictEqual(workflow.saveSessionsMeta(), true);

  const reloadState = { sessions: [], activeSessionId: '', messages: [], models: [] };
  const reloadWorkflow = makeWorkflow({ state: reloadState, storage });
  return reloadWorkflow.loadSessions().then(() => {
    const restored = reloadState.sessions.find(item => item.id === session.id);
    assert.ok(restored, 'the persisted session must reload');
    assert.deepStrictEqual(restored.multiTaskPlan, plan,
      'the multi-task plan must survive session meta persistence and reload');
  });
}

module.exports = [
  testMultiTaskPlanSurvivesSessionMetaPersistenceAndReload,
];
