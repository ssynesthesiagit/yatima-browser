const form = document.querySelector('#address-form')
const input = document.querySelector('#address')
const hint = document.querySelector('#address-hint')

const WEB_PROTOCOLS = new Set(['http:', 'https:'])
const HOST_PATTERN = /^(?:localhost(?::\d+)?|(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?|(?:[\w-]+\.)+[a-z]{2,})(?:[/?#].*)?$/i

function destinationFor(value) {
  const query = value.trim()

  if (!query) return null

  if (/^[a-z][a-z\d+.-]*:/i.test(query)) {
    try {
      const url = new URL(query)
      return WEB_PROTOCOLS.has(url.protocol) ? url.href : null
    } catch {
      return null
    }
  }

  if (HOST_PATTERN.test(query)) {
    try {
      return new URL(`https://${query}`).href
    } catch {
      return null
    }
  }

  return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}

form?.addEventListener('submit', (event) => {
  event.preventDefault()

  const destination = destinationFor(input?.value ?? '')
  if (!destination) {
    if (hint) {
      hint.textContent = 'Use an http(s) address or a search phrase.'
      hint.dataset.error = 'true'
    }
    input?.focus()
    return
  }

  if (hint) {
    hint.textContent = 'Opening…'
    delete hint.dataset.error
  }
  window.location.assign(destination)
})
