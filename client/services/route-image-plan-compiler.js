(function initChatUIRouteImagePlanCompiler(root) {
  'use strict';

  function createRouteImagePlanCompiler({
    imagePlanVersion = 'image_plan.v1',
    imagePlanMaxTasks = 5,
    assertImagePlan = null,
    imageOperations = ['text_to_image', 'image_reference_gen', 'edit_image'],
    validRelations = ['new', 'followup', 'continuation'],
    resourceTypeForCandidateKey = null,
    bindingForCandidate = candidate => candidate,
    routeCompilationCandidateCatalog = () => [],
    isMetaInstructionGoal = () => false,
    hasUnresolvedImageInstructionReference = () => false,
    compileLocalRoute = null,
  } = {}) {
    const IMAGE_PLAN_VERSION = String(imagePlanVersion || 'image_plan.v1');
    const IMAGE_PLAN_MAX_TASKS = Number.isSafeInteger(Number(imagePlanMaxTasks)) && Number(imagePlanMaxTasks) >= 1
      ? Number(imagePlanMaxTasks)
      : 5;
    const imageOperationSet = new Set(imageOperations || []);
    const relationSet = new Set(validRelations || []);
    const overLimitQuestion = `一次最多生成 ${IMAGE_PLAN_MAX_TASKS} 张图片，请减少到 ${IMAGE_PLAN_MAX_TASKS} 张以内，或分批发。`;

    function stringValue(value) {
      return String(value ?? '').trim();
    }

    function imagePlanTaskOperation(task = {}) {
      const taskType = stringValue(task?.task_type);
      const inputImages = Array.isArray(task?.input_images) ? task.input_images : [];
      if (taskType === 'generate') return inputImages.length ? 'image_reference_gen' : 'text_to_image';
      if (taskType === 'edit') return 'edit_image';
      return '';
    }

    function imagePlanTaskBindings(task = {}, catalog = []) {
      const byCandidateKey = new Map((catalog || []).map(candidate => [candidate.candidate_key, candidate]));
      return (Array.isArray(task?.input_images) ? task.input_images : []).map((ref, index) => {
        const candidateKey = stringValue(ref?.candidate_key);
        const role = stringValue(ref?.role);
        let candidate = byCandidateKey.get(candidateKey);
        // Preserve iN/fN ordinals when the planning catalog is rebuilt with
        // durable candidate keys between the route and plan stages.
        if (!candidate) {
          const ordinal = /^(?:i|f)(\d+)$/.exec(candidateKey)?.[1];
          const typeHint = candidateKey.startsWith('i') ? 'image' : candidateKey.startsWith('f') ? 'file' : '';
          if (ordinal && typeHint) candidate = (catalog || []).filter(item => item?.type === typeHint)[Number(ordinal) - 1] || null;
        }
        if (candidate) return bindingForCandidate(candidate, role, `r${index + 1}`);
        const type = resourceTypeForCandidateKey?.(candidateKey)
          || (candidateKey.startsWith('i') ? 'image' : candidateKey.startsWith('f') ? 'file' : 'message');
        return { key: `r${index + 1}`, type, role, resource_id: candidateKey, source: 'context' };
      });
    }

    function imagePlanTaskOverrides(task = {}) {
      return {
        quality: stringValue(task.quality) || 'auto',
        background: stringValue(task.background) || 'auto',
        output_format: stringValue(task.output_format) || 'auto',
      };
    }

    function shouldRequestImagePlan(route = {}) {
      if (!route || route.needClarification) return false;
      if (route.imagePlanCompiled && (route.imagePlanCompiled.kind === 'batch' || route.imagePlanCompiled.kind === 'single')) return false;
      const taskShape = stringValue(route.taskShape) || 'single';
      return taskShape === 'multi'
        && imageOperationSet.has(stringValue(route.operationType || route.intent || ''));
    }

    function compileImagePlan(imagePlan = {}, options = {}) {
      const tasks = Array.isArray(imagePlan?.tasks) ? imagePlan.tasks : [];
      if (tasks.length > IMAGE_PLAN_MAX_TASKS) {
        return Object.freeze({
          ok: false,
          code: 'IMAGE_PLAN_OVER_LIMIT',
          question: overLimitQuestion,
          taskCount: tasks.length,
          maxTasks: IMAGE_PLAN_MAX_TASKS,
        });
      }
      try {
        if (typeof assertImagePlan !== 'function') throw new TypeError('Image plan validator is unavailable');
        assertImagePlan(imagePlan);
      } catch (error) {
        return Object.freeze({
          ok: false,
          code: 'IMAGE_PLAN_INVALID',
          question: '多图任务规划结果无效，请重试。',
          error: String(error?.message || error),
        });
      }
      const catalog = routeCompilationCandidateCatalog(options);
      const items = [];
      for (const task of tasks) {
        const operation = imagePlanTaskOperation(task);
        if (!operation) {
          return Object.freeze({ ok: false, code: 'IMAGE_PLAN_TASK_INVALID', question: '多图任务包含无法执行的子任务，请重试。' });
        }
        if (isMetaInstructionGoal(stringValue(task.prompt)) || hasUnresolvedImageInstructionReference(task.prompt)) {
          return Object.freeze({
            ok: false,
            code: 'IMAGE_PLAN_TASK_META_INSTRUCTION',
            question: '多图任务包含不完整的画面描述，请重新描述每个子任务的具体画面内容（主体、场景、风格、修改项等）。',
          });
        }
        const relation = relationSet.has(stringValue(options.relation)) ? stringValue(options.relation) : 'new';
        if (typeof compileLocalRoute !== 'function') {
          return Object.freeze({ ok: false, code: 'IMAGE_PLAN_TASK_NOT_READY', question: '多图子任务编译器不可用，请重试。' });
        }
        const route = compileLocalRoute({
          operation,
          relation,
          arguments: { prompt: stringValue(task.prompt) },
          bindings: imagePlanTaskBindings(task, catalog),
          constraints: [],
        }, {
          ...options,
          input: stringValue(task.prompt),
          parameterInput: '',
          semanticAuthority: IMAGE_PLAN_VERSION,
          overrides: { ...(options.overrides || {}), ...imagePlanTaskOverrides(task) },
        });
        if (!route || route.needClarification || !route.dispatchContract) {
          return Object.freeze({
            ok: false,
            code: 'IMAGE_PLAN_TASK_NOT_READY',
            question: route?.clarificationQuestion || '多图子任务无法安全执行，请重试。',
            route,
          });
        }
        items.push(Object.freeze({
          task,
          operation,
          api: route.api,
          mode: route.mode,
          dispatchContract: route.dispatchContract,
          executionResources: route.executionResources,
          route: Object.freeze({ ...route, taskShape: 'single' }),
        }));
      }
      if (items.length === 1) {
        return Object.freeze({
          ok: true,
          kind: 'single',
          item: items[0],
          dispatchContract: items[0].dispatchContract,
          executionResources: items[0].executionResources,
        });
      }
      return Object.freeze({ ok: true, kind: 'batch', items, maxTasks: IMAGE_PLAN_MAX_TASKS });
    }

    return Object.freeze({
      imagePlanTaskOperation,
      imagePlanTaskBindings,
      imagePlanTaskOverrides,
      shouldRequestImagePlan,
      compileImagePlan,
    });
  }

  const api = Object.freeze({ createRouteImagePlanCompiler });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routeImagePlanCompiler', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);