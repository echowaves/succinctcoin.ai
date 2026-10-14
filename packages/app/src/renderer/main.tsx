/**
 * `app/renderer/main` — the 6.3 React entry: mount `<App />` into the
 * `#root` element (the `index.html` shell). The CSP allows same-origin
 * scripts only — the Vite bundle is same-origin (`base: './'`).
 */
import { createRoot } from 'react-dom/client'

import { App } from './App.js'

const rootEl = document.getElementById('root')
if (rootEl === null) {
  throw new Error('succinctcoin: the #root element is missing (the index.html shell)')
}

createRoot(rootEl).render(<App />)
