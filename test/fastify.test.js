const assert           = require('node:assert/strict')
const { afterEach }    = require('node:test')
const { describe, it } = require('node:test')
const { FastifyServer } = require('../cjs/fastify')
const { fastifyRequest } = require('../cjs/fastify')
const { Response }     = require('@itrocks/request-response')

const servers = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map(server => server.stop()))
})

describe('Fastify session integration', () => {
	it('keeps the transport-neutral session attached after regeneration', async () => {
		const raw = {
			body:        {},
			headers:     {},
			hostname:    'localhost',
			isMultipart: () => false,
			method:      'POST',
			params:      { '*': 'user/authenticate' },
			port:        3000,
			protocol:    'http',
			query:       {},
			session:     undefined
		}
		raw.session = {
			async regenerate()
			{
				raw.session = {}
			}
		}
		const request = await fastifyRequest(raw)

		await request.session.regenerate()
		request.session.user = { id: 42 }

		assert.deepEqual(raw.session.user, { id: 42 })
	})

	it('sets expiring HttpOnly SameSite cookies and Secure over HTTPS', async () => {
		const sessions = new Map()
		const store    = {
			destroy: (id, callback) => { sessions.delete(id); callback() },
			get:     (id, callback) => callback(null, sessions.get(id)),
			set:     (id, session, callback) => { sessions.set(id, session); callback() }
		}
		const server = new FastifyServer({
			assetPath:   process.cwd(),
			cookie:      { maxAge: 8 * 60 * 60 * 1000, sameSite: 'lax' },
			execute:     async request => {
				request.session.user = { id: 42 }
				return new Response('ok')
			},
			favicon:     '',
			frontScripts: [],
			host:        '127.0.0.1',
			port:        0,
			scriptCalls: [],
			secret:      'a-secure-test-secret-with-32-characters',
			secure:      'auto',
			store
		})
		servers.push(server)
		server.prepare()
		await server.server.ready()

		const response = await server.server.inject({
			headers: { 'x-forwarded-proto': 'https' },
			method:  'GET',
			url:     '/private'
		})
		const cookie = response.headers['set-cookie']
		const expires = /Expires=([^;]+)/i.exec(cookie)?.[1]

		assert.match(cookie, /HttpOnly/i)
		assert.match(cookie, /SameSite=Lax/i)
		assert.match(cookie, /Secure/i)
		assert.ok(expires)
		assert.ok(Math.abs(Date.parse(expires) - Date.now() - (8 * 60 * 60 * 1000)) < 2_000)
	})

	it('preserves proxy-friendly generic cookie defaults', async () => {
		const sessions = new Map()
		const server   = new FastifyServer({
			assetPath:   process.cwd(),
			execute:     async request => {
				request.session.user = { id: 42 }
				return new Response('ok')
			},
			favicon:     '',
			frontScripts: [],
			host:        '127.0.0.1',
			port:        0,
			scriptCalls: [],
			secret:      'a-secure-test-secret-with-32-characters',
			secure:      'auto',
			store:       {
				destroy: (id, callback) => { sessions.delete(id); callback() },
				get:     (id, callback) => callback(null, sessions.get(id)),
				set:     (id, session, callback) => { sessions.set(id, session); callback() }
			}
		})
		servers.push(server)
		server.prepare()
		await server.server.ready()

		const proxied = await server.server.inject({
			headers: { 'x-forwarded-proto': 'https' },
			method:  'GET',
			url:     '/private'
		})
		const local = await server.server.inject({ method: 'GET', url: '/private' })

		assert.match(proxied.headers['set-cookie'], /HttpOnly/i)
		assert.match(proxied.headers['set-cookie'], /SameSite=None/i)
		assert.match(proxied.headers['set-cookie'], /Secure/i)
		assert.match(local.headers['set-cookie'], /HttpOnly/i)
		assert.match(local.headers['set-cookie'], /SameSite=Lax/i)
		assert.doesNotMatch(local.headers['set-cookie'], /Secure/i)
	})
})
