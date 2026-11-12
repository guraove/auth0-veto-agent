import { useAuth0 } from '@auth0/auth0-react'
import { useEffect, useState } from 'react'

type Config = { ready: boolean; repo: string; issueNumber: number | null; channel: string }
type Issue = { number: number; title: string; state: string; html_url: string }
type Proposal = { id: string; state: string; message: string; expiresAt?: number; nextPollAt?: number; issueUrl: string }
const finalStates = ['closed', 'denied', 'expired', 'failed', 'execution_unknown']

export default function App() {
  const { user, isAuthenticated, isLoading, error, loginWithRedirect, logout,
    getAccessTokenSilently, connectAccountWithRedirect } = useAuth0()
  const [config, setConfig] = useState<Config>()
  const [issue, setIssue] = useState<Issue>()
  const [proposal, setProposal] = useState<Proposal>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [command, setCommand] = useState('Close the demo issue')
  async function api<T>(path: string, method = 'GET'): Promise<T> {
    const token = await getAccessTokenSilently()
    const response = await fetch(`/api/${path}`, { method, headers: { Authorization: `Bearer ${token}` } })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Request failed')
    return result
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage('')
    try { await action() } catch (e) { setMessage(e instanceof Error ? e.message : 'Request failed') }
    finally { setBusy(false) }
  }
  useEffect(() => {
    if (isAuthenticated) void run(async () => setConfig(await api<Config>('config')))
    // The provider changes token helpers during initialization; load once per login.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated])
  useEffect(() => {
    if (!proposal || finalStates.includes(proposal.state)) return
    const delay = Math.max(1000, (proposal.nextPollAt || Date.now() + 5000) - Date.now())
    const timer = window.setTimeout(() => {
      void api<Proposal>(`proposals/${proposal.id}/poll`, 'POST').then(setProposal).catch(e => setMessage(String(e)))
    }, delay)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal])
  async function submit() {
    if (!/^close (the )?demo issue[.!]?$/i.test(command.trim())) {
      setMessage('Supported command: “Close the demo issue”. The target is fixed by the server.'); return
    }
    await run(async () => setProposal(await api<Proposal>('proposals', 'POST')))
  }
  return <div className="shell">
    <header><a className="brand" href="/">V<span className="dot">.</span> <span>VETO AGENT</span></a>
      <span className="tag">AUTH0 × MLH</span></header>
    <main>
      <div className="eyebrow">TOKEN VAULT · ASYNCHRONOUS AUTHORIZATION</div>
      <h1>An assistant with<br /><em>a human veto.</em></h1>
      <p className="intro">Read your GitHub demo issue through Token Vault. A close command waits for your decision outside this conversation.</p>
      {error && <p role="alert" className="error">{error.message}</p>}
      {isLoading ? <p>Loading identity…</p> : !isAuthenticated ? <section className="card login">
        <div><span className="step">01 / IDENTITY</span><h2>Start with your identity.</h2><p>Sign in to connect GitHub and request an approval.</p></div>
        <button onClick={() => void loginWithRedirect()}>Log in with Auth0 ↗</button>
      </section> : <>
        <div className="identity"><span className="status-dot" />Signed in as {user?.name || user?.email}
          <button className="text-button" onClick={() => void logout({ logoutParams: { returnTo: window.location.origin } })}>Log out</button></div>
        <div className="grid">
          <section className="card"><span className="step">01 / CONNECTED ACCOUNT</span><h2>GitHub, through the vault.</h2>
            <p>Provider tokens stay on the server. Only one configured demo issue can be changed.</p>
            <button className="secondary" disabled={busy || !config?.ready} onClick={() => void run(async () => {
              await connectAccountWithRedirect({ connection: import.meta.env.VITE_GITHUB_CONNECTION || 'github-veto',
                scopes: ['read:user', 'public_repo'], redirectUri: window.location.origin })
            })}>Connect GitHub ↗</button>
            <button className="secondary" disabled={busy || !config?.ready} onClick={() => void run(async () => setIssue(await api<Issue>('issue')))}>Read demo issue</button>
            {issue && <div className="issue"><span className="pill">{issue.state}</span><h3>#{issue.number} {issue.title}</h3><a href={issue.html_url} target="_blank" rel="noreferrer">View on GitHub ↗</a></div>}
          </section>
          <section className="card"><span className="step">02 / SENSITIVE ACTION</span><h2>You have the final say.</h2>
            <p>Sending a close command starts a CIBA request. Approve or deny through {config?.channel === 'email' ? 'Auth0 email' : 'Auth0 Guardian'}.</p>
            <label htmlFor="command">Message to the assistant</label><input id="command" value={command} onChange={e => setCommand(e.target.value)} />
            <button disabled={busy || !config?.ready || !issue || issue.state !== 'open' || !!proposal} onClick={() => void submit()}>Request close approval ↗</button>
            {proposal && <div className="proposal" aria-live="polite"><span className="pill">{proposal.state}</span><p>{proposal.message}</p>
              {proposal.expiresAt && <small>Expires {new Date(proposal.expiresAt).toLocaleTimeString()}</small>}
              <a href={proposal.issueUrl} target="_blank" rel="noreferrer">Inspect issue ↗</a>
              {!finalStates.includes(proposal.state) && <button className="text-button" onClick={() => void run(async () => setProposal(await api<Proposal>(`proposals/${proposal.id}/poll`, 'POST')))}>Refresh status</button>}
            </div>}
          </section>
        </div>
        {config && !config.ready && <aside className="setup"><strong>Integration setup pending</strong><p>The application is ready for configuration. Token Vault credentials, a CIBA channel and a designated demo issue are required before any external action is enabled.</p></aside>}
        {message && <p className="error" role="alert">{message}</p>}
      </>}
      <div className="flow"><span>Verified user</span><b>→</b><span>Token Vault read</span><b>→</b><span>Out-of-band approval</span><b>→</b><span>One permitted write</span></div>
    </main><footer><span>MLH Builders Week / Veto Agent</span><span>Tool-driven demo · No simulated approvals</span></footer>
  </div>
}
