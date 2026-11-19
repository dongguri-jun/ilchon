// Runs before the app bundle. A separate file so a future CSP needs no 'unsafe-inline'.
// If the bundle never mounts (bad network, failed chunk), the user still gets a way out.
;(function () {
  // [loading, taking a while]. Korean is also in index.html for when this script fails.
  var COPY = {
    ko: ['불러오고 있어요', '시간이 오래 걸리고 있어요. 눌러서 새로고침해 주세요.'],
    en: ['Loading', 'This is taking a while. Tap to reload.'],
    ja: ['読み込んでいます', '時間がかかっています。タップして再読み込みしてください。'],
  }
  // Languages the deploy build offers. Must match offeredLangs() of src/i18n/lang.ts
  // (JA_STAGE); check-i18n T14 compares them. The change that turns Japanese on adds 'ja'.
  var OFFERED = ['ko', 'en']

  // Same rule as pickLang in src/i18n/detect.ts: the first browser language that is
  // offered, else English. Nothing is read from storage (the phone's language rules
  // before unlock).
  var lang = 'en'
  try {
    var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]
    for (var i = 0; i < list.length; i++) {
      var base = String(list[i] || '').split(/[-_]/)[0].toLowerCase()
      if (OFFERED.indexOf(base) >= 0) {
        lang = base
        break
      }
    }
  } catch (e) {
    lang = 'en'
  }
  // Set at once so the first paint already has the right font and line breaking.
  document.documentElement.lang = lang

  var splash = document.getElementById('boot-splash')
  if (!splash) return
  var text = splash.querySelector('p')
  var reload = splash.querySelector('button')
  text.textContent = COPY[lang][0]
  reload.textContent = COPY[lang][1]

  reload.addEventListener('click', function () {
    location.reload()
  })
  setTimeout(function () {
    // React removes the splash when it mounts.
    if (document.getElementById('boot-splash')) reload.hidden = false
  }, 12000)
})()
