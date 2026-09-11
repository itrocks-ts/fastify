const { Response }         = require('@itrocks/request-response')
const assert               = require('node:assert/strict')
const { mkdir, mkdtemp }   = require('node:fs/promises')
const { rm, writeFile }    = require('node:fs/promises')
const { tmpdir }           = require('node:os')
const { join }             = require('node:path')
const { afterEach }        = require('node:test')
const { describe, it }     = require('node:test')
const { FastifyServer }    = require('../cjs/fastify')
const { fastifyRequest }   = require('../cjs/fastify')

const servers              = []
const temporaryDirectories = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map(server => server.stop()))
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
		force:     true,
		recursive: true
	})))
})

describe('Fastify front script allowlist', () => {
	it('discovers bounded imports and escaped configured calls inside the asset path', async () => {
		const assetPath  = await mkdtemp(join(tmpdir(), 'itrocks-fastify-'))
		const scriptPath = join(assetPath, 'front')
		temporaryDirectories.push(assetPath)
		await mkdir(scriptPath, { recursive: true })
		await writeFile(join(scriptPath, 'entry.js'), [
			"export { value } from './exported.js'",
			"import './first.js'; const name = 'tail.js'",
			"import './static.js'",
			"import('./dynamic.js')",
			"load.script('./called.js')",
			"loadXscript('./not-called.js')",
			"import '../../../outside.js'"
		].join('\n'))

		const server = new FastifyServer({
			assetPath,
			execute:      async () => new Response('delegated'),
			favicon:      '',
			frontScripts: ['/front/entry.js'],
			host:         '127.0.0.1',
			port:         0,
			scriptCalls:  ['load.script'],
			secret:       'a-secure-test-secret-with-32-characters',
			secure:       'auto',
			store:        {
				destroy: (_id, callback) => callback(),
				get:     (_id, callback) => callback(null),
				set:     (_id, _session, callback) => callback()
			}
		})

		await server.addImportsToFrontScripts(join(scriptPath, 'entry.js'))

		assert.deepEqual(server.config.frontScripts.sort(), [
			'/front/called.js',
			'/front/dynamic.js',
			'/front/entry.js',
			'/front/exported.js',
			'/front/first.js',
			'/front/static.js'
		])
	})

	it('discovers dependencies recursively as each allowed script is requested', async () => {
		const assetPath  = await mkdtemp(join(tmpdir(), 'itrocks-fastify-'))
		const scriptPath = join(assetPath, 'node_modules/@itrocks/lazy-test')
		temporaryDirectories.push(assetPath)
		await mkdir(scriptPath, { recursive: true })
		await Promise.all([
			writeFile(join(scriptPath, 'child.js'), "import './grandchild.js'\n"),
			writeFile(join(scriptPath, 'entry.js'), "import './child.js'\n"),
			writeFile(join(scriptPath, 'grandchild.js'), 'export const value = true\n')
		])

		const delegated   = []
		const frontScripts = ['/@itrocks/lazy-test/entry.js']
		const server = await frontServer(assetPath, delegated, frontScripts)

		const childBeforeEntry = await server.server.inject({
			method: 'GET',
			url:    '/@itrocks/lazy-test/child.js'
		})
		assert.equal(childBeforeEntry.body, 'delegated')

		const entry = await server.server.inject({
			method: 'GET',
			url:    '/@itrocks/lazy-test/entry.js'
		})
		assert.equal(entry.body, "import './child.js'\n")
		assert.equal(frontScripts.includes('/@itrocks/lazy-test/child.js'), true)
		assert.equal(frontScripts.includes('/@itrocks/lazy-test/grandchild.js'), false)

		const grandchildBeforeChild = await server.server.inject({
			method: 'GET',
			url:    '/@itrocks/lazy-test/grandchild.js'
		})
		assert.equal(grandchildBeforeChild.body, 'delegated')

		const child = await server.server.inject({
			method: 'GET',
			url:    '/@itrocks/lazy-test/child.js'
		})
		assert.equal(child.body, "import './grandchild.js'\n")
		assert.equal(frontScripts.includes('/@itrocks/lazy-test/grandchild.js'), true)

		const grandchild = await server.server.inject({
			method: 'GET',
			url:    '/@itrocks/lazy-test/grandchild.js'
		})
		assert.equal(grandchild.body, 'export const value = true\n')
		assert.deepEqual(delegated, [
			'/@itrocks/lazy-test/child.js',
			'/@itrocks/lazy-test/grandchild.js'
		])
	})

	it('ignores a source file outside the asset path', async () => {
		const assetPath   = await mkdtemp(join(tmpdir(), 'itrocks-fastify-'))
		const outsidePath = await mkdtemp(join(tmpdir(), 'itrocks-fastify-outside-'))
		temporaryDirectories.push(assetPath, outsidePath)
		await writeFile(join(outsidePath, 'entry.js'), "import './private.js'\n")

		const server = new FastifyServer({
			assetPath,
			execute:      async () => new Response('delegated'),
			favicon:      '',
			frontScripts: [],
			host:         '127.0.0.1',
			port:         0,
			scriptCalls:  [],
			secret:       'a-secure-test-secret-with-32-characters',
			secure:       'auto',
			store:        {
				destroy: (_id, callback) => callback(),
				get:     (_id, callback) => callback(null),
				set:     (_id, _session, callback) => callback()
			}
		})

		await server.addImportsToFrontScripts(join(outsidePath, 'entry.js'))

		assert.deepEqual(server.config.frontScripts, [])
	})
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

async function frontServer(assetPath, delegated, frontScripts)
{
	const server = new FastifyServer({
		assetPath,
		execute: async request => {
			delegated.push(request.path)
			return new Response('delegated')
		},
		favicon:     '',
		frontScripts,
		host:        '127.0.0.1',
		port:        0,
		scriptCalls: [],
		secret:      'a-secure-test-secret-with-32-characters',
		secure:      'auto',
		store:       {
			destroy: (_id, callback) => callback(),
			get:     (_id, callback) => callback(null),
			set:     (_id, _session, callback) => callback()
		}
	})
	servers.push(server)
	server.prepare()
	await server.server.ready()
	return server
}
