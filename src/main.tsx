import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Auth0Provider } from '@auth0/auth0-react'
import App from './App'
import './index.css'

const domain = import.meta.env.VITE_AUTH0_DOMAIN
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID
createRoot(document.getElementById('root')!).render(<StrictMode>
  {domain && clientId ? <Auth0Provider domain={domain} clientId={clientId}
    authorizationParams={{ redirect_uri: window.location.origin, audience: import.meta.env.VITE_AUTH0_AUDIENCE }}>
    <App />
  </Auth0Provider> : <main><h1>Veto Agent</h1><p>Add your Auth0 domain and SPA Client ID to .env to start.</p></main>}
</StrictMode>)
