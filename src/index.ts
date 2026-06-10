import { Hono } from 'hono'
import type { Bindings } from './config'
import { corsMiddleware } from './middleware/cors'
import { proxyHandler } from './handlers/proxy'

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => c.json({ status: 'ok' }))

app.use('*', corsMiddleware())

app.all('*', proxyHandler)

export default app
