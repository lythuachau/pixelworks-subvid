/** Return true only when a reset happened after every advertised byte arrived. */
export function completedExpectedTransfer(
  transferred: number,
  contentLengthHeader: string | null,
): boolean {
  if (!contentLengthHeader) return false
  const expected = Number(contentLengthHeader)
  return (
    Number.isSafeInteger(expected) &&
    expected >= 0 &&
    transferred === expected
  )
}

/** Validate that a ranged retry starts at the exact byte already delivered. */
export function resumedTransferTotal(
  status: number,
  contentRange: string | null,
  expectedStart: number,
): number | null {
  if (status !== 206 || !contentRange) return null
  const match = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i)
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start !== expectedStart ||
    end < start ||
    total <= end
  ) {
    return null
  }
  return total
}
