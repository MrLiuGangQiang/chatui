(function initChatUIImageExecution(root) {
  'use strict';

  const MODULE_REGISTRY_SYMBOL = Symbol.for('chatui.module-registry.v1');
  const dispatchContractContract = root?.[MODULE_REGISTRY_SYMBOL]?.get('dispatchContract')
    || root?.ChatUIDispatchContract
    || (typeof require === 'function' ? require('../../shared/dispatch-contract') : {});
  function currentDispatchContractContract() {
    return root?.[MODULE_REGISTRY_SYMBOL]?.get('dispatchContract')
      || root?.ChatUIDispatchContract
      || dispatchContractContract;
  }

  function imageRoleLabel(role = "") {
    return role === "target"
      ? "作为编辑目标图（唯一需要修改的底图）"
      : role === "style_reference"
        ? "仅作为风格参考（不是内容来源或编辑目标）"
        : "作为内容参考（用户已确认的替换或新增内容来源，不是编辑目标）";
  }

  function imagePositionsWithRole(imageInputs = [], roles = []) {
    const allowed = new Set(roles);
    return imageInputs
      .map((item, index) => allowed.has(String(item?.routeRole || "")) ? index + 1 : 0)
      .filter(Boolean);
  }

  function imagePositionList(positions = []) {
    return positions.map(position => `图片${position}`).join("、");
  }

  function buildImageRoleGuide(imageInputs = [], dispatchContract = null) {
    if (!Array.isArray(imageInputs) || imageInputs.length <= 1) return "";
    const lines = [
      "随附图片角色（按上传顺序）：",
      ...imageInputs.map((item, index) => `- 图片${index + 1}：${imageRoleLabel(item?.routeRole)}`),
    ];
    const operation = String(dispatchContract?.operation || "");
    const targets = imagePositionsWithRole(imageInputs, ["target"]);
    const references = imagePositionsWithRole(imageInputs, ["reference"]);
    const styleReferences = imagePositionsWithRole(imageInputs, ["style_reference"]);
    if (operation === "edit_image") {
      if (targets.length === 1) lines.push(`- 编辑范围：所有修改只作用于${imagePositionList(targets)}。`);
      if (references.length) {
        lines.push(`- 内容来源：${imagePositionList(references)}只提供用户指令明确要求借鉴、替换或新增的主体与内容；除非用户明确要求，不要把参考图的背景、构图或无关元素带入目标图。`);
      }
      if (styleReferences.length) {
        lines.push(`- 风格来源：${imagePositionList(styleReferences)}只提供视觉风格，不替换目标图中的主体身份或内容。`);
      }
      lines.push("- 保留边界：除用户明确要求修改的部分外，保留目标图中的其他主体、背景、构图、文字、光线、色彩与风格。 ");
      if (references.length || styleReferences.length) {
        lines.push("- 融合要求：让修改后的尺度、透视、光照、阴影和遮挡关系与目标图自然一致，不要输出拼图、对比图或并排候选。 ");
      }
    } else if (operation === "image_reference_gen") {
      lines.push("- 输出类型：基于这些参考图生成一张新图片；所有输入图都不是直接编辑目标。 ");
      if (references.length) lines.push(`- 内容参考：仅从${imagePositionList(references)}提取用户明确要求使用的主体和内容。`);
      if (styleReferences.length) lines.push(`- 风格参考：仅从${imagePositionList(styleReferences)}提取视觉风格。`);
    }
    lines.push("请严格按上述角色使用各图片，不要根据候选编号重新猜测图片用途。");
    return lines.map(line => line.trimEnd()).join("\n");
  }

  function buildImageRoleMap(imageInputs = []) {
    if (!Array.isArray(imageInputs) || imageInputs.length <= 1) return [];
    return imageInputs.map((item, index) => ({
      position: index + 1,
      role: String(item?.routeRole || ""),
      resource_key: String(item?.routeResourceKey || ""),
      // The serialized file derives routeId from routeId/imageId/id and
      // routeReferenceId from routeReferenceId/referenceId. Use the exact
      // same fallback chain so the server's role-map/binding consistency
      // check never compares two different identity representations.
      id: String(item?.routeId || item?.imageId || item?.image_id || item?.id || ""),
      reference_id: String(item?.routeReferenceId || item?.referenceId || item?.reference_id || ""),
    }));
  }

  function createImageExecutionPolicy({ dispatchContract = null } = {}) {
    function routeResourceKeys(resources = []) {
      return Array.isArray(resources)
        ? resources.map((resource) => String(resource?.routeResourceKey || ""))
        : null;
    }

    function sameRouteResourceKeys(actual = [], expected = []) {
      const actualKeys = routeResourceKeys(actual);
      const expectedKeys = Array.isArray(expected)
        ? expected.map((resource) => String(resource?.key || ""))
        : null;
      return !!actualKeys
        && !!expectedKeys
        && actualKeys.length === expectedKeys.length
        && actualKeys.every((key, index) => key && key === expectedKeys[index]);
    }

    function executionAuthorization(contract = {}) {
      const planContract = dispatchContract?.hasExactDispatchContract
        ? dispatchContract
        : currentDispatchContractContract();
      if (!planContract?.hasExactDispatchContract?.(contract)) return null;
      return {
        operation: String(contract.operation || ''),
        api: String(contract.api || ''),
        resources: Array.isArray(contract.bindings) ? contract.bindings : [],
      };
    }

    function requireCanonicalImageExecution(contract = {}, executionMedia = {}) {
      const authorization = executionAuthorization(contract);
      if (!authorization) {
        throw new TypeError("A validated dispatch_contract.v1 image execution contract is required");
      }
      const { operation, api, resources } = authorization;
      if (!['image_generation', 'image_edit'].includes(api)) {
        throw new TypeError("The execution contract does not authorize an image request");
      }
      if (executionMedia?.version !== "execution_resources.v2"
          || executionMedia.operation !== operation) {
        throw new TypeError("A matching execution_resources.v2 projection is required");
      }
      const images = executionMedia.images;
      const files = executionMedia.files;
      const imageInputs = executionMedia.imageInputs;
      const masks = executionMedia.masks;
      const targets = executionMedia.targets;
      const references = executionMedia.references;
      if (![images, files, imageInputs, masks, targets, references].every(Array.isArray)) {
        throw new TypeError("The image execution projection is incomplete");
      }
      const expectedImages = resources.filter((resource) => resource.type === "image");
      const expectedFiles = resources.filter((resource) => resource.type === "file");
      const expectedInputs = expectedImages.filter((resource) => ["target", "reference", "style_reference"].includes(resource.role));
      const expectedMasks = expectedImages.filter((resource) => resource.role === "mask");
      const expectedTargets = expectedImages.filter((resource) => resource.role === "target");
      const expectedReferences = expectedImages.filter((resource) => ["reference", "style_reference"].includes(resource.role));
      if (!sameRouteResourceKeys(images, expectedImages)
          || !sameRouteResourceKeys(files, expectedFiles)
          || !sameRouteResourceKeys(imageInputs, expectedInputs)
          || !sameRouteResourceKeys(masks, expectedMasks)
          || !sameRouteResourceKeys(targets, expectedTargets)
          || !sameRouteResourceKeys(references, expectedReferences)) {
        throw new TypeError("The image execution projection does not match its execution contract");
      }
      for (let index = 0; index < images.length; index += 1) {
        const actual = images[index];
        const expected = expectedImages[index];
        const expectedResourceId = String(expected?.resource_id || expected?.resourceId || '');
        if (actual?.routeRole !== expected.role
            || actual?.routeSource !== expected.source
            || expectedResourceId && String(actual?.routeResourceId || '') !== expectedResourceId
            || !expectedResourceId && String(actual?.routeId || "") !== String(expected.id || "")
            || !expectedResourceId && String(actual?.routeReferenceId || "") !== String(expected.reference_id || "")) {
          throw new TypeError("An image execution binding no longer matches its execution contract");
        }
      }
      if (files.length || masks.length > 1) {
        throw new TypeError("The image execution projection contains unsupported media");
      }
      return Object.freeze({
        operation,
        api,
        imageInputs: [...imageInputs],
        masks: [...masks],
        targets: [...targets],
        references: [...references],
      });
    }

    return Object.freeze({ requireCanonicalImageExecution });
  }

  const api = Object.freeze({
    imageRoleLabel,
    imagePositionsWithRole,
    imagePositionList,
    buildImageRoleGuide,
    buildImageRoleMap,
    createImageExecutionPolicy,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('imageExecution', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
