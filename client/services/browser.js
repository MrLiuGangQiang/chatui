(function () {
  const current = window.ChatUIServices || {};
  const composition = window.ChatUIServicesComposition || window.ChatUIServicesFallback || {};
  const models = current.models || composition.models || {};
  const jobs = current.jobs || composition.jobs || {};
  const chat = current.chat || composition.chat || {};
  const route = current.route || composition.route || {};
  const images = current.images || composition.images || {};
  const runtime = current.runtime || composition.runtime || {};

  window.ChatUIServices = Object.freeze({
    ...current,
    models: Object.freeze(models),
    jobs: Object.freeze(jobs),
    chat: Object.freeze(chat),
    route: Object.freeze(route),
    images: Object.freeze(images),
    runtime: Object.freeze(runtime),
  });
})();
