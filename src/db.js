const DB_NAME = 'folio-ebook-reader-db'
const DB_VERSION = 1

let dbPromise = null

const openDB = () => {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains('books')) {
                const store = db.createObjectStore('books', { keyPath: 'id' })
                store.createIndex('lastOpenedAt', 'lastOpenedAt', { unique: false })
                store.createIndex('addedAt', 'addedAt', { unique: false })
            }
            if (!db.objectStoreNames.contains('annotations')) {
                const store = db.createObjectStore('annotations', { keyPath: 'id' })
                store.createIndex('bookId', 'bookId', { unique: false })
            }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
    return dbPromise
}

const tx = async (storeName, mode, fn) => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode)
        const store = transaction.objectStore(storeName)
        let result
        try {
            result = fn(store)
        } catch (err) {
            reject(err)
            return
        }
        if (result && typeof result.onsuccess !== 'undefined') {
            result.onsuccess = () => resolve(result.result)
            result.onerror = () => reject(result.error)
        } else {
            transaction.oncomplete = () => resolve(result)
            transaction.onerror = () => reject(transaction.error)
        }
    })
}

export const getAllBooks = async () => {
    const books = await tx('books', 'readonly', store => store.getAll())
    return books || []
}

export const getBook = async id => {
    return tx('books', 'readonly', store => store.get(id))
}

export const saveBook = async bookRecord => {
    await tx('books', 'readwrite', store => store.put(bookRecord))
    return bookRecord
}

export const updateBookProgress = async (id, patch) => {
    const existing = await getBook(id)
    if (!existing) return null
    const updated = { ...existing, ...patch }
    await saveBook(updated)
    return updated
}

export const deleteBook = async id => {
    const db = await openDB()
    await new Promise((resolve, reject) => {
        const transaction = db.transaction(['books', 'annotations'], 'readwrite')
        transaction.objectStore('books').delete(id)
        const annStore = transaction.objectStore('annotations')
        const idx = annStore.index('bookId')
        const cursorReq = idx.openCursor(IDBKeyRange.only(id))
        cursorReq.onsuccess = e => {
            const cursor = e.target.result
            if (cursor) {
                cursor.delete()
                cursor.continue()
            }
        }
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
    })
}

export const getAnnotations = async bookId => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('annotations', 'readonly')
        const idx = transaction.objectStore('annotations').index('bookId')
        const req = idx.getAll(IDBKeyRange.only(bookId))
        req.onsuccess = () => {
            const list = req.result || []
            list.sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0) || a.createdAt - b.createdAt)
            resolve(list)
        }
        req.onerror = () => reject(req.error)
    })
}

export const saveAnnotation = async annotation => {
    await tx('annotations', 'readwrite', store => store.put(annotation))
    return annotation
}

export const deleteAnnotation = async id => {
    await tx('annotations', 'readwrite', store => store.delete(id))
}
