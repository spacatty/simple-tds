import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createHashRouter } from 'react-router-dom'
import App from './App'
import '@fontsource/sora/latin-600.css'
import './styles.css'

// A data router, not <HashRouter>: only it lets a page hold the user back from leaving unsaved edits.
const router = createHashRouter([{ path: '*', element: <App /> }])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
