'use strict';

(function initChatUIImageTaskPreparation(root) {
  const moduleRegistry = root?.[Symbol.for('chatui.module-registry.v1')];
  const dispatchContract = moduleRegistry?.get('dispatchContract')
    || root?.ChatUIDispatchContract
    || (typeof require === 'function' ? require('../../shared/dispatch-contract') : {});
  const imageExecutionModule = moduleRegistry?.get('imageExecution')
    || root?.ChatUICoreImageExecution
    || (typeof require === 'function' ? require('../core/image-execution') : {});
  const imagesService = root?.ChatUIServices?.images
    || (typeof require === 'function' ? require('../services/image-generation-service') : {});

  function createImageTaskPreparation(deps = {}) {
    const { requireCanonicalImageExecution } = deps.imageExecutionPolicy
      || imageExecutionModule.createImageExecutionPolicy?.({ dispatchContract })
      || {};
    const buildImageRoleGuide = deps.buildImageRoleGuide || imageExecutionModule.buildImageRoleGuide;
    const buildImageRoleMap = deps.buildImageRoleMap || imageExecutionModule.buildImageRoleMap;
    const {
      persistImageAttachmentRefs,
      imageFilesToJobPayload,
      restoreImageAttachmentsFromContext,
      normalizeImageContextForStorage,
      makeImageItemId,
      getEffectiveImageStylePrompt,
      buildImagePromptWithStylePrompt,
      makeClientImageJobId,
    } = deps;

    async function prepareImageExecutionRequest({
      contract,
      executionMedia,
      sessionId,
      config,
      promptFallback = '',
      editInstruction = '',
      routePrompt = '',
      originalPrompt = '',
      resolvedGoal = '',
      taskState = null,
      childJobId = '',
      submissionId = '',
    } = {}) {
      if (typeof requireCanonicalImageExecution !== 'function') {
        throw new TypeError('image execution policy is unavailable');
      }
      const canonical = requireCanonicalImageExecution(contract, executionMedia);
      const bindingEvidence = dispatchContract.bindingEvidenceFromMedia?.(executionMedia || {}) || [];
      dispatchContract.assertBindingEvidence(contract, bindingEvidence);

      const imageInputs = [...(canonical.imageInputs || [])];
      const masks = [...(canonical.masks || [])];
      const isRefGen = canonical.operation === 'image_reference_gen';
      const requiresImageEdit = canonical.api === 'image_edit';
      const productMode = requiresImageEdit ? 'edit_image' : 'image';
      const usesPriorInput = !isRefGen && (canonical.targets || []).some(entry => ['history', 'context'].includes(String(entry?.routeSource || '')));
      if (requiresImageEdit && !imageInputs.length) {
        const error = new Error('Image edit task has no executable image input');
        error.code = 'IMAGE_EXECUTION_INPUT_MISSING';
        error.statusCode = 400;
        throw error;
      }

      const selectedReferenceId = String(imageInputs.find(entry => entry?.routeReferenceId)?.routeReferenceId || '');
      const selectedIndexes = imageInputs.map(entry => Number(entry?.routeIndex)).filter(index => Number.isInteger(index) && index >= 1);
      const selectedImageIds = imageInputs.map(entry => String(entry?.routeId || '')).filter(Boolean);
      const executionTarget = requiresImageEdit ? (usesPriorInput ? 'previous' : 'uploaded') : 'new';
      const persistedInputs = await persistImageAttachmentRefs(imageInputs);
      const persistedMasks = await persistImageAttachmentRefs(masks.map(entry => ({ ...entry, routeRole: 'mask' })));

      const prompt = String(contract?.arguments?.prompt || promptFallback || '').trim();
      const referenceRoleGuide = buildImageRoleGuide(imageInputs, contract);
      const roleAwarePrompt = [prompt, referenceRoleGuide].filter(Boolean).join('\n\n');
      const stylePrompt = canonical.operation === 'edit_image' ? '' : getEffectiveImageStylePrompt(sessionId, config);
      const styledPrompt = buildImagePromptWithStylePrompt(roleAwarePrompt, stylePrompt);
      const planArguments = contract.arguments || {};
      const requestedSize = String(planArguments.size || '').trim() && planArguments.size !== 'auto'
        ? planArguments.size
        : config.imageSize;
      const payload = typeof imagesService.buildImageRequestPayload === 'function'
        ? imagesService.buildImageRequestPayload({
            model: config.imageModel,
            prompt: styledPrompt,
            size: requestedSize,
            quality: planArguments.quality,
            background: planArguments.background,
            output_format: planArguments.output_format,
          })
        : { model: config.imageModel, prompt: styledPrompt };
      if (Number(planArguments.count) > 1) payload.n = Number(planArguments.count);
      if (imageInputs.length > 1) payload.image_role_map = JSON.stringify(buildImageRoleMap(imageInputs));
      if (!String(payload.prompt || '').trim()) {
        const error = new Error('Image task prompt is missing');
        error.code = 'IMAGE_EXECUTION_PROMPT_MISSING';
        error.statusCode = 400;
        throw error;
      }
      const materializedContract = dispatchContract.withArguments(contract, {
        prompt: String(payload.prompt || '').trim(),
        size: payload.size || 'auto',
        quality: payload.quality || 'auto',
        background: payload.background || 'auto',
        output_format: payload.output_format || 'auto',
        count: Number(payload.n) || Number(planArguments.count) || 1,
      });

      const imageContext = typeof imagesService.createImageContext === 'function'
        ? imagesService.createImageContext({
            prompt,
            routePrompt: routePrompt || promptFallback || prompt,
            resolvedGoal: resolvedGoal || routePrompt || promptFallback || prompt,
            taskState,
            mode: productMode,
            target: executionTarget,
            usePreviousImage: usesPriorInput,
            selectedReferenceId,
            selectedIndexes,
            selectedImageIds,
            attachments: persistedInputs,
            masks: persistedMasks,
            makeImageItemId,
          })
        : {
            prompt,
            routePrompt: routePrompt || promptFallback || prompt,
            resolvedGoal: resolvedGoal || routePrompt || promptFallback || prompt,
            ...(taskState ? { taskState } : {}),
            mode: productMode,
            target: executionTarget,
            usePreviousImage: usesPriorInput,
            selectedReferenceId,
            selectedIndexes,
            selectedImageIds,
            attachments: persistedInputs,
            masks: persistedMasks,
          };

      let files = [];
      let maskFiles = [];
      if (requiresImageEdit) {
        files = await imageFilesToJobPayload(imageInputs);
        maskFiles = await imageFilesToJobPayload(masks);
        if (imageInputs.length && files.length !== imageInputs.length) {
          const restored = await restoreImageAttachmentsFromContext(imageContext);
          if (restored.length === imageInputs.length) {
            files = await imageFilesToJobPayload(restored);
          }
        }
        if (files.length !== imageInputs.length) {
          const error = new Error('Some edit image data could not be restored');
          error.code = 'IMAGE_EDIT_DATA_UNAVAILABLE';
          error.statusCode = 400;
          throw error;
        }
        if (masks.length && maskFiles.length !== masks.length) {
          const restoredMasks = await restoreImageAttachmentsFromContext(imageContext, { role: 'mask' });
          if (restoredMasks.length === masks.length) maskFiles = await imageFilesToJobPayload(restoredMasks);
        }
        if (maskFiles.length !== masks.length) {
          const error = new Error('Mask image data could not be restored');
          error.code = 'IMAGE_MASK_DATA_UNAVAILABLE';
          error.statusCode = 400;
          throw error;
        }
        dispatchContract.assertPayloadMatchesDispatchContract(materializedContract, {
          payload,
          mode: 'edit_image',
          files,
          masks: maskFiles,
          bindingEvidence,
        });
      } else {
        dispatchContract.assertPayloadMatchesDispatchContract(materializedContract, {
          payload,
          mode: 'image',
          files: [],
          masks: [],
          bindingEvidence,
        });
      }

      const jobId = String(childJobId || (typeof makeClientImageJobId === 'function' ? makeClientImageJobId() : '') || '').trim();
      return {
        jobId,
        prompt,
        styledPrompt,
        mode: productMode,
        payload,
        dispatchContract: materializedContract,
        bindingEvidence,
        files,
        masks: maskFiles,
        imageContext,
        imageContextText: JSON.stringify(normalizeImageContextForStorage(imageContext)),
        usesPriorInput,
        isReferenceGeneration: isRefGen,
      };
    }

    return Object.freeze({ prepareImageExecutionRequest });
  }

  const api = Object.freeze({ createImageTaskPreparation });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('imageTaskPreparation', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
