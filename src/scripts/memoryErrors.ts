/** Errors that usually mean the browser/ONNX runtime could not allocate a model session. */
const MEMORY_ERROR_PATTERN =
  /(?:std::bad_alloc|bad_alloc|out\s+of\s+memory|memory\s+allocation|can't\s+create\s+a\s+session|error[_\s-]*code\s*:\s*6)/i

export function isMemoryAllocationError(error: unknown) {
  if ((error as any)?.code === "TRANSLATION_MEMORY") return true
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String((error as any)?.message || error || "")
  return MEMORY_ERROR_PATTERN.test(message)
}

export function memoryAllocationError(error: unknown, fallback = "Translation model needs more memory") {
  if (error instanceof Error && !isMemoryAllocationError(error)) return error
  const message = `${fallback}. Close other tabs or switch to API translation, then try again.`
  const wrapped = new Error(message)
  ;(wrapped as any).code = "TRANSLATION_MEMORY"
  ;(wrapped as any).cause = error
  return wrapped
}
