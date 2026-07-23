const DB_NAME = "subvid-projects"
const DB_VERSION = 1
const PROJECT_STORE = "projects"
const MEDIA_STORE = "media"

export type ProjectState = Record<string, unknown>

export type StoredProjectSummary = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  mediaName?: string
  mediaSize?: number
  hasMedia?: boolean
}

type ProjectRecord = StoredProjectSummary & {
  state: ProjectState
}

type MediaRecord = {
  id: string
  blob: Blob
  name: string
  type: string
  lastModified: number
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"))
  })
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"))
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"))
  })
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        const projects = db.createObjectStore(PROJECT_STORE, { keyPath: "id" })
        projects.createIndex("updatedAt", "updatedAt")
      }
      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        db.createObjectStore(MEDIA_STORE, { keyPath: "id" })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error("Could not open project database"))
  })
}

export async function saveStoredProject(options: {
  id: string
  name: string
  state: ProjectState
  media?: File | null
  createdAt?: number
}) {
  const db = await openDatabase()
  const now = Date.now()
  const readTransaction = db.transaction(PROJECT_STORE, "readonly")
  const existing = await requestResult<ProjectRecord | undefined>(
    readTransaction.objectStore(PROJECT_STORE).get(options.id),
  )
  await transactionDone(readTransaction)

  const transaction = db.transaction([PROJECT_STORE, MEDIA_STORE], "readwrite")
  const projects = transaction.objectStore(PROJECT_STORE)
  const mediaStore = transaction.objectStore(MEDIA_STORE)
  let hasMedia = !!existing?.hasMedia

  if (options.media) {
    if (!existing?.hasMedia) {
      mediaStore.put({
        id: options.id,
        blob: options.media,
        name: options.media.name,
        type: options.media.type,
        lastModified: options.media.lastModified,
      } satisfies MediaRecord)
    }
    hasMedia = true
  }

  projects.put({
    id: options.id,
    name: options.name,
    createdAt: existing?.createdAt || options.createdAt || now,
    updatedAt: now,
    mediaName: options.media?.name || existing?.mediaName,
    mediaSize: options.media?.size || existing?.mediaSize,
    hasMedia,
    state: options.state,
  } satisfies ProjectRecord)
  await transactionDone(transaction)
  db.close()
  return now
}

export async function listStoredProjects(): Promise<StoredProjectSummary[]> {
  const db = await openDatabase()
  const transaction = db.transaction(PROJECT_STORE, "readonly")
  const records = await requestResult<ProjectRecord[]>(
    transaction.objectStore(PROJECT_STORE).getAll(),
  )
  await transactionDone(transaction)
  db.close()
  return records
    .map(({ state: _state, ...summary }) => summary)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadStoredProject(id: string) {
  const db = await openDatabase()
  const transaction = db.transaction([PROJECT_STORE, MEDIA_STORE], "readonly")
  const projectRequest = requestResult<ProjectRecord | undefined>(
    transaction.objectStore(PROJECT_STORE).get(id),
  )
  const mediaRequest = requestResult<MediaRecord | undefined>(
    transaction.objectStore(MEDIA_STORE).get(id),
  )
  const [project, media] = await Promise.all([projectRequest, mediaRequest])
  await transactionDone(transaction)
  db.close()
  if (!project) throw new Error("Project not found")
  const file = media
    ? new File([media.blob], media.name, {
        type: media.type,
        lastModified: media.lastModified,
      })
    : null
  return { project, file }
}

export async function deleteStoredProject(id: string) {
  const db = await openDatabase()
  const transaction = db.transaction([PROJECT_STORE, MEDIA_STORE], "readwrite")
  transaction.objectStore(PROJECT_STORE).delete(id)
  transaction.objectStore(MEDIA_STORE).delete(id)
  await transactionDone(transaction)
  db.close()
}
