import { Hono } from 'hono'
import type { Bindings } from './config'
import { proxyHandler } from './handlers/proxy'
import { corsMiddleware } from './middleware/cors'

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', corsMiddleware())

app.get('/health', (c) => c.json({ status: 'ok' }))

app.all('*', proxyHandler)

export default app
