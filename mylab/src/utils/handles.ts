const DB_NAME = 'dir_handles_v1';
const STORE = 'handles';

function withStore<T>(mode: IDBTransactionMode, cb: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(STORE);
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      cb(store).then(result => {
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onabort = tx.onerror = () => {
          reject(tx.error);
        };
      }).catch(err => reject(err));
    };
  });
}

export async function saveDirHandle(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore('readwrite', store => {
    store.put(handle, key);
    return Promise.resolve();
  });
}

export async function loadDirHandle(key: string): Promise<FileSystemDirectoryHandle | undefined> {
  return withStore('readonly', store => {
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result as FileSystemDirectoryHandle | undefined);
      req.onerror = () => reject(req.error);
    });
  });
}

export async function deleteDirHandle(key: string): Promise<void> {
  await withStore('readwrite', store => {
    store.delete(key);
    return Promise.resolve();
  });
}
