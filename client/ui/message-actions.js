function copySuccessState(successIconSvg, previousHtml) {
  return { className: 'copied', html: successIconSvg, restoreHtml: previousHtml, timeoutMs: 900 };
}

async function copyText(text, clipboard, documentRef) {
  if (clipboard?.writeText) return clipboard.writeText(text);
  const textarea = documentRef.createElement('textarea');
  textarea.value = text;
  documentRef.body.appendChild(textarea);
  textarea.select();
  documentRef.execCommand('copy');
  textarea.remove();
}

module.exports = { copySuccessState, copyText };
