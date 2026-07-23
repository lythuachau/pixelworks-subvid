export const defaultLang = "vi" as const

// Display names for the language switcher.
export const languages = {
  vi: "Tiếng Việt",
} as const

export type Lang = keyof typeof languages
