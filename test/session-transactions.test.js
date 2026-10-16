const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const { mkdtemp } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { Response } = require('@itrocks/request-response')
const { FileStore } = require('@itrocks/fastify-file-session-store')
const { FastifyServer, sessionTransaction } = require('../cjs/fastify')
const json = value => new Response(JSON.stringify(value), 200, { 'Content-Type': 'application/json' })
const deferred = () => {
	let resolve
	const promise = new Promise(done => { resolve = done })
	return { promise, resolve }
}

test('actual request bridge coordinates response autosave, selectors, lists, restart and revoke', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'http-session-transactions-'))
	let loaded = deferred(), release = deferred()
	const store = new FileStore(directory)
	const config = {
		assetPath: directory, favicon: '', frontScripts: [], host: '127.0.0.1', port: 0, scriptCalls: [],
		secret: randomBytes(32).toString('hex'), secure: false, cookie: { sameSite: 'lax' }, store,
		execute: async request => {
			const session = request.session
			if (request.path === '/seed') session.list = { invoice: { columns: ['number'], offset: 0 } }
			if (request.path === '/slow') {
				loaded.resolve(session.sessionId)
				await release.promise
				session.list.invoice.offset = 50
			}
			if (request.path === '/reload') {
				loaded.resolve(session.sessionId)
				await release.promise
				await session.reload()
			}
			if (request.path === '/column') session.list.invoice.columns = ['number', 'customer.name']
			if (request.path.startsWith('/state/')) await sessionTransaction(session, data => {
				data.propertySelect ??= {}
				data.propertySelect[request.path] = { revision: 1, state: { query: request.path } }
			})
			return json({ list: session.list, propertySelect: session.propertySelect })
		}
	}
	let server = new FastifyServer(config)
	let app = server.prepare()
	await app.ready()
	try {
		const seeded = await app.inject('/seed')
		const cookie = seeded.headers['set-cookie'].split(';')[0]
		const call = url => app.inject({ url, headers: { cookie } })
		const slow = call('/slow')
		await loaded.promise
		assert.equal((await call('/column')).statusCode, 200)
		const writes = await Promise.all([call('/state/a'), call('/state/b')])
		assert.deepEqual(writes.map(reply => reply.statusCode), [200, 200])
		release.resolve()
		assert.equal((await slow).statusCode, 200)
		await server.stop()
		server = new FastifyServer({ ...config, store: new FileStore(directory) })
		app = server.prepare()
		await app.ready()
		const restored = JSON.parse((await call('/read')).body)
		assert.deepEqual(restored.list.invoice, { columns: ['number', 'customer.name'], offset: 50 })
		assert.deepEqual(Object.keys(restored.propertySelect).sort(), ['/state/a', '/state/b'])
		assert.deepEqual(JSON.parse((await app.inject('/read')).body), {})
		for (const path of ['/slow', '/reload']) {
			// Each iteration starts a real new cookie generation.
			const seed = await app.inject('/seed')
			const ownCookie = seed.headers['set-cookie'].split(';')[0]
			loaded = deferred(); release = deferred()
			const pending = app.inject({ url: path, headers: { cookie: ownCookie } })
			const id = await loaded.promise
			await server.config.store.revoke(id)
			release.resolve()
			assert.equal((await pending).statusCode, 500)
			assert.equal((await server.config.store.list()).some(item => item.id === id), false)
		}
	}
	finally { await server.stop() }
})
