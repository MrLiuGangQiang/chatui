(function initChatUIClarificationChoiceWorkflow(root) {
  'use strict';

  const clarificationAnswerProtocol = root?.[Symbol.for('chatui.module-registry.v1')]?.get('clarificationAnswer')
    || root?.ChatUIClarificationAnswer
    || (typeof require === 'function' ? require('../../shared/clarification-answer') : {});
  const clarificationAnswer = root?.[Symbol.for('chatui.module-registry.v1')]?.get('clarificationAnswer')
    || root?.ChatUIServices?.clarification
    || root?.ChatUIClarificationService
    || (typeof require === 'function' ? require('../../shared/clarification-answer') : {});
  const clarificationRelationProtocol = root?.[Symbol.for('chatui.module-registry.v1')]?.get('clarificationRelation')
    || (typeof require === 'function' ? require('../../shared/clarification-relation') : {});

  function createChoiceAnswer({ clarificationId = '', resourceKey = '', choiceKey = '', label = '' } = {}) {
    return clarificationAnswerProtocol.createClarificationAnswer({
      clarificationId,
      answers: [{ resource_key: String(resourceKey || ''), choice_key: String(choiceKey || '') }],
      freeText: String(label || ''),
    });
  }

  function createClarificationChoiceWorkflow(deps = {}) {
    const state = deps.state;
    const documentRef = deps.document || root?.document;
    if (!state || !documentRef) throw new Error('state and document are required');
    let bound = false;
    const processing = new Set();

    function activeSession() {
      return (state.sessions || []).find(session => session?.id === state.activeSessionId) || null;
    }

    function pendingForActiveSession() {
      const session = activeSession();
      const pending = clarificationAnswer.normalizePendingClarification?.(session?.pendingClarification) || null;
      return { session, pending };
    }

    function messageClarificationId(button) {
      return String(button?.closest?.('.message')?.dataset?.clarificationId || '').trim();
    }

    function setSelectedButton(button) {
      const resourceKey = String(button?.dataset?.resourceKey || '');
      const presentation = button?.closest?.('.clarification-presentation');
      presentation?.querySelectorAll?.('.clarification-choice-button').forEach(candidate => {
        if (String(candidate.dataset?.resourceKey || '') !== resourceKey) return;
        const selected = candidate === button;
        candidate.setAttribute('aria-pressed', selected ? 'true' : 'false');
        candidate.closest('li')?.classList?.toggle('is-selected', selected);
      });
    }

    function selectedSummary(pending) {
      const labels = clarificationAnswer.clarificationAnswerLabels?.(pending) || [];
      return labels.length ? `已选择：${labels.join('；')}` : '已完成选项选择';
    }

    function updateRemainingHint(button, result) {
      const presentation = button?.closest?.('.clarification-presentation');
      const hint = presentation?.querySelector?.('.clarification-choice-hint');
      const remaining = Number(result?.application?.remainingSlots?.length || 0);
      if (hint) hint.textContent = remaining > 0
        ? `已记录当前选择，还需选择 ${remaining} 项。`
        : '选项已确认，正在继续原任务。';
    }

    function syncPendingSelection() {
      const { pending } = pendingForActiveSession();
      if (!pending?.id || !pending.clarificationAnswer) return;
      const selector = `.message[data-clarification-id="${String(pending.id).replace(/["\\]/g, '\\$&')}"]`;
      const message = documentRef.querySelector?.(selector);
      if (!message) return;
      const selected = new Map(pending.clarificationAnswer.answers.map(item => [item.resource_key, item.choice_key]));
      const slots = pending.routeInfo?.clarificationSlots || [];
      const application = clarificationAnswer.applyClarificationAnswer?.(pending.clarificationAnswer, slots, { clarificationId: pending.id });
      const completed = application?.complete === true || !!pending.relationClarification;
      message.querySelectorAll?.('.clarification-choice-button').forEach(button => {
        const pressed = selected.get(String(button.dataset?.resourceKey || '')) === String(button.dataset?.choiceKey || '');
        button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
        button.disabled = completed;
        button.closest('li')?.classList?.toggle('is-selected', pressed);
      });
    }

    function relationChoiceLabel(decision = '') {
      return decision === 'continue' ? '继续原任务' : decision === 'new_task' ? '开始新任务' : '';
    }

    async function onRelationChoiceClick(event, button) {
      if (!button || !button.closest?.('#messages')) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      const clarificationId = messageClarificationId(button);
      const pendingId = String(button.dataset?.pendingId || '').trim();
      const decision = String(button.dataset?.relationDecision || '').trim();
      if (!clarificationId || !pendingId || !decision || processing.has(clarificationId)) return;

      const { pending } = pendingForActiveSession();
      const active = pending?.relationClarification || null;
      if (!pending || !active
          || String(active.clarification_id || '') !== clarificationId
          || String(active.pending_id || '') !== pendingId
          || String(pending.id || '') !== pendingId) {
        deps.toast?.('这个任务关系选项已经过期，请使用当前最新问题。');
        return;
      }

      let answer;
      try {
        answer = clarificationRelationProtocol.createRelationAnswer({
          clarificationId,
          pendingId,
          decision,
        });
        clarificationRelationProtocol.assertRelationAnswer?.(active, answer);
      } catch (error) {
        deps.toast?.(error?.message || '任务关系选项无效，请重新选择。');
        return;
      }

      processing.add(clarificationId);
      button.closest?.('.clarification-presentation')?.querySelectorAll?.('.clarification-relation-choice-button').forEach(candidate => {
        candidate.disabled = true;
        const selected = candidate === button;
        candidate.setAttribute('aria-pressed', selected ? 'true' : 'false');
        candidate.closest('li')?.classList?.toggle('is-selected', selected);
      });
      try {
        await deps.onSubmit?.({
          preventDefault() {},
          __chatuiClarificationRelationAnswer: answer,
          __chatuiClarificationLabel: relationChoiceLabel(decision),
          __chatuiClarificationId: clarificationId,
        });
      } finally {
        processing.delete(clarificationId);
      }
    }

    async function onPreviewChoiceClick(event, button) {
      if (!button || !button.closest?.('#messages')) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      const source = String(button.dataset?.previewSrc || '').trim();
      const filename = String(button.dataset?.previewFilename || 'image.png').trim() || 'image.png';
      if (!source) {
        deps.toast?.('这张候选图片当前无法预览。');
        return;
      }
      try {
        await deps.openImagePreview?.(source, filename);
      } catch (error) {
        deps.toast?.(error?.message || '图片预览失败，请稍后重试。');
      }
    }

    async function onChoiceClick(event) {
      const previewButton = event?.target?.closest?.('.clarification-choice-preview-button');
      if (previewButton) return onPreviewChoiceClick(event, previewButton);
      const relationButton = event?.target?.closest?.('.clarification-relation-choice-button');
      if (relationButton) return onRelationChoiceClick(event, relationButton);
      const button = event?.target?.closest?.('.clarification-choice-button');
      if (!button || !button.closest?.('#messages')) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      const clarificationId = messageClarificationId(button);
      const resourceKey = String(button.dataset?.resourceKey || '').trim();
      const choiceKey = String(button.dataset?.choiceKey || '').trim();
      if (!clarificationId || !resourceKey || !choiceKey || processing.has(clarificationId)) return;

      const { session, pending } = pendingForActiveSession();
      if (pending?.relationClarification) {
        deps.toast?.('请先选择继续原任务或开始新任务。');
        return;
      }
      if (!session || !pending || pending.id !== clarificationId) {
        deps.toast?.('这个选项属于已结束的澄清，请使用当前最新问题。');
        return;
      }

      let result;
      try {
        const canonicalSelection = clarificationAnswer.canonicalClarificationSelection?.({
          resourceKey,
          choiceKey,
        }, pending.routeInfo?.clarificationSlots || []);
        if (!canonicalSelection) throw new TypeError('Clarification selection is no longer available');
        const incremental = createChoiceAnswer({
          clarificationId,
          resourceKey: canonicalSelection.resource_key,
          choiceKey: canonicalSelection.choice_key,
          label: button.dataset?.choiceLabel || '',
        });
        result = clarificationAnswer.applyPendingClarificationAnswer?.(pending, incremental);
      } catch (error) {
        deps.toast?.(error?.message || '选项无效，请重新选择。');
        return;
      }
      if (!result?.pending) return;

      session.pendingClarification = result.pending;
      deps.saveSessionsMeta?.();
      setSelectedButton(button);
      updateRemainingHint(button, result);
      if (!result.complete) return;

      processing.add(clarificationId);
      button.closest?.('.clarification-presentation')?.querySelectorAll?.('.clarification-choice-button').forEach(candidate => {
        candidate.disabled = true;
      });
      try {
        await deps.onSubmit?.({
          preventDefault() {},
          __chatuiClarificationAnswer: result.answer,
          __chatuiClarificationLabel: selectedSummary(result.pending),
          __chatuiClarificationId: clarificationId,
        });
      } finally {
        processing.delete(clarificationId);
      }
    }

    function bind() {
      if (bound) return false;
      const messages = deps.messages || documentRef.getElementById?.('messages');
      if (!messages) return false;
      messages.addEventListener('click', onChoiceClick);
      bound = true;
      syncPendingSelection();
      return true;
    }

    function unbind() {
      if (!bound) return false;
      const messages = deps.messages || documentRef.getElementById?.('messages');
      messages?.removeEventListener?.('click', onChoiceClick);
      bound = false;
      return true;
    }

    return Object.freeze({ bind, unbind, onChoiceClick, syncPendingSelection });
  }

  const api = Object.freeze({ createClarificationChoiceWorkflow, createChoiceAnswer });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('clarificationChoiceWorkflow', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
