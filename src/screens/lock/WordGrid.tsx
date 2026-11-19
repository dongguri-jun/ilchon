import './lock.css'

/**
 * The 12 words, numbered, in two columns (1-6, 7-12), to copy onto paper by hand.
 * No copy button: the clipboard is readable by other apps.
 */
export function WordGrid({ words }: { words: string[] }) {
  return (
    <ol className="lock-words t-body1">
      {words.map((w, i) => (
        <li key={i} className="lock-words__item">
          <span className="lock-words__n num" aria-hidden="true">
            {i + 1}.
          </span>
          <span className="lock-words__w">{w}</span>
        </li>
      ))}
    </ol>
  )
}
