type ShortcutLike = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
>

export function isDevtoolsShortcut(event: ShortcutLike) {
  const key = String(event.key || "").toLowerCase()
  if (key === "f12") return true

  const inspectKey = ["i", "j", "c", "k"].includes(key)
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && inspectKey)
    return true
  if (event.metaKey && event.altKey && inspectKey) return true
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && key === "u"
}

export function installDevtoolsGuard(
  toast: HTMLElement | null,
  message: string,
) {
  let hideTimer = 0

  const showBlockedNotice = () => {
    if (!toast) return
    window.clearTimeout(hideTimer)
    toast.textContent = message
    toast.hidden = false
    toast.dataset.visible = "true"
    hideTimer = window.setTimeout(() => {
      toast.dataset.visible = "false"
      toast.hidden = true
    }, 2400)
  }

  const blockShortcut = (event: KeyboardEvent) => {
    if (!isDevtoolsShortcut(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!event.repeat) showBlockedNotice()
  }

  window.addEventListener("keydown", blockShortcut, { capture: true })
  return () => {
    window.clearTimeout(hideTimer)
    window.removeEventListener("keydown", blockShortcut, { capture: true })
  }
}
