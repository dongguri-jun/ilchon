/**
 * The initial's size in an Avatar: 42% of the circle, never under the 11px floor
 * (--fs-11). A 24px avatar used to give 10px.
 * Its own file so scripts/check-i18n.ts T18 can check it without the CSS import.
 */
export function avatarFontSize(size: number): number {
  return Math.max(11, Math.round(size * 0.42))
}
