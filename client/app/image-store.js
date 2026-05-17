(function(){
  const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

  function createImageStore({ dbName = 'openapi-chat-image-db-v1', storeName = 'images', indexedDBImpl = indexedDB } = {}) {
    function openImageDb() {
      return new Promise((resolve, reject) => {
        const req = indexedDBImpl.open(dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(storeName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    async function putImageBlob(key, blob) {
      const db = await openImageDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(blob, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }

    async function getImageBlob(key) {
      const db = await openImageDb();
      return new Promise((resolve, reject) => {
        const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    }

    async function clearImageDb() {
      try {
        const db = await openImageDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).clear();
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        console.warn('clear image db failed', err);
      }
    }

    async function deleteImageDbKeys(keys = []) {
      const uniqueKeys = [...new Set((keys || []).filter(Boolean))];
      if (!uniqueKeys.length) return;
      try {
        const db = await openImageDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          uniqueKeys.forEach(key => store.delete(key));
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        console.warn('delete image db keys failed', err);
      }
    }

    async function getImageDbKeys() {
      try {
        const db = await openImageDb();
        return await new Promise((resolve, reject) => {
          const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys();
          req.onsuccess = () => resolve([...req.result]);
          req.onerror = () => reject(req.error);
        });
      } catch (err) {
        console.warn('list image db keys failed', err);
        return [];
      }
    }

    return Object.freeze({ openImageDb, putImageBlob, getImageBlob, clearImageDb, deleteImageDbKeys, getImageDbKeys });
  }

  function collectIndexedDbKeys(value, keys = new Set()) {
    if (!value) return keys;
    if (typeof value === 'string') {
      const re = /indexeddb:\/\/([^"'<>`\s]+)/g;
      let match;
      while ((match = re.exec(value))) keys.add(match[1]);
      return keys;
    }
    if (Array.isArray(value)) {
      value.forEach(item => collectIndexedDbKeys(item, keys));
      return keys;
    }
    if (typeof value === 'object') Object.values(value).forEach(item => collectIndexedDbKeys(item, keys));
    return keys;
  }

  function dataUrlToBlob(dataUrl) {
    return fetch(dataUrl).then(res => res.blob());
  }

  async function imageBlobSize(blob) {
    if (!blob) return null;
    try {
      if (typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(blob);
        return { width: bmp.width, height: bmp.height };
      }
    } catch {}
    return new Promise(resolve => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        const size = { width: img.naturalWidth, height: img.naturalHeight };
        URL.revokeObjectURL(url);
        resolve(size);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  function fitImageThumb(width, height, maxWidth = 360, maxHeight = 240) {
    let w = Number(width) || maxWidth;
    let h = Number(height) || maxHeight;
    if (!(w > 0 && h > 0)) return { width: maxWidth, height: maxHeight };
    const scale = Math.min(maxWidth / w, maxHeight / h, 1);
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
  }

  window.ChatUIApp = Object.freeze({
    ...(window.ChatUIApp || {}),
    imageStore: Object.freeze({
      TRANSPARENT_PIXEL,
      createImageStore,
      collectIndexedDbKeys,
      dataUrlToBlob,
      imageBlobSize,
      fitImageThumb,
    }),
  });
})();
