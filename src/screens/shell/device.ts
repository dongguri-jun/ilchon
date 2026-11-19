/** Hosts the dev server runs on. The ?p=a, ?p=b workflow needs a desktop browser there. */
export function isDevHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
}

export function isPhone(userAgent: string, maxTouchPoints: number): boolean {
  if (/Android|iPhone|iPad/.test(userAgent)) return true
  // iPadOS reports itself as a Mac, and an Android phone on "Desktop site" as desktop Linux;
  // only the touch points give them away. A touchscreen Linux laptop passes too: this is guidance.
  return /Macintosh|X11; Linux/.test(userAgent) && maxTouchPoints > 1
}

/**
 * Whether a device with no key yet should be sent to a phone.
 * This is guidance, not a security boundary: the user agent can be changed at will,
 * and the app code is public anyway.
 */
export function needsPhoneGate(userAgent: string, maxTouchPoints: number, hostname: string): boolean {
  return !isPhone(userAgent, maxTouchPoints) && !isDevHost(hostname)
}

/**
 * Browsers embedded in another app. Best effort: new apps and markers will slip through.
 * The second line adds more in-app browsers (Yahoo! JAPAN, X/Twitter, TikTok, Snapchat,
 * LinkedIn, Daum, Everytime); their exact user-agent pieces were not checked on devices.
 */
export function isInAppBrowser(userAgent: string): boolean {
  return /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\/|; wv\)/.test(userAgent) || /YJApp|Twitter|TikTok|musical_ly|Bytedance|Snapchat|LinkedInApp|DaumApps|everytimeApp/.test(userAgent)
}
